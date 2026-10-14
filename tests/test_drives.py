"""Read-only host integration. Enumerates mounts; never scans user files."""
import ctypes
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
BINARY = Path(os.environ.get('DUPROVE_ANALYZER', str(ROOT / 'build/native/bin' / ('duprove-analyzer.exe' if os.name == 'nt' else 'duprove-analyzer'))))


class DriveTests(unittest.TestCase):
    def test_mounted_volumes_are_real_unique_and_have_usable_sizes(self):
        result = subprocess.run([str(BINARY), '--drives'], capture_output=True, text=True, encoding='utf8', timeout=20, check=True)
        drives = json.loads(result.stdout)
        self.assertIsInstance(drives, list)
        self.assertTrue(drives)
        paths = [drive['path'] for drive in drives]
        self.assertEqual(len(paths), len(set(paths)))
        for drive in drives:
            self.assertEqual(set(drive), {'path', 'name', 'capacity', 'available'})
            self.assertTrue(Path(drive['path']).is_dir())
            self.assertIsInstance(drive['capacity'], int)
            self.assertGreater(drive['capacity'], 0)
            self.assertGreaterEqual(drive['available'], 0)
            self.assertLessEqual(drive['available'], drive['capacity'])
        if sys.platform.startswith('linux'):
            self.assertIn('/', paths)
            def decode(value):
                import re
                return re.sub(r'\\(040|011|012|134)', lambda match: chr(int(match[1], 8)), value)
            mounts = {decode(line.split()[4]) for line in Path('/proc/self/mountinfo').read_text().splitlines()}
            self.assertTrue(set(paths) <= mounts, 'Only kernel mount points are drives')
            self.assertNotIn('/proc', paths)
            self.assertNotIn('/sys', paths)
        elif sys.platform == 'darwin':
            self.assertIn('/', paths)
            libc = ctypes.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True)
            libc.getfsstat.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int]
            count = libc.getfsstat(None, 0, 2)  # MNT_NOWAIT
            self.assertGreater(count, 0)
            self.assertLessEqual(len(paths), count)
            for path in paths:
                self.assertFalse(path.startswith('/System/'))
                self.assertTrue(os.path.ismount(path), 'Ordinary /Volumes directories must not be listed')
        # Do not print local names or paths in logs.
        print(f'DRIVE_DISCOVERY_OK: {sys.platform}, {len(paths)} mounted volumes')


if __name__ == '__main__':
    unittest.main()
