"""Real TLS/container smoke test using only synthetic reports and isolated volumes.

Requires Docker Compose and openssl (or --tls-dir with a localhost test certificate).
Run explicitly; never starts or removes the production Compose project.
"""
import argparse
import json
import os
from pathlib import Path
import socket
import ssl
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--tls-dir', type=Path)
    parser.add_argument('--client-tests', action='store_true', help='Also test the Node HTTPS client and analyzer-to-server delivery')
    parser.add_argument('--client-command', nargs=argparse.REMAINDER, default=['node'],
                        help='Optional argv prefix for the analyzer-to-server test (for example a Linux Node runner)')
    args = parser.parse_args()
    project = 'duprove-test-' + uuid4().hex[:12]
    with tempfile.TemporaryDirectory(prefix='duprove-tls-') as temporary:
        tls = args.tls_dir.resolve() if args.tls_dir else Path(temporary)
        if not args.tls_dir:
            subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
                            '-keyout', str(tls / 'privkey.pem'), '-out', str(tls / 'fullchain.pem'),
                            '-days', '1', '-subj', '/CN=localhost', '-addext',
                            'subjectAltName=DNS:localhost,IP:127.0.0.1'],
                           check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            # Disposable test key only; production permissions are documented separately.
            tls.chmod(0o755)
            (tls / 'privkey.pem').chmod(0o644)
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        env = dict(os.environ, DUPROVE_TLS_DIR=str(tls), DUPROVE_LISTEN=f'127.0.0.1:{port}')
        client_env = dict(env, DUPROVE_TEST_TLS_DIR=str(tls), DUPROVE_TEST_REPORT_URL=f'https://127.0.0.1:{port}/v1/reports')
        if args.client_tests:
            subprocess.run(['node', 'scripts/build-tests.mjs'], cwd=ROOT, check=True, timeout=60)
            subprocess.run(['node', '--test', 'tests/https-transport.cjs'], cwd=ROOT, env=client_env, check=True, timeout=60)
        compose = ['docker', 'compose', '-p', project, '-f', str(ROOT / 'backend/deploy/compose.yaml')]

        def run(*command):
            result = subprocess.run([*compose, *command], env=env, cwd=ROOT,
                                    capture_output=True, text=True, timeout=240)
            if result.returncode:
                raise RuntimeError(result.stdout + result.stderr)
            return result.stdout

        def receiver(code):
            return run('exec', '-T', 'receiver', 'python', '-c', code).strip()

        def stored():
            return int(receiver("import sqlite3; print(sqlite3.connect('/data/reports.sqlite3').execute('SELECT COUNT(*) FROM reports').fetchone()[0])"))

        context = ssl.create_default_context(cafile=str(tls / 'fullchain.pem'))
        payload = (ROOT / 'contracts/fixtures/example.json').read_bytes()

        def post(body=payload, path='/v1/reports', method='POST'):
            req = urllib.request.Request(f'https://localhost:{port}{path}', data=body, method=method,
                                         headers={'Content-Type': 'application/json',
                                                  'X-Forwarded-For': 'PRIVATE_IP', 'Cookie': 'PRIVATE_COOKIE'})
            try:
                response = urllib.request.urlopen(req, context=context, timeout=20)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                result = json.load(response)
                assert 'PRIVATE' not in json.dumps(result), result
                return response.status, result

        try:
            print('Building and starting isolated HTTPS deployment', flush=True)
            run('build', 'receiver')
            run('up', '-d', '--no-build', '--wait', '--wait-timeout', '120')
            run('exec', '-T', 'proxy', 'nginx', '-t')
            assert post()[0] == 201
            assert stored() == 1
            assert post(b'{')[0] == 400
            invalid = json.loads(payload)
            invalid['path'] = 'PRIVATE_FILE'
            assert post(json.dumps(invalid).encode())[0] == 422
            assert post(method='GET')[0] == 405
            assert post(path='/v1/reports?file=PRIVATE_FILE')[0] == 400
            assert post(path='/PRIVATE_FILE')[0] == 404
            # Oversize body is rejected before the Python validator.
            assert post(b' ' * (2 * 1024 * 1024 + 1))[0] == 413
            results = [post()[0] for _ in range(5)]
            assert 429 in results, results
            accepted = 1 + results.count(201)
            assert stored() == accepted
            print('TLS certificate verification, validation, size/rate limits: passed', flush=True)
            run('restart', 'receiver')
            for _ in range(40):
                try:
                    assert stored() == accepted
                    break
                except (RuntimeError, AssertionError):
                    time.sleep(0.25)
            else:
                raise AssertionError('restart did not preserve committed reports')
            # A stalled sync worker must be killed by Gunicorn, not hold the API
            # indefinitely. Reset only this project's proxy rate-limit memory.
            run('restart', 'proxy')
            run('up', '-d', '--no-build', '--wait', '--wait-timeout', '60')
            worker = receiver("from pathlib import Path; print(Path('/proc/1/task/1/children').read_text().strip())")
            assert len(worker.split()) == 1, worker
            receiver(f"import os, signal; os.kill({int(worker)}, signal.SIGSTOP)")
            started = time.monotonic()
            status, result = post()
            elapsed = time.monotonic() - started
            # The shared listening socket can queue the request until the new
            # worker accepts it. Both a bounded error and a committed success
            # are valid; a stalled worker must never remain alive indefinitely.
            assert status in (201, 502, 503, 504), (status, result)
            assert result['accepted'] is (status == 201), result
            assert elapsed < 16, elapsed
            for _ in range(40):
                replacement = receiver("from pathlib import Path; print(Path('/proc/1/task/1/children').read_text().strip())")
                if len(replacement.split()) == 1 and replacement != worker:
                    break
                time.sleep(0.25)
            else:
                raise AssertionError('Gunicorn did not replace its stalled worker')
            accepted += int(status == 201)
            assert stored() == accepted
            assert post()[0] == 201
            accepted += 1
            assert stored() == accepted
            print(f'Stalled worker replaced; request completed in {elapsed:.1f}s; ingestion recovered: passed', flush=True)
            # Expiry works without any HTTP request, on maintenance startup.
            receiver("import sqlite3; db=sqlite3.connect('/data/reports.sqlite3'); db.execute('UPDATE reports SET received_at=0'); db.commit()")
            run('restart', 'retention')
            for _ in range(40):
                if stored() == 0:
                    break
                time.sleep(0.25)
            else:
                raise AssertionError('maintenance did not expire reports')
            if args.client_tests:
                run('restart', 'proxy')
                run('up', '-d', '--no-build', '--wait', '--wait-timeout', '60')
                subprocess.run([*args.client_command, 'tests/delivery-deployment.cjs'], cwd=ROOT, env=client_env, check=True, timeout=90)
                assert stored() == 1, 'The retry must not create a second report'
                print('Client retry accepted once by the real HTTPS receiver: passed', flush=True)
            assert 'PRIVATE' not in run('logs')
            for service, user, memory in [('receiver', '10001:10001', 256), ('retention', '10001:10001', 64), ('proxy', '101:101', 128)]:
                container = run('ps', '-q', service).strip()
                info = json.loads(subprocess.check_output(['docker', 'inspect', container], text=True))[0]
                assert info['Config']['User'] == user
                assert info['HostConfig']['ReadonlyRootfs']
                assert info['HostConfig']['Memory'] == memory * 1024 * 1024
                assert info['HostConfig']['MemorySwap'] == memory * 1024 * 1024
                assert 'ALL' in info['HostConfig']['CapDrop']
                assert 'no-new-privileges:true' in info['HostConfig']['SecurityOpt']
                assert info['HostConfig']['NanoCpus'] == {'receiver': 500_000_000, 'retention': 100_000_000, 'proxy': 250_000_000}[service]
                assert info['HostConfig']['PidsLimit'] == {'receiver': 32, 'retention': 8, 'proxy': 16}[service]
                if service in ('receiver', 'proxy'):
                    assert info['HostConfig']['LogConfig']['Type'] == 'none'
                if service == 'retention':
                    assert info['HostConfig']['NetworkMode'] == 'none'
                if service == 'receiver':
                    assert not info['HostConfig']['PortBindings']
            print('Restart persistence, idle expiry, container restrictions: passed', flush=True)
        finally:
            run('down', '--volumes', '--remove-orphans')
            subprocess.run(['docker', 'image', 'rm', f'{project}-receiver:local'],
                           capture_output=True, check=False)
        for command in (['container', 'ls', '-aq'], ['network', 'ls', '-q'], ['volume', 'ls', '-q']):
            remaining = subprocess.check_output(['docker', *command, '--filter',
                                                 f'label=com.docker.compose.project={project}'], text=True)
            assert not remaining.strip(), remaining
        print('Isolated deployment removed with its containers, networks and data volume', flush=True)


if __name__ == '__main__':
    main()
