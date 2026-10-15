"""Time exact-duplicate workloads by stage, using only generated fixture files."""
import argparse
import json
from pathlib import Path
import subprocess
import tempfile
import time

parser = argparse.ArgumentParser()
parser.add_argument('--binary', type=Path, required=True)
parser.add_argument('--groups', type=int, default=1000)
parser.add_argument('--copies', type=int, default=5)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
assert args.groups > 0 and args.copies > 1
workspace = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='duplicates-speed-', dir=workspace / '.verification') as temp:
    base = Path(temp)
    data = base / 'data'
    for copy in range(args.copies):
        for group in range(args.groups):
            folder = data / f'env-{copy}' / 'lib' / 'packages' / f'pkg-{group // 20}'
            folder.mkdir(parents=True, exist_ok=True)
            (folder / f'file-{group:06}.bin').write_bytes(group.to_bytes(8, 'little') + b'x' * 248)
    job = base / 'job.json'
    job.write_text(json.dumps({'roots': [str(data)], 'database': str(base / 'work/index.sqlite'), 'load': 2}), encoding='utf-8')
    rows = []
    for run in ('fresh', 'cached'):
        start = last = time.perf_counter()
        stage = 'startup'
        phases = {}
        result = None
        with subprocess.Popen([str(args.binary.resolve()), '--job', str(job)], stdin=subprocess.DEVNULL,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, encoding='utf-8') as process:
            for line in process.stdout:
                event = json.loads(line)
                if event['type'] in ('progress', 'result'):
                    next_stage = event['disks'][0]['phase']
                    if next_stage != stage:
                        now = time.perf_counter()
                        phases[stage] = phases.get(stage, 0) + now - last
                        stage, last = next_stage, now
                if event['type'] == 'result':
                    result = event
            assert process.wait(timeout=180) == 0, process.stderr.read()
        elapsed = time.perf_counter() - start
        assert result and result['report']['complete']
        assert result['report']['statistics']['total']['files'] == args.groups * args.copies
        assert result['report']['statistics']['total']['duplicates'] == args.groups * (args.copies - 1)
        assert result['report']['statistics']['total']['duplicate_groups'] == args.groups
        rows.append({'run': run, 'seconds': round(elapsed, 3), 'phase_seconds': {k: round(v, 3) for k, v in phases.items()}, **result['resources']})
        print(json.dumps(rows[-1]), flush=True)
    args.output.write_text(json.dumps({'groups': args.groups, 'copies': args.copies, 'results': rows}, indent=2), encoding='utf-8')
