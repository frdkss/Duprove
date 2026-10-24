"""Generate a disposable localhost certificate and test the actual HTTPS boundary."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
openssl = shutil.which('openssl')
if not openssl and os.name == 'nt':
    candidate = Path(os.environ.get('ProgramFiles', 'C:/Program Files')) / 'Git/usr/bin/openssl.exe'
    if candidate.is_file():
        openssl = str(candidate)
if not openssl:
    raise SystemExit('OPENSSL_REQUIRED_FOR_DISPOSABLE_TEST_CERTIFICATE')
(ROOT / '.verification').mkdir(exist_ok=True)
with tempfile.TemporaryDirectory(prefix='results-privacy-', dir=ROOT / '.verification') as temporary:
    base = Path(temporary)
    subprocess.run([openssl, 'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-days', '1',
                    '-keyout', str(base / 'key.pem'), '-out', str(base / 'cert.pem'),
                    '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1'],
                   check=True, capture_output=True, timeout=30)
    environment = {**os.environ, 'DUPROVE_RESULTS_TLS_DIR': temporary}
    raise SystemExit(subprocess.run(['node', 'tests/results-privacy.cjs'], cwd=ROOT,
                                   env=environment, timeout=30).returncode)
