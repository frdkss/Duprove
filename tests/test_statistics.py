"""Real scanner output on artificial files; no user files are scanned."""
import hashlib
from contextlib import closing
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend'))
from duprove_backend.contract import is_report

BINARY = Path(os.environ.get('DUPROVE_ANALYZER', str(ROOT / 'build/native/bin' /
                  ('duprove-analyzer.exe' if os.name == 'nt' else 'duprove-analyzer'))))
CATEGORIES = ('downloads', 'documents', 'videos', 'pictures', 'music', 'desktop')


class StatisticsTests(unittest.TestCase):
    def test_real_files_report_and_private_work_file(self):
        workspace = ROOT / '.verification/statistics'
        workspace.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='PRIVATE_', dir=workspace) as temporary:
            base = Path(temporary)
            roots = [base / 'disk-a', base / 'disk-b']
            categories = (*CATEGORIES, 'custom')
            payload = b'PRIVATE_CONTENT_identical_across_categories'
            files = {}
            folders = {}
            for i, category in enumerate(categories):
                folder = roots[i % 2] / ('PRIVATE_' + category)
                folder.mkdir(parents=True)
                folders[category] = folder
                # Different extensions do not split one exact group.
                files[folder / ('PRIVATE_COPY.TXT' if i % 2 == 0 else 'PRIVATE_COPY.bin')] = payload
                files[folder / 'PRIVATE_EMPTY.txt'] = b''
            files[folders['custom'] / 'PRIVATE_UNIQUE'] = b'PRIVATE_unique_content'
            for file, data in files.items():
                file.write_bytes(data)
            before = {file: (data, file.stat().st_mtime_ns) for file, data in files.items()}
            config = base / 'config'
            config.mkdir()
            xdg_names = ('DOWNLOAD', 'DOCUMENTS', 'VIDEOS', 'PICTURES', 'MUSIC', 'DESKTOP')
            (config / 'user-dirs.dirs').write_text(''.join(
                f'XDG_{name}_DIR="{folders[category].as_posix()}"\n'
                for name, category in zip(xdg_names, CATEGORIES)), encoding='utf-8')
            job = base / 'job.json'
            database = base / 'work/index.sqlite'
            job.write_text(json.dumps(dict(roots=list(map(str, roots)), database=str(database), load=2)), encoding='utf-8')
            process = subprocess.run([str(BINARY), '--job', str(job)], input='', text=True, encoding='utf-8',
                                     capture_output=True, timeout=30, env={**os.environ, 'XDG_CONFIG_HOME': str(config)})
            self.assertEqual(process.returncode, 0)
            self.assertEqual(process.stderr, '')
            event = json.loads(process.stdout.splitlines()[-1])
            report = event['report']
            self.assertTrue(is_report(report))
            self.assertTrue(report['complete'])
            self.assertEqual(report['statistics']['total'], dict(files=15, empty=7, duplicate_members=7,
                             duplicate_groups=1, duplicates=6, types={'.txt': 4, '.bin': 3, 'empty': 7, 'none': 1},
                             file_bytes=sum(map(len, files.values())), duplicate_bytes=7 * len(payload),
                             reclaimable_bytes=6 * len(payload)))
            group, = report['duplicates']
            self.assertEqual(group['extensions'], {'.txt': 4, '.bin': 3})
            self.assertEqual(group['disks'], {'0': 4, '1': 3})
            self.assertEqual((group['copies'], group['duplicates']), (7, 6))
            # Linux uses an isolated XDG fixture; Windows/macOS resolve actual OS folders.
            # The native anonymous-statistics test covers all categories on every OS.
            if sys.platform.startswith('linux'):
                self.assertEqual(group['categories'], {category: 1 for category in categories})
                locations = report['statistics']['locations']
                self.assertEqual(locations['standard']['total']['files'], 12)
                self.assertEqual(locations['standard']['total']['duplicate_groups'], 1)
                self.assertEqual(locations['standard']['total']['duplicate_members'], 6)
                self.assertEqual(locations['custom']['files'], 3)
                for category in CATEGORIES:
                    summary = locations['standard']['categories'][category]
                    self.assertEqual((summary['files'], summary['empty'], summary['duplicate_members'],
                                      summary['duplicate_groups']), (2, 1, 1, 1))
            text = json.dumps(report)
            for private in ('PRIVATE_', payload.decode(), hashlib.sha256(payload).hexdigest(), str(base)):
                self.assertNotIn(private, text)
            self.assertTrue(database.is_file())
            import sqlite3
            with closing(sqlite3.connect(database)) as connection:
                self.assertEqual(connection.execute('SELECT count(*) FROM files').fetchone()[0], 15)
                self.assertEqual(connection.execute('SELECT count(*) FROM files WHERE hash=?',
                                                   (hashlib.sha256(payload).hexdigest(),)).fetchone()[0], 7)
            for file, (data, mtime) in before.items():
                self.assertEqual(file.read_bytes(), data)
                self.assertEqual(file.stat().st_mtime_ns, mtime)
            check = "const {isReport}=require('./.verification/tests/contracts/validate.js');let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>process.exit(isReport(JSON.parse(s))?0:1))"
            validated = subprocess.run([os.environ.get('DUPROVE_NODE', 'node'), '-e', check], input=text,
                                       text=True, cwd=ROOT, timeout=15)
            self.assertEqual(validated.returncode, 0)

    def test_error_does_not_echo_private_input(self):
        workspace = ROOT / '.verification/statistics'
        workspace.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=workspace) as temporary:
            job = Path(temporary) / 'PRIVATE_JOB.json'
            job.write_text('{"PRIVATE_CONTENT":', encoding='utf-8')
            process = subprocess.run([str(BINARY), '--job', str(job)], input='', capture_output=True,
                                     text=True, encoding='utf-8', timeout=15)
            self.assertNotEqual(process.returncode, 0)
            self.assertEqual(json.loads(process.stdout)['type'], 'error')
            self.assertNotIn('PRIVATE_', process.stdout + process.stderr)
            self.assertNotIn(temporary, process.stdout + process.stderr)


if __name__ == '__main__':
    unittest.main()
