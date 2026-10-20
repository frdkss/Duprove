import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend'))
from duprove_backend.contract import is_report


class ContractTests(unittest.TestCase):
    def test_shared_cases(self):
        cases = json.loads((ROOT / 'contracts/fixtures/cases.json').read_text(encoding='utf-8'))
        for case in cases:
            with self.subTest(case=case['name']):
                self.assertEqual(is_report(case['report']), case['valid'])

    def test_non_json_values(self):
        for value in (None, [], float('nan'), float('inf')):
            self.assertFalse(is_report(value))


if __name__ == '__main__':
    unittest.main()
