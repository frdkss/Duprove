import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend'))
from duprove_backend.contract import is_report

BINARY = Path(os.environ.get('DUPROVE_ANALYZER', str(ROOT / 'build/native/bin' / ('duprove-analyzer.exe' if os.name == 'nt' else 'duprove-analyzer'))))
FIXTURES = ROOT / '.verification/native-fixtures'
FIXTURES.mkdir(parents=True, exist_ok=True)


class AnalyzerTests(unittest.TestCase):
    def test_native_report_uses_public_contract(self):
        with tempfile.TemporaryDirectory(prefix='duprove-stage1-', dir=FIXTURES) as temporary:
            base = Path(temporary)
            roots = [base / 'disk-a', base / 'disk-b']
            for root in roots:
                root.mkdir()
            files = {roots[0] / 'PRIVATE_ONE.txt': b'identical bytes', roots[0] / 'PRIVATE_TWO.bin': b'identical bytes',
                     roots[1] / 'PRIVATE_THREE.txt': b'identical bytes', roots[1] / 'PRIVATE_EMPTY': b'',
                     roots[1] / 'PRIVATE_UNIQUE.txt': b'other content!'}
            for path, data in files.items():
                path.write_bytes(data)
            job = base / 'job.json'
            job.write_text(json.dumps({'roots': list(map(str, roots)), 'database': str(base / 'work/index.sqlite'), 'load': 2, 'content': False}), encoding='utf-8')
            result = subprocess.run([str(BINARY), '--job', str(job)], input='', capture_output=True, text=True, encoding='utf-8', timeout=30)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            events = [json.loads(line) for line in result.stdout.splitlines()]
            report = events[-1]['report']
            self.assertTrue(is_report(report), report)
            total = report['statistics']['total']
            self.assertEqual(total['file_bytes'], sum(map(len, files.values())))
            self.assertEqual(total['duplicate_bytes'], 3 * len(b'identical bytes'))
            self.assertEqual(total['reclaimable_bytes'], 2 * len(b'identical bytes'))
            self.assertEqual(report['duplicates'][0]['size_bytes'], len(b'identical bytes'))
            checkpoints = [e['report'] for e in events if e['type'] == 'progress' and 'report' in e]
            self.assertGreaterEqual(len(checkpoints), 2)
            for checkpoint in checkpoints:
                self.assertTrue(is_report(checkpoint), checkpoint)
                self.assertFalse(checkpoint['complete'])
            self.assertEqual((total['files'], total['empty'], total['duplicate_groups'], total['duplicates']), (5, 1, 1, 2))
            self.assertEqual(report['duplicates'][0]['extensions'], {'.bin': 1, '.txt': 2})
            self.assertEqual(report['duplicates'][0]['disks'], {'0': 2, '1': 1})
            self.assertNotIn('PRIVATE_', json.dumps(report))
            self.assertNotIn(str(base), json.dumps(report))
            for path, data in files.items():
                self.assertEqual(path.read_bytes(), data)

            check = "const v=require('./.verification/tests/contracts/validate.js');let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>process.exit(v.isReport(JSON.parse(s))?0:1))"
            validated = subprocess.run([os.environ.get('DUPROVE_NODE', 'node'), '-e', check], input=json.dumps(report), text=True, cwd=ROOT, timeout=15)
            self.assertEqual(validated.returncode, 0)

    def test_optional_content_is_explicit_and_separate_from_public_report(self):
        with tempfile.TemporaryDirectory(dir=FIXTURES) as temporary:
            base = Path(temporary)
            job = base / 'job.json'
            job.write_text(json.dumps({'roots': [str(base)], 'database': str(base / 'work/index.sqlite'), 'content': True}), encoding='utf-8')
            result = subprocess.run([str(BINARY), '--job', str(job)], input='', capture_output=True, text=True, encoding='utf-8', timeout=15)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            event = json.loads(result.stdout.splitlines()[-1])
            self.assertTrue(event['content']['enabled'])
            self.assertEqual(event['content']['warnings'], [])
            self.assertTrue(is_report(event['report']))
            self.assertNotIn('content', event['report'])
            check = "const v=require('./.verification/tests/electron/services/analyzer-service.js');let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>v.contentFromEvent(JSON.parse(s)))"
            validated = subprocess.run([os.environ.get('DUPROVE_NODE', 'node'), '-e', check], input=json.dumps(event), text=True, cwd=ROOT, timeout=15)
            self.assertEqual(validated.returncode, 0)


if __name__ == '__main__':
    unittest.main()
