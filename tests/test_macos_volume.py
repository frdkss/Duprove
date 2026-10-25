"""Native macOS test using a new disposable APFS disk image, never a physical disk."""
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]


def run(*args, busy_retries=0):
    for attempt in range(busy_retries + 1):
        result = subprocess.run(args, input=b'', capture_output=True, timeout=90)
        if not result.returncode:
            return result.stdout
        # The disposable APFS image can still be held briefly by macOS services
        # after the analyzer exits. Retry normal detach only; never force eject.
        if result.returncode == 16 and attempt < busy_retries:
            time.sleep(0.5)
            continue
        raise RuntimeError(f'{args[0]} failed ({result.returncode}): {result.stderr.decode("utf-8", errors="replace")}')


def main():
    if sys.platform != 'darwin':
        raise SystemExit('Requires native macOS')
    binary = Path(os.environ.get('DUPROVE_ANALYZER', str(ROOT / 'build/native/bin/duprove-analyzer'))).resolve(strict=True)
    fixtures = ROOT / '.verification'
    fixtures.mkdir(exist_ok=True)
    # /tmp and /private/var are intentionally excluded by the scanner.
    base = Path(tempfile.mkdtemp(prefix='mac-volume-', dir=fixtures)).resolve()
    image = base / 'test.sparseimage'
    parent = base / 'selected'
    mount = parent / 'mounted volume'
    try:
        mount.mkdir(parents=True)
        run('hdiutil', 'create', '-size', '1g', '-fs', 'APFS', '-volname', 'Macintosh HD', '-type', 'SPARSE', str(image))
        attached = False
        try:
            # Do not use -nobrowse: MNT_DONTBROWSE volumes are intentionally hidden.
            result = plistlib.loads(run('hdiutil', 'attach', '-noautoopen', '-mountpoint', str(mount), '-plist', str(image)))
            attached = True
            assert any(entry.get('mount-point') == str(mount) for entry in result['system-entities']), 'Wrong image mount point'
            assert os.path.ismount(mount), 'Image did not mount'
            (parent / 'one.txt').write_bytes(b'identical test bytes')
            data = mount / 'data'
            data.mkdir()
            (data / 'two.bin').write_bytes(b'identical test bytes')
            drives = json.loads(run(str(binary), '--drives'))
            assert str(mount) in {drive['path'] for drive in drives}, 'APFS image named Macintosh HD must be discovered'

            def scan(roots):
                job = base / 'job.json'
                job.write_text(json.dumps({'roots': list(map(str, roots)), 'database': str(base / 'work/index.sqlite'), 'load': 2}), encoding='utf-8')
                event = json.loads(run(str(binary), '--job', str(job)).splitlines()[-1])
                assert event['type'] == 'result' and event['report']['complete'], 'APFS scan incomplete'
                return event['report']

            report = scan([parent])
            assert report['statistics']['total']['files'] == 1, 'Unselected APFS mount crossed'
            # System services may create Spotlight/fsevent metadata at the volume
            # root; exact file counts apply only to the synthetic data directory.
            report = scan([parent, data])
            assert report['statistics']['total']['files'] == 2
            assert report['statistics']['total']['duplicates'] == 1
            assert report['duplicates'][0]['disks'] == {'0': 1, '1': 1}
        finally:
            if attached or os.path.ismount(mount):
                run('hdiutil', 'detach', str(mount), busy_retries=10)
            if os.path.ismount(mount):
                # Leave the synthetic fixture intact instead of recursing into a mounted image.
                raise SystemExit('TEST_IMAGE_STILL_MOUNTED')
        drives = json.loads(run(str(binary), '--drives'))
        assert str(mount) not in {drive['path'] for drive in drives}, 'Detached image still listed'
    finally:
        # No context-manager cleanup: a detach failure must preserve the mounted fixture.
        if not os.path.ismount(mount):
            assert base.parent == fixtures.resolve() and base.name.startswith('mac-volume-')
            shutil.rmtree(base)
    print('MACOS_VOLUME_OK: native APFS image, selection boundary, cross-volume duplicates and detach')


if __name__ == '__main__':
    main()
