"""Durable cache and progress tests on synthetic files only."""
from contextlib import closing
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import queue
import threading
import time
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
BINARY = Path(os.environ.get('DUPROVE_ANALYZER', str(ROOT / 'build/native/bin' /
              ('duprove-analyzer.exe' if os.name == 'nt' else 'duprove-analyzer'))))

class ResumeTests(unittest.TestCase):
    def setUp(self):
        fixtures = ROOT / '.verification/native-fixtures'
        fixtures.mkdir(parents=True, exist_ok=True)
        temporary = tempfile.TemporaryDirectory(prefix='resume-', dir=fixtures)
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)
        self.data = self.base / 'data'
        self.data.mkdir()
        self.db = self.base / 'work/index.sqlite'
        self.job = self.base / 'job.json'
        self.job.write_text(json.dumps({'roots': [str(self.data)], 'database': str(self.db), 'load': 2}), encoding='utf-8')

    def run_scan(self):
        result = subprocess.run([str(BINARY), '--job', str(self.job)], input='', capture_output=True, encoding='utf-8', timeout=60)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        events = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertEqual(events[-1]['type'], 'result')
        for event in events:
            for disk in event.get('disks', []):
                self.assertEqual(sum(disk['types'].values()), disk['files'])
                self.assertTrue(disk['percent'] is None or 0 <= disk['percent'] <= 100)
                if disk['phase'] == 'waiting':
                    self.assertIsNone(disk['percent'])
                if 'work' in disk:
                    work = disk['work']
                    self.assertGreaterEqual(work['done'], 0)
                    if work['total'] is not None:
                        self.assertLessEqual(work['done'], work['total'])
                    self.assertGreaterEqual(work['read_bytes'], 0)
                    if 'cached_files' in work:
                        self.assertLessEqual(work['cached_files'], work['files_done'])
        return events[-1]

    def test_cache_is_reused_and_changed_deleted_added_files_are_revalidated(self):
        for name in ('a', 'b', 'c'):
            (self.data / name).write_bytes(b'same bytes')
        self.assertEqual(self.run_scan()['resources']['reused_hashes'], 0)
        second = self.run_scan()
        self.assertEqual(second['resources']['reused_hashes'], 3)
        self.assertGreater(second['resources']['read_bytes'], 0, 'Byte comparison must run again')
        old = (self.data / 'b').stat()
        (self.data / 'b').write_bytes(b'other data')
        os.utime(self.data / 'b', ns=(old.st_atime_ns, old.st_mtime_ns))
        (self.data / 'c').unlink()
        (self.data / 'd').write_bytes(b'same bytes')
        third = self.run_scan()
        self.assertEqual(third['resources']['reused_hashes'], 1)
        self.assertEqual(third['report']['statistics']['total']['duplicates'], 1)
        self.assertEqual(third['report']['statistics']['total']['files'], 3)

    def test_killed_process_retains_committed_hashes(self):
        job = json.loads(self.job.read_text(encoding='utf-8')); job['load'] = 0
        self.job.write_text(json.dumps(job), encoding='utf-8')
        for index in range(48):
            # Exceed a full checkpoint interval even with the faster low mode.
            (self.data / f'{index:03}').write_bytes(b'x' * (4 * 1024 * 1024))
        process = subprocess.Popen([str(BINARY), '--job', str(self.job)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8')
        try:
            interrupted = False
            for line in process.stdout:
                event = json.loads(line)
                if event['type'] == 'progress':
                    disk = event['disks'][0]
                    if disk['phase'] == 'hashing' and disk['percent'] >= 50 and disk['work'].get('files_done', 0) > 0:
                        process.kill()
                        interrupted = True
                        break
            _, stderr = process.communicate(timeout=10)
            self.assertTrue(interrupted, f'Analyzer finished before interruption: {process.returncode}, {stderr}')
        finally:
            if process.poll() is None:
                process.kill(); process.communicate()
        # Inspect durable data after the writer is gone. A competing SQLite reader
        # can otherwise interfere with the very commit this crash test measures.
        with closing(sqlite3.connect(self.db)) as db:
            committed = db.execute("SELECT count(*) FROM files WHERE hash<>''").fetchone()[0]
        self.assertGreater(committed, 0)
        # Low mode makes the interruption/checkpoint observable. Resume in high
        # mode so this durability assertion does not time the low-mode CPU/read
        # budget on shared CI hosts; the 60 s completion bound stays unchanged.
        job['load'] = 2
        self.job.write_text(json.dumps(job), encoding='utf-8')
        result = self.run_scan()
        self.assertGreaterEqual(result['resources']['reused_hashes'], committed)
        self.assertEqual(result['report']['statistics']['total']['duplicates'], 47)

    def test_cache_skips_reading_unique_hashes_but_still_validates_changed_files(self):
        for i in range(40):
            (self.data / f'{i}.bin').write_bytes(i.to_bytes(4, 'little') + b'x' * 1020)
        first = self.run_scan()
        self.assertEqual(first['resources']['read_bytes'], 40 * 1024)
        second = self.run_scan()
        self.assertEqual(second['resources']['reused_hashes'], 40)
        self.assertEqual(second['resources']['read_bytes'], 0)
        old = (self.data / '0.bin').stat()
        (self.data / '0.bin').write_bytes((self.data / '1.bin').read_bytes())
        os.utime(self.data / '0.bin', ns=(old.st_atime_ns, old.st_mtime_ns))
        third = self.run_scan()
        self.assertEqual(third['resources']['reused_hashes'], 39)
        self.assertEqual(third['report']['statistics']['total']['duplicates'], 1)

    def test_high_mode_pause_stop_and_retry(self):
        # Enough work to pause after the hashing phase begins, even on fast SSDs.
        payload = b'x' * (16 * 1024 * 1024 - 8)
        for index in range(48):
            (self.data / f'{index:03}.bin').write_bytes(index.to_bytes(8, 'little') + payload)
        process = subprocess.Popen([str(BINARY), '--job', str(self.job)], stdin=subprocess.PIPE,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8')
        events = queue.Queue()
        def read_events():
            try:
                for line in process.stdout:
                    events.put(json.loads(line))
            finally:
                events.put(None)
        reader = threading.Thread(target=read_events, daemon=True)
        reader.start()
        def command(action):
            process.stdin.write(json.dumps({'action': action}) + '\n'); process.stdin.flush()
        def next_event():
            event = events.get(timeout=15)
            self.assertIsNotNone(event, 'Analyzer ended before expected progress')
            return event
        try:
            while True:
                event = next_event()
                if event['type'] == 'progress' and event['disks'][0]['phase'] == 'hashing':
                    command('pause')
                    break
            paused_at = time.monotonic()
            snapshots = []
            while time.monotonic() - paused_at < 1.2:
                event = next_event()
                self.assertEqual(event['type'], 'progress')
                disk = event['disks'][0]
                self.assertEqual(disk['phase'], 'hashing')
                if time.monotonic() - paused_at > .5:
                    snapshots.append(disk['work']['read_bytes'])
            self.assertGreaterEqual(len(snapshots), 2)
            self.assertEqual(min(snapshots), max(snapshots), 'Reads continued while paused')
            command('stop')
            while True:
                event = next_event()
                if event['type'] == 'result':
                    self.assertFalse(event['report']['complete'])
                    self.assertEqual(event['disks'][0]['phase'], 'stopped')
                    self.assertEqual(event['disks'][0]['errors'], 0)
                    self.assertGreaterEqual(event['resources']['hash_workers'], 1)
                    break
            process.stdin.close()
            self.assertEqual(process.wait(timeout=10), 0)
        finally:
            if process.poll() is None:
                process.kill()
            process.wait(timeout=10)
            reader.join(timeout=5)
            process.stdin.close(); process.stdout.close(); process.stderr.close()
        completed = self.run_scan()
        self.assertTrue(completed['report']['complete'])
        self.assertEqual(completed['report']['statistics']['total']['duplicates'], 0)
        repeated = self.run_scan()
        self.assertEqual(repeated['resources']['reused_hashes'], 48)
        self.assertEqual(repeated['resources']['read_bytes'], 0)

    def test_live_work_advances_during_inventory_and_inside_large_files(self):
        for index in range(160):
            folder = self.data / f'folder-{index}'
            folder.mkdir()
            for item in range(8):
                (folder / f'item-{item}.txt').write_text(f'{index}:{item}', encoding='utf-8')
        for name in ('large-a.bin', 'large-b.bin'):
            # At 64 MiB/s, 8 MiB can finish between telemetry ticks. Keep each
            # fixture longer than two 250 ms ticks without weakening the check.
            (self.data / name).write_bytes(b'x' * (32 * 1024 * 1024))
        job = json.loads(self.job.read_text(encoding='utf-8')); job['load'] = 0
        self.job.write_text(json.dumps(job), encoding='utf-8')
        process = subprocess.run([str(BINARY), '--job', str(self.job)], input='', capture_output=True, encoding='utf-8', timeout=90)
        self.assertEqual(process.returncode, 0, process.stdout + process.stderr)
        events = [json.loads(line) for line in process.stdout.splitlines()]
        disks = [e['disks'][0] for e in events if e['type'] == 'progress']
        inventory = [d for d in disks if d['phase'] == 'discovering' and d['percent'] > 0]
        # A complete small inventory may fit between 250 ms telemetry ticks.
        # safe-traversal deterministically requires intermediate directory work;
        # here validate every emitted sample and the longer, rate-limited hashes.
        for disk in inventory:
            self.assertEqual(disk['work']['unit'], 'directories')
            self.assertLess(disk['percent'], 100)
            self.assertLessEqual(disk['work']['done'], disk['work']['total'])
        large = [d['work'] for d in disks if d['phase'] == 'hashing' and 'large-' in d['work']['current']]
        self.assertGreater(len(large), 1, 'A large file must publish chunk progress')
        self.assertGreater(large[-1]['done'], large[0]['done'])
        self.assertGreater(large[-1]['read_bytes'], large[0]['read_bytes'])
        self.assertTrue(any(w['files_done'] < w['files_total'] for w in large))
        self.assertTrue(events[-1]['report']['complete'])

if __name__ == '__main__':
    unittest.main()
