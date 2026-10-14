"""Inspect actual PKG/DMG contents without installing into /Applications."""
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(sys.platform == 'darwin', 'Requires macOS pkgutil and Mach-O runtime')
class MacPackageTests(unittest.TestCase):
    def test_dmg_contains_app_install_link_notice_and_native_analyzer(self):
        arch = 'arm64' if platform.machine() == 'arm64' else 'x64'
        images = list((ROOT / 'release').glob(f'Duprove-*-mac-{arch}.dmg'))
        self.assertEqual(len(images), 1)
        with tempfile.TemporaryDirectory(prefix='duprove-dmg-') as temporary:
            mount = Path(temporary) / 'volume'
            mount.mkdir()
            try:
                subprocess.run(['hdiutil', 'attach', '-nobrowse', '-readonly', '-mountpoint',
                                str(mount), str(images[0])], check=True, capture_output=True, timeout=120)
                self.assertEqual((mount / 'О данных.txt').read_bytes(),
                                 (ROOT / 'docs/statistics-notice.txt').read_bytes())
                self.assertTrue((mount / 'Applications').is_symlink())
                self.assertEqual(os.readlink(mount / 'Applications'), '/Applications')
                app = mount / 'Duprove.app/Contents'
                analyzer = app / 'Resources/analyzer/duprove-analyzer'
                for binary in [app / 'MacOS/Duprove', analyzer]:
                    checked = subprocess.run(['lipo', '-archs', str(binary)], check=True,
                                             capture_output=True, text=True, timeout=20)
                    self.assertEqual(checked.stdout.strip(), platform.machine())
                result = subprocess.run([str(analyzer), '--drives'], check=True,
                                        capture_output=True, text=True, timeout=20)
                self.assertIn('/', [drive['path'] for drive in json.loads(result.stdout)])
                print(f'MACOS_DMG_OK: {arch}, app, Applications link, notice and native analyzer')
            finally:
                if os.path.ismount(mount):
                    subprocess.run(['hdiutil', 'detach', str(mount)], check=True,
                                   capture_output=True, timeout=60)

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
