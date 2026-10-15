"""Stage 3 integration: only temporary synthetic directories are scanned."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
BINARY = Path(os.environ.get('DUPROVE_ANALYZER', str(ROOT / 'build/native/bin' / ('duprove-analyzer.exe' if os.name == 'nt' else 'duprove-analyzer'))))


class TraversalTests(unittest.TestCase):
    def setUp(self):
        fixtures = ROOT / '.verification/native-fixtures'
        fixtures.mkdir(parents=True, exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(prefix='duprove-traversal-', dir=fixtures if sys.platform == 'darwin' else None)
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.root = self.base / 'selected'
        self.root.mkdir()

    def scan(self, roots=None, environment=None):
        job = self.base / 'задание.json'
        job.write_text(json.dumps({'roots': list(map(str, roots or [self.root])),
                                   'database': str(self.base / 'work/index.sqlite'), 'load': 2}), encoding='utf-8')
        result = subprocess.run([str(BINARY), '--job', str(job)], input='', capture_output=True,
                                text=True, encoding='utf-8', timeout=30, env=environment)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return json.loads(result.stdout.splitlines()[-1])

    @unittest.skipUnless(os.name == 'nt', 'Windows extended-length paths')
    def test_long_paths_are_discovered_and_compared(self):
        nested = self.root
        for index in range(4):
            nested /= f'level-{index}-' + 'x' * 70
        nested.mkdir(parents=True)
        original = nested / 'first.txt'
        copy = nested / 'second.txt'
        self.assertGreater(len(str(original)), 300)
        original.write_bytes(b'long path duplicate')
        copy.write_bytes(b'long path duplicate')
        event = self.scan()
        self.assertTrue(event['report']['complete'])
        self.assertEqual(event['disks'][0]['errors'], 0)
        self.assertEqual(event['report']['statistics']['total']['files'], 2)
        self.assertEqual(event['report']['statistics']['total']['duplicates'], 1)

    def test_extensions_are_not_collapsed_into_other(self):
        extensions = ['.my_format', '.long-' + 'x' * 30, '.данные', '.c++', '.tar.gz']
        for ext in extensions:
            (self.root / ('private-name' + ext)).write_bytes(b'copy')
        event = self.scan()
        self.assertTrue(event['report']['complete'])
        self.assertEqual(event['disks'][0]['types'], {ext: 1 for ext in extensions})
        self.assertEqual(event['report']['duplicates'][0]['extensions'], {ext: 1 for ext in extensions})

    def test_pytest_cache_is_excluded_but_similar_names_and_environments_are_scanned(self):
        cache = self.root / 'project' / '.pytest_cache'
        cache.mkdir(parents=True)
        (cache / 'cached').write_bytes(b'same')
        for name in ('.pytest_cache-copy', '.venv', 'node_modules'):
            folder = self.root / name
            folder.mkdir()
            (folder / 'file').write_bytes(b'same')
        (self.root / 'visible').write_bytes(b'same')
        # POSIX proves exclusion occurs before trying to open an unreadable cache.
        if os.name != 'nt':
            cache.chmod(0)
        try:
            event = self.scan()
            self.assertTrue(event['report']['complete'])
            self.assertEqual(event['disks'][0]['errors'], 0)
            self.assertEqual(event['report']['statistics']['total']['files'], 4)
            self.assertEqual(event['report']['statistics']['total']['duplicates'], 3)
        finally:
            if os.name != 'nt':
                cache.chmod(0o700)
        # A previously counted file moved into a cache must leave the reused index.
        (self.root / '.pytest_cache-copy').rename(self.root / '.pytest_cache')
        repeated = self.scan()
        self.assertTrue(repeated['report']['complete'])
        self.assertEqual(repeated['report']['statistics']['total']['files'], 3)
        self.assertEqual(repeated['report']['statistics']['total']['duplicates'], 2)
        import sqlite3
        from contextlib import closing
        with closing(sqlite3.connect(self.base / 'work/index.sqlite')) as db:
            self.assertFalse(any('.pytest_cache/' in p.replace('\\', '/') for (p,) in db.execute('SELECT path FROM files')))

    def test_selection_hardlinks_and_read_only(self):
        nested = self.root / 'вложенный'
        nested.mkdir()
        outside = self.base / 'unselected'
        outside.mkdir()
        original = self.root / 'a.TXT'
        original.write_bytes(b'same bytes')
        copy = nested / 'b.bin'
        copy.write_bytes(b'same bytes')
        (outside / 'third').write_bytes(b'same bytes')
        (self.root / 'empty').touch()
        os.link(original, nested / 'hardlink')
        before = {p: (p.read_bytes(), p.stat().st_mtime_ns) for p in [original, copy]}
        event = self.scan([self.root, nested])
        report = event['report']
        self.assertTrue(report['complete'])
        total = report['statistics']['total']
        self.assertEqual((total['files'], total['empty'], total['duplicates']), (3, 1, 1))
        self.assertEqual(report['duplicates'][0]['disks'], {'0': 1, '1': 1})
        self.assertEqual(report['duplicates'][0]['extensions'], {'.bin': 1, '.txt': 1})
        for path, previous in before.items():
            self.assertEqual((path.read_bytes(), path.stat().st_mtime_ns), previous)
        self.assertNotIn(str(self.base), json.dumps(report))

    def test_reusing_database_does_not_reuse_stale_hashes(self):
        first, second = self.root / 'a', self.root / 'b'
        first.write_bytes(b'same')
        second.write_bytes(b'same')
        self.assertEqual(self.scan()['report']['statistics']['total']['duplicates'], 1)
        stamp = second.stat().st_mtime_ns
        second.write_bytes(b'diff')
        os.utime(second, ns=(stamp, stamp))
        self.assertEqual(self.scan()['report']['statistics']['total']['duplicates'], 0)
        first.rename(self.root / 'renamed')
        self.assertEqual(self.scan()['report']['statistics']['total']['files'], 2)

    def test_large_duplicate_group_crosses_transaction_batches(self):
        # Crosses the hash/comparison checkpoint; all members must stay in one group.
        for index in range(270):
            (self.root / f'{index}.bin').write_bytes(b'one duplicate group')
        event = self.scan()
        report = event['report']
        self.assertTrue(report['complete'])
        self.assertEqual(report['statistics']['total']['files'], 270)
        self.assertEqual(report['statistics']['total']['duplicates'], 269)
        self.assertEqual(len(report['duplicates']), 1)
        self.assertEqual(report['duplicates'][0]['copies'], 270)

    def test_missing_root_is_an_error_not_an_empty_success(self):
        (self.root / 'file').write_bytes(b'data')
        event = self.scan([self.base / 'missing', self.root])
        self.assertFalse(event['report']['complete'])
        self.assertEqual(event['disks'][0]['phase'], 'error')
        self.assertGreater(event['disks'][0]['errors'], 0)
        self.assertEqual(event['report']['statistics']['total']['files'], 1)
        self.assertEqual(event['disks'][0]['issues'][0]['code'], 'root_unavailable')
        self.assertEqual(event['disks'][0]['issues'][0]['examples'], [])
        self.assertNotIn('issues', event['report'])

    @unittest.skipUnless(os.name == 'nt', 'Windows sharing rules')
    def test_windows_locked_file_is_reported(self):
        import ctypes
        from ctypes import wintypes
        locked = self.root / 'locked'
        locked.write_bytes(b'locked bytes')
        (self.root / 'visible').write_bytes(b'locked bytes')
        api = ctypes.WinDLL('kernel32', use_last_error=True)
        api.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p,
                                   wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
        api.CreateFileW.restype = wintypes.HANDLE
        api.CloseHandle.argtypes = [wintypes.HANDLE]
        handle = api.CreateFileW(str(locked), 0x80000000, 0, None, 3, 0x80, None)
        self.assertNotEqual(handle, ctypes.c_void_p(-1).value)
        try:
            event = self.scan()
        finally:
            api.CloseHandle(handle)
        self.assertFalse(event['report']['complete'])
        self.assertGreater(event['disks'][0]['errors'], 0)
        self.assertEqual(event['report']['statistics']['total']['duplicates'], 0)
        self.assertEqual(event['disks'][0]['issues'][0]['code'], 'file_unavailable_or_changed')
        self.assertEqual(event['disks'][0]['issues'][0]['operation'], 'hashing')
        self.assertEqual(event['disks'][0]['issues'][0]['examples'], [])

    def test_directory_links_and_cycles(self):
        outside = self.base / 'unselected'
        outside.mkdir()
        (outside / 'secret').write_bytes(b'not selected')
        link = self.root / 'link'
        cycle = self.root / 'cycle'
        if os.name == 'nt':
            # Junction creation does not require Windows symlink privileges.
            for target, dest in [(outside, link), (self.root, cycle)]:
                completed = subprocess.run(['powershell', '-NoProfile', '-Command',
                    'New-Item -ItemType Junction -Path $env:DUPROVE_TEST_LINK -Target $env:DUPROVE_TEST_TARGET -ErrorAction Stop | Out-Null'],
                    capture_output=True, text=True, env=dict(os.environ, DUPROVE_TEST_LINK=str(dest), DUPROVE_TEST_TARGET=str(target)))
                self.assertEqual(completed.returncode, 0, 'junction fixture creation failed')
        else:
            link.symlink_to(outside, target_is_directory=True)
            cycle.symlink_to(self.root, target_is_directory=True)
            (self.root / 'file-link').symlink_to(outside / 'secret')
            os.mkfifo(self.root / 'pipe')
        self.assertEqual(self.scan()['report']['statistics']['total']['files'], 0)
        event = self.scan([link])
        self.assertFalse(event['report']['complete'])

    @unittest.skipUnless(sys.platform.startswith('linux'), 'XDG applies to Linux')
    def test_xdg_relocation_and_disabled_folder(self):
        config = self.base / 'settings'
        config.mkdir()
        documents = self.root / 'Перенесённые документы'
        documents.mkdir()
        (documents / 'file').write_bytes(b'hello')
        (self.root / 'other').write_bytes(b'unclassified')
        (config / 'user-dirs.dirs').write_text(
            f'XDG_DOCUMENTS_DIR="{documents}"\nXDG_DOWNLOAD_DIR="$HOME/"\n', encoding='utf-8')
        env = dict(os.environ, HOME=str(self.root), XDG_CONFIG_HOME=str(config))
        report = self.scan(environment=env)['report']
        locations = report['statistics']['locations']
        self.assertEqual(locations['standard']['categories']['documents']['files'], 1)
        self.assertEqual(locations['standard']['categories']['downloads']['files'], 0)
        self.assertEqual(locations['custom']['files'], 1)

    @unittest.skipIf(os.name == 'nt', 'POSIX permission fixture')
    def test_access_denied_does_not_abort_other_directories(self):
        if os.geteuid() == 0:
            self.skipTest('Must run without root privileges')
        denied = self.root / 'denied'
        denied.mkdir()
        (denied / 'secret').write_bytes(b'hidden')
        (self.root / 'visible').write_bytes(b'visible')
        denied.chmod(0)
        try:
            event = self.scan()
        finally:
            denied.chmod(0o700)
        self.assertFalse(event['report']['complete'])
        self.assertGreater(event['disks'][0]['errors'], 0)
        self.assertEqual(event['report']['statistics']['total']['files'], 1)

    @unittest.skipIf(os.name == 'nt', 'POSIX permission fixture')
    def test_unreadable_candidate_does_not_confirm_duplicates(self):
        if os.geteuid() == 0:
            self.skipTest('Must run without root privileges')
        denied = self.root / 'denied'
        denied.write_bytes(b'same')
        (self.root / 'visible').write_bytes(b'same')
        denied.chmod(0)
        try:
            event = self.scan()
        finally:
            denied.chmod(0o600)
        self.assertFalse(event['report']['complete'])
        self.assertEqual(event['report']['statistics']['total']['duplicates'], 0)


if __name__ == '__main__':
    unittest.main()
