"""Inspect an actual PKG and run its analyzer without installing into /Applications."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(sys.platform == 'darwin', 'Requires macOS pkgutil and Mach-O runtime')
class MacPackageTests(unittest.TestCase):
    def test_pkg_contains_visible_notice_and_native_analyzer(self):
        packages = list((ROOT / 'release').glob('Duprove-*-mac-*.pkg'))
        self.assertEqual(len(packages), 1)
        with tempfile.TemporaryDirectory(prefix='duprove-pkg-') as temporary:
            expanded = Path(temporary) / 'expanded'
            subprocess.run(['pkgutil', '--expand-full', str(packages[0]), str(expanded)], check=True, timeout=120)
            distribution = ET.parse(expanded / 'Distribution').getroot()
            self.assertIsNotNone(distribution.find('welcome'), 'Installer must show the notice on Introduction')
            notices = list(expanded.rglob('macos-welcome.html'))
            self.assertTrue(notices)
            self.assertIn('По умолчанию отправка включена', notices[0].read_text())
            binaries = list(expanded.rglob('duprove-analyzer'))
            self.assertEqual(len(binaries), 1)
            result = subprocess.run([str(binaries[0]), '--drives'], check=True, capture_output=True, text=True, timeout=20)
            self.assertIn('/', [drive['path'] for drive in json.loads(result.stdout)])
            print('MACOS_PKG_OK: Introduction notice and bundled native analyzer')


if __name__ == '__main__':
    unittest.main()
