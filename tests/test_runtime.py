"""Resource boundaries with generated PNG/XML input; no user data."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from test_content import png, docx

ROOT = Path(__file__).resolve().parents[1]
BINARY = Path(os.environ.get('DUPROVE_ANALYZER', str(ROOT / 'build/native/bin' /
    ('duprove-analyzer.exe' if os.name == 'nt' else 'duprove-analyzer'))))

class RuntimeTests(unittest.TestCase):
    def test_mode_content_limits_are_explicit_and_do_not_limit_exact_duplicates(self):
        fixtures = ROOT / '.verification/native-fixtures'
        fixtures.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='runtime-content-', dir=fixtures) as temporary:
            base = Path(temporary); data = base / 'data'; data.mkdir()
            # 0.5625 MiPixels exceeds low's 0.5 but fits medium/high.
            picture = png(768, 768, bytes([23, 80, 140, 255]) * (768 * 768))
            (data / 'a.png').write_bytes(picture); (data / 'b.png').write_bytes(picture)
            # 300 KiB text/XML exceeds low's 256 KiB but fits medium/high.
            text = 'x' * (300 * 1024)
            (data / 'a.txt').write_text(text, encoding='utf-8')
            (data / 'b.txt').write_text(text, encoding='utf-8')
            (data / 'document.docx').write_bytes(docx(f'<w:p><w:r><w:t>{text}</w:t></w:r></w:p>'))
            for mode in range(3):
                job = base / 'job.json'
                job.write_text(json.dumps({'roots': [str(data)], 'database': str(base / f'work-{mode}/index.sqlite'),
                                           'content': True, 'load': mode}), encoding='utf-8')
                process = subprocess.run([str(BINARY), '--job', str(job)], input='', capture_output=True, encoding='utf-8', timeout=90)
                self.assertEqual(process.returncode, 0, process.stdout + process.stderr)
                result = json.loads(process.stdout.splitlines()[-1])
                self.assertTrue(result['report']['complete'])
                self.assertEqual(result['report']['statistics']['total']['duplicates'], 2)
                self.assertEqual(result['content']['files']['limit'], 5 if mode == 0 else 0)
                self.assertEqual(result['content']['files']['ready'], 0 if mode == 0 else 5)
                self.assertEqual(result['content']['warning_pairs']['text'], 0 if mode == 0 else 2)

if __name__ == '__main__':
    unittest.main()
