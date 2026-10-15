"""Compare fresh and reused hashes on generated small files; never scan user data."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
BINARY = Path(os.environ.get('DUPROVE_ANALYZER', str(ROOT / 'build/native/bin/duprove-analyzer.exe')))
count = int(os.environ.get('DUPROVE_CACHE_FILES', '2000'))
rows = []
with tempfile.TemporaryDirectory(prefix='cache-benchmark-', dir=ROOT / '.verification') as temporary:
    base = Path(temporary)
    data = base / 'data' / 'a' / 'b' / 'c' / 'd' / 'e'
    data.mkdir(parents=True)
    for i in range(count):
        (data / f'{i:06}.bin').write_bytes(i.to_bytes(8, 'little') + b'x' * 248)
    for mode in map(int, os.environ.get('DUPROVE_CACHE_MODES', '0,1,2').split(',')):
        job = base / 'job.json'
        job.write_text(json.dumps({'roots': [str(base / 'data')], 'database': str(base / f'work-{mode}/index.sqlite'), 'load': mode}), encoding='utf-8')
        for run in ('fresh', 'cached'):
            start = time.perf_counter()
            process = subprocess.run([str(BINARY), '--job', str(job)], input='', capture_output=True, encoding='utf-8', timeout=180)
            elapsed = time.perf_counter() - start
            assert process.returncode == 0, process.stdout[-1000:]
            result = json.loads(process.stdout.splitlines()[-1])
            assert result['report']['complete'] and result['report']['statistics']['total']['duplicates'] == 0
            assert result['resources']['reused_hashes'] == (count if run == 'cached' else 0)
            row = {'mode': ['low', 'medium', 'high'][mode], 'run': run, 'files': count, 'seconds': round(elapsed, 3),
                   'files_s': round(count / elapsed, 1), **result['resources']}
            rows.append(row)
            print(json.dumps(row), flush=True)
out = ROOT / '.verification' / os.environ.get('DUPROVE_CACHE_RESULT', 'cache-benchmark.json')
out.write_text(json.dumps(rows, indent=2), encoding='utf-8')
