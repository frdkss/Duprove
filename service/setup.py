from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import time
import traceback
import urllib.request
import zipfile
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parent.parent
TOOLS = ROOT / '.tools'
LOGS = ROOT / 'service' / 'logs'
LOCK = ROOT / 'service' / 'tools.lock.json'


def run(command, *, cwd=ROOT, env=None, capture=False, timeout=1800):
    command = [str(arg) for arg in command]
    print('>', subprocess.list2cmdline(command), flush=True)
    try:
        result = subprocess.run(command, cwd=cwd, env=env, timeout=timeout,
                                text=True, encoding='utf-8', errors='replace',
                                stdout=subprocess.PIPE if capture else None,
                                stderr=subprocess.STDOUT if capture else None,
                                check=True)
    except subprocess.CalledProcessError as error:
        if capture and error.stdout:
            print(error.stdout, flush=True)
        raise
    return result.stdout.strip() if capture else ''


def download(url, destination, sha256):

    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.is_file():
        with destination.open('rb') as cached:
            if hashlib.file_digest(cached, 'sha256').hexdigest() == sha256:
                return destination
    temporary = destination.with_suffix(destination.suffix + '.part')
    for attempt in range(3):
        try:
            print(f'Downloading {url}', flush=True)
            request = urllib.request.Request(url, headers={'User-Agent': 'Duprove-Service/0'})
            with urllib.request.urlopen(request, timeout=180) as source, temporary.open('wb') as output:
                shutil.copyfileobj(source, output)
            with temporary.open('rb') as source:
                digest = hashlib.file_digest(source, 'sha256').hexdigest()
            if digest != sha256:
                raise ValueError(f'SHA256 mismatch: {destination.name}')
            temporary.replace(destination)
            return destination
        except Exception:
            temporary.unlink(missing_ok=True)
            if attempt == 2:
                raise
            time.sleep(2 ** attempt)


def unpack(archive, destination):

    destination = Path(destination).resolve()
    destination.mkdir(parents=True, exist_ok=True)
    if zipfile.is_zipfile(archive):
        with zipfile.ZipFile(archive) as source:
            for entry in source.infolist():
                if not (destination / entry.filename).resolve().is_relative_to(destination):
                    raise ValueError('Unsafe archive path')
                if (entry.external_attr >> 16) & 0o170000 == 0o120000:
                    raise ValueError('Archive links are not allowed')
            source.extractall(destination)
    else:
        with tarfile.open(archive) as source:
            source.extractall(destination, filter='data')


def install_portable(name, entry):
    target = TOOLS / name
    archive = download(entry['url'], TOOLS / 'downloads' / entry['filename'], entry['sha256'])
    if entry.get('archive', True):
        unpack(archive, target)
    else:
        target.mkdir(parents=True, exist_ok=True)
        executable = target / entry['executable']
        matches = False
        if executable.is_file():
            with executable.open('rb') as installed:
                matches = hashlib.file_digest(installed, 'sha256').hexdigest() == entry['sha256']
        if not matches:
            shutil.copy2(archive, executable)
    executable = target / entry['executable']
    if not executable.is_file():
        raise FileNotFoundError(executable)
    os.environ['PATH'] = str(executable.parent) + os.pathsep + os.environ['PATH']
    if entry.get('version_args'):
        run([executable, *entry['version_args']], timeout=60)
    return executable


def install_python(uv):
    python = ROOT / '.venv/Scripts/python.exe'
    if not python.is_file():
        run([uv, 'venv', ROOT / '.venv', '--python', sys.executable])
    version = run([python, '-c', 'import sys; print(sys.version_info >= (3, 12))'], capture=True)
    if version != 'True':
        raise RuntimeError('Existing .venv requires Python 3.12+. It was not replaced.')
    run([uv, 'pip', 'install', '--python', python, '-r', ROOT / 'backend/requirements.txt'])
    cmake = shutil.which('cmake.exe')
    if not cmake or tuple(map(int, run([cmake, '--version'], capture=True).splitlines()[0].split()[-1].split('.')[:2])) < (3, 24):
        run([uv, 'pip', 'install', '--python', python, 'cmake>=3.24,<5'])
    run([uv, 'pip', 'check', '--python', python])
    run([python, '-c', 'from backend.duprove_backend.contract import VALIDATOR; print("Python contract OK")'])


def install_node(lock):
    node = shutil.which('node.exe')
    if not node or not run([node, '-p', 'process.versions.node'], capture=True).startswith('24.'):
        node = str(install_portable('node', lock['node']))
    npm = Path(node).parent / 'node_modules/npm/bin/npm-cli.js'
    if not npm.is_file():
        node = str(install_portable('node', lock['node']))
        npm = Path(node).parent / 'node_modules/npm/bin/npm-cli.js'
    os.environ['PATH'] = str(Path(node).parent) + os.pathsep + os.environ['PATH']
    run([node, npm, 'install', '--no-audit', '--include=dev'])


    directory = ROOT / 'node_modules/electron'
    version = json.loads((directory / 'package.json').read_text(encoding='utf-8'))['version']
    installed = directory / 'dist/version'
    if not (directory / 'dist/electron.exe').is_file() or not installed.is_file() or installed.read_text().strip().lstrip('v') != version:
        filename = f'electron-v{version}-win32-x64.zip'
        checksum = json.loads((directory / 'checksums.json').read_text(encoding='utf-8'))[filename]
        archive = download(f'https://github.com/electron/electron/releases/download/v{version}/{filename}', TOOLS / 'downloads' / filename, checksum)
        unpack(archive, directory / 'dist')
    (directory / 'path.txt').write_text('electron.exe', encoding='utf-8')
    run([node, npm, 'ls', '--depth=0'])
    run([node, '-e', 'require("esbuild").transformSync("let x: number = 1", {loader:"ts"}); console.log("Node tools OK")'])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--uv', required=True)
    options = parser.parse_args()
    if sys.platform != 'win32' or os.environ.get('PROCESSOR_ARCHITECTURE', '').lower() not in ('amd64', 'x86_64'):
        raise RuntimeError('The dependency installer supports Windows x64')
    LOGS.mkdir(parents=True, exist_ok=True)
    lock = json.loads(LOCK.read_text(encoding='utf-8'))
    os.environ['PATH'] = str(ROOT / '.venv/Scripts') + os.pathsep + os.environ['PATH']
    steps = {
        'python': lambda: install_python(options.uv),
        'node': lambda: install_node(lock),
        'native': lambda: run(['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ROOT / 'service/native.ps1'], timeout=3600),
    }
    results = []
    for name, action in steps.items():
        started = time.monotonic()
        print(f'\n=== {name} ===', flush=True)
        try:
            action()
            results.append({'name': name, 'status': 'ok'})
        except Exception as error:
            traceback.print_exc()
            results.append({'name': name, 'status': 'error', 'detail': str(error)})
        results[-1]['seconds'] = round(time.monotonic() - started, 1)
        report = {'time': datetime.now(timezone.utc).isoformat(), 'results': results}
        (LOGS / 'dependencies.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    print('\n' + '\n'.join(f"{item['name']}: {item['status']}" for item in results), flush=True)
    return int(any(item['status'] != 'ok' for item in results))


if __name__ == '__main__':
    sys.exit(main())
