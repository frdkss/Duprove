"""Reproducible synthetic metadata benchmark; never scans user directories."""
import argparse
import json
import os
from pathlib import Path
import statistics
import subprocess
import sys
import tempfile
import time

parser = argparse.ArgumentParser()
parser.add_argument('--binary', type=Path, required=True)
parser.add_argument('--files', type=int, default=20000)
parser.add_argument('--runs', type=int, default=3)
parser.add_argument('--files-per-directory', type=int, default=100)
parser.add_argument('--depth', type=int, default=0)
parser.add_argument('--output', type=Path)
args = parser.parse_args()
if args.files < 1 or args.runs < 1 or args.files_per_directory < 1 or args.depth < 0:
    parser.error('fixture counts must be positive; depth must be nonnegative')
fixtures = Path(__file__).resolve().parents[1] / '.verification/native-fixtures'
fixtures.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(prefix='duprove-benchmark-', dir=fixtures if sys.platform == 'darwin' else None) as temporary:
    base = Path(temporary)
    root = base / 'data'
    root.mkdir()
    for i in range(args.files):
        folder = root / str(i // args.files_per_directory)
        for level in range(args.depth):
            folder /= f'level-{level}'
        folder.mkdir(parents=True, exist_ok=True)
        (folder / str(i)).touch()
    elapsed = []
    for run in range(args.runs):
        job = base / 'job.json'
        job.write_text(json.dumps({'roots': [str(root)], 'database': str(base / f'work-{run}/index.sqlite'), 'load': 2}), encoding='utf-8')
        start = time.perf_counter()
        result = subprocess.run([str(args.binary.resolve()), '--job', str(job)], input='', capture_output=True, text=True, encoding='utf-8', timeout=180)
        elapsed.append(time.perf_counter() - start)
        if result.returncode:
            raise RuntimeError('BENCHMARK_ANALYZER_FAILED')
        report = json.loads(result.stdout.splitlines()[-1])['report']
        assert report['complete'] and report['statistics']['total']['files'] == args.files
    summary = {'platform': os.name, 'files': args.files, 'runs_seconds': elapsed,
               'median_seconds': statistics.median(elapsed), 'files_per_second': args.files / statistics.median(elapsed),
               'fixture': f'empty files, {args.files_per_directory} per directory, {args.depth} extra levels; fresh database; warm filesystem caches; high load'}
    print(json.dumps(summary, indent=2))
    if args.output:
        args.output.write_text(json.dumps(summary, indent=2) + '\n', encoding='utf-8')
