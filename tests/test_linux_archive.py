"""Smoke-test the actual packaged tar.gz in a temporary user profile."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(sys.platform.startswith('linux') and os.geteuid() != 0, 'Linux non-root archive test')
class ArchiveTests(unittest.TestCase):
    def test_archive_installs_with_notice_and_bundled_analyzer_runs(self):
        archives = list((ROOT / 'release').glob('Duprove-*-linux-*.tar.gz'))
        self.assertEqual(len(archives), 1, 'Use a clean release directory for this architecture')
        with tempfile.TemporaryDirectory(prefix='duprove-archive-') as temporary:
            base = Path(temporary)
            unpacked = base / 'unpacked'
            with tarfile.open(archives[0]) as archive:
                archive.extractall(unpacked, filter='data')
            installers = list(unpacked.rglob('install.sh'))
            self.assertEqual(len(installers), 1)
            home = base / 'user home'
            home.mkdir()
            env = {**os.environ, 'HOME': str(home), 'XDG_DATA_HOME': str(home / '.local/share')}
            result = subprocess.run(['bash', str(installers[0]), '--non-interactive'], env=env,
                                    capture_output=True, text=True, timeout=120)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('По умолчанию отправка включена', result.stdout)
            analyzer = home / '.local/share/duprove/resources/analyzer/duprove-analyzer'
            listed = subprocess.run([str(analyzer), '--drives'], capture_output=True, text=True, timeout=20, check=True)
            self.assertIn('/', [drive['path'] for drive in json.loads(listed.stdout)])
            self.assertTrue((home / '.local/bin/duprove').is_file())
            self.assertTrue((home / '.local/share/applications/duprove.desktop').is_file())
            self.assertFalse((home / '.config/Duprove/statistics-consent.json').exists(), 'Installer must not change statistics preferences')
            print('LINUX_ARCHIVE_OK: notice, user installation, launcher and bundled analyzer')


if __name__ == '__main__':
    unittest.main()
