"""Run as root inside `unshare --mount --propagation private`; no host mounts changed."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

if not sys.platform.startswith('linux') or os.geteuid() != 0:
    raise SystemExit('Requires a Linux root process in an isolated mount namespace')
if os.readlink('/proc/self/ns/mnt') == os.readlink('/proc/1/ns/mnt'):
    raise SystemExit('Refusing to mount in the host mount namespace')
binary = Path(os.environ['DUPROVE_ANALYZER']).resolve(strict=True)
# /tmp can itself be tmpfs, intentionally omitted by drive discovery. Use the build filesystem.
with tempfile.TemporaryDirectory(prefix='duprove-mount-', dir=binary.parent) as temporary:
    base = Path(temporary)
    run = base / 'run'
    volume = base / 'volume'
    run.mkdir()
    volume.mkdir()
    target = Path('/run/media/duprove-test/USB \\040')
    subprocess.run(['mount', '--bind', str(run), '/run'], check=True)
    try:
        target.mkdir(parents=True)
        ordinary = target.parent / 'ordinary-folder'
        ordinary.mkdir()
        subprocess.run(['mount', '--bind', str(volume), str(target)], check=True)
        try:
            result = subprocess.run([str(binary), '--drives'], check=True, capture_output=True, text=True, timeout=20)
            paths = [drive['path'] for drive in json.loads(result.stdout)]
            if str(target) not in paths:
                synthetic_mounts = [line for line in Path('/proc/self/mountinfo').read_text().splitlines() if '/run/media/duprove-test/' in line]
                synthetic_paths = [path for path in paths if path.startswith('/run/media/duprove-test/')]
                raise AssertionError(f'Synthetic mount missing: {synthetic_mounts!r}; reported: {synthetic_paths!r}')
            assert str(ordinary) not in paths, 'An ordinary directory is not a mounted volume'
            # A nested mount is not implicitly selected with its parent, even
            # for a bind mount on the same device. Selecting both keeps separate roots.
            child = target / 'nested'
            child.mkdir()
            external = base / 'outside'
            external.mkdir()
            (target / 'one').write_bytes(b'same')
            (external / 'two').write_bytes(b'same')
            subprocess.run(['mount', '--bind', str(external), str(child)], check=True)
            try:
                def scan(roots):
                    job = base / 'job.json'
                    job.write_text(json.dumps({'roots': list(map(str, roots)), 'database': str(base / 'work/index.sqlite'), 'load': 2}))
                    output = subprocess.run([str(binary), '--job', str(job)], input='', check=True, capture_output=True, text=True, timeout=20)
                    return json.loads(output.stdout.splitlines()[-1])['report']
                report = scan([target])
                assert report['complete'] and report['statistics']['total']['files'] == 1, 'Unselected bind mount crossed'
                report = scan([target, child])
                assert report['complete'] and report['statistics']['total']['files'] == 2
                assert report['statistics']['total']['duplicates'] == 1, 'Cross-mount comparison missing'
                assert report['duplicates'][0]['disks'] == {'0': 1, '1': 1}
            finally:
                subprocess.run(['umount', str(child)], check=True)
        finally:
            subprocess.run(['umount', str(target)], check=True)
    finally:
        subprocess.run(['umount', '/run'], check=True)
print('LINUX_MOUNT_NAMESPACE_OK: discovery, escapes, unselected bind mount boundary and selected cross-mount duplicates')
