"""Run the real Linux transaction helper against synthetic app versions, without sudo."""
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(sys.platform.startswith('linux') and os.geteuid() != 0, 'Linux non-root transaction test')
class UpdateTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='duprove-update-')
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.target = self.base / 'app with spaces $ and %'
        self.target.mkdir()
        self.directory = self.base / 'profile' / 'updates'
        self.source = self.directory / 'stage' / 'Duprove new'
        (self.source / 'resources').mkdir(parents=True)
        self.token = 'a' * 48
        (self.target / '.duprove-managed').write_text('Duprove managed installation v1\n')
        (self.target / 'version').write_text('old')
        self.program(self.target / 'duprove', 'printf old > ' + shlex.quote(str(self.base / 'restarted')))
        (self.source / 'resources/app.asar').write_text('synthetic')
        (self.source / '.duprove-managed').write_text('Duprove managed installation v1\n')
        (self.source / 'version').write_text('new')
        self.profile = self.directory.parent / 'statistics-consent.json'
        self.profile.write_text('{"decision":"declined"}')
        self.report = self.directory.parent / 'report.json'
        self.report.write_text('unchanged-report')

    @staticmethod
    def program(file, commands):
        file.write_text('#!/bin/bash\nset -e\n' + commands + '\n')
        file.chmod(0o755)

    def run_helper(self, parent):
        child = subprocess.Popen(['bash', str(ROOT / 'installer/update-linux.sh'), str(self.directory),
                                  str(parent), str(self.target), str(self.source), self.token],
                                 stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
        self.addCleanup(lambda: child.poll() is not None or child.kill())
        return child

    def assert_profile(self):
        self.assertEqual(self.profile.read_text(), '{"decision":"declined"}')
        self.assertEqual(self.report.read_text(), 'unchanged-report')

    def test_waits_for_parent_then_replaces_and_preserves_profile(self):
        self.program(self.source / 'duprove', 'printf %s ' + self.token + ' > ' + shlex.quote(str(self.directory / 'ready')))
        parent = subprocess.Popen(['sleep', '30'])
        self.addCleanup(lambda: parent.poll() is not None or parent.kill())
        helper = self.run_helper(parent.pid)
        until = time.monotonic() + 5
        while not (self.directory / 'armed').exists() and time.monotonic() < until:
            time.sleep(.02)
        self.assertTrue((self.directory / 'armed').exists())
        self.assertEqual((self.target / 'version').read_text(), 'old', 'active app must remain untouched')
        self.assert_profile()
        parent.terminate()
        parent.wait()
        _, errors = helper.communicate(timeout=10)
        self.assertEqual(helper.returncode, 0, errors)
        self.assertEqual((self.target / 'version').read_text(), 'new')
        self.assertIn('installed', (self.directory / 'result.json').read_text())
        self.assertFalse(Path(str(self.target) + '.previous').exists())
        self.assert_profile()

    def test_failed_new_app_restores_and_restarts_old_version(self):
        self.program(self.source / 'duprove', 'exit 7')
        helper = self.run_helper(99999999)
        _, errors = helper.communicate(timeout=10)
        self.assertNotEqual(helper.returncode, 0, errors)
        self.assertEqual((self.target / 'version').read_text(), 'old')
        self.assertIn('rolled-back', (self.directory / 'result.json').read_text())
        until = time.monotonic() + 3
        while not (self.base / 'restarted').exists() and time.monotonic() < until:
            time.sleep(.02)
        self.assertEqual((self.base / 'restarted').read_text(), 'old')
        self.assert_profile()

    def test_foreign_target_is_not_changed(self):
        self.program(self.source / 'duprove', 'exit 0')
        (self.target / '.duprove-managed').write_text('foreign')
        helper = self.run_helper(99999999)
        helper.communicate(timeout=5)
        self.assertNotEqual(helper.returncode, 0)
        self.assertEqual((self.target / 'version').read_text(), 'old')
        self.assertFalse((self.directory / 'armed').exists())


if __name__ == '__main__':
    unittest.main()
