import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(sys.platform.startswith('linux') and os.geteuid() != 0, 'Linux non-root installer test')
class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='duprove-installer-')
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.home = self.base / 'home with spaces $ and %'
        self.home.mkdir()
        self.source = self.base / 'archive with spaces'
        self.source.mkdir()
        shutil.copyfile(ROOT / 'installer/linux/install.sh', self.source / 'install.sh')
        self.resources = self.source / 'resources'
        (self.resources / 'analyzer').mkdir(parents=True)
        shutil.copyfile(ROOT / 'docs/statistics-notice.txt', self.resources / 'statistics-notice.txt')
        # A synthetic app verifies argument forwarding without launching Electron.
        for file in [self.source / 'duprove', self.resources / 'analyzer/duprove-analyzer']:
            file.write_text('#!/bin/sh\nprintf "%s\\n" "$@"\n')
            file.chmod(0o755)
        self.env = {**os.environ, 'HOME': str(self.home), 'XDG_DATA_HOME': str(self.home / 'custom data')}
        self.target = self.home / 'custom data/duprove'
        self.launcher = self.home / '.local/bin/duprove'

    def run_installer(self, *args):
        return subprocess.run(['bash', str(self.source / 'install.sh'), *args], env=self.env,
                              input='', capture_output=True, text=True, timeout=30)

    def test_notice_precedes_install_and_upgrade_preserves_profile(self):
        profile = self.home / '.config/Duprove/statistics-consent.json'
        profile.parent.mkdir(parents=True)
        original = json.dumps({'decision': 'declined'})
        profile.write_text(original)
        result = self.run_installer('--non-interactive')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertLess(result.stdout.index('По умолчанию отправка включена'), result.stdout.index('Duprove установлен:'))
        self.assertTrue((self.target / '.duprove-managed').exists())
        launched = subprocess.run([str(self.launcher), 'space argument', 'literal$`%'], capture_output=True, text=True, check=True)
        self.assertEqual(launched.stdout.splitlines(), ['space argument', 'literal$`%'])
        desktop = self.home / 'custom data/applications/duprove.desktop'
        self.assertIn('%%', desktop.read_text())
        self.assertIn('\\\\$', desktop.read_text())
        (self.target / 'obsolete-file').write_text('old')
        self.assertEqual(self.run_installer('--non-interactive').returncode, 0)
        self.assertFalse((self.target / 'obsolete-file').exists())
        self.assertEqual(profile.read_text(), original)
        self.assertFalse(list(self.target.parent.glob('.duprove-stage.*')))
        self.assertFalse(list(self.target.parent.glob('.duprove-backup.*')))

    def test_no_terminal_requires_explicit_noninteractive_mode_before_writing(self):
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('школьного проекта', result.stdout)
        self.assertFalse(self.target.exists())
        self.assertFalse(self.launcher.exists())

    def test_foreign_directory_or_launcher_is_not_overwritten(self):
        self.target.mkdir(parents=True)
        sentinel = self.target / 'personal-file'
        sentinel.write_text('preserve')
        self.assertNotEqual(self.run_installer('--non-interactive').returncode, 0)
        self.assertEqual(sentinel.read_text(), 'preserve')
        sentinel.unlink()
        self.target.rmdir()
        self.launcher.parent.mkdir(parents=True, exist_ok=True)
        self.launcher.write_text('unrelated executable')
        self.assertNotEqual(self.run_installer('--non-interactive').returncode, 0)
        self.assertEqual(self.launcher.read_text(), 'unrelated executable')
        self.assertFalse(self.target.exists())

    def test_symlink_destination_is_not_followed(self):
        unrelated = self.base / 'unrelated'
        unrelated.mkdir()
        self.target.parent.mkdir(parents=True)
        self.target.symlink_to(unrelated, target_is_directory=True)
        self.assertNotEqual(self.run_installer('--non-interactive').returncode, 0)
        self.assertEqual(list(unrelated.iterdir()), [])


if __name__ == '__main__':
    unittest.main()
