"""A real Linux recycle-bin failure on disposable /tmp files with restricted XDG storage."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile

if sys.platform != 'linux' or os.geteuid() == 0:
    raise SystemExit('THIS_ACCESS_CHECK_REQUIRES_LINUX_WITHOUT_ROOT')
ROOT = Path(__file__).resolve().parents[1]
electron = Path(os.environ.get('DUPROVE_TEST_ELECTRON', ROOT / 'node_modules/electron/dist/electron'))
with tempfile.TemporaryDirectory(prefix='duprove-unavailable-trash-') as temporary:
    base = Path(temporary)
    denied = base / 'unwritable-data'
    denied.mkdir(mode=0o500)
    environment = {**os.environ, 'XDG_DATA_HOME': str(denied), 'GIO_USE_VFS': 'local',
                   'GTK_USE_PORTAL': '0', 'DUPROVE_TEST_UNAVAILABLE_TRASH': '1',
                   'DUPROVE_RESULTS_FIXTURES': temporary}
    environment.pop('ELECTRON_RUN_AS_NODE', None)
    try:
        result = subprocess.run([str(electron), 'tests/results-integration.cjs'], cwd=ROOT,
                                env=environment, timeout=120)
    finally:
        denied.chmod(0o700)
    raise SystemExit(result.returncode)
