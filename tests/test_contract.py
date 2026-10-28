import json
import copy
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend'))
from duprove_backend.contract import is_report


class ContractTests(unittest.TestCase):
    def test_bytes_and_progress(self):
        report = json.loads((ROOT / 'contracts/fixtures/byte-example.json').read_text(encoding='utf-8'))
        self.assertTrue(is_report(report))
        mutations = [(['duplicates', 0, 'size_bytes'], 13),
                     (['statistics', 'total', 'file_bytes'], 44),
                     (['statistics', 'total', 'duplicate_bytes'], 37),
                     (['statistics', 'total', 'reclaimable_bytes'], 25),
                     (['statistics', 'disks', 0, 'used_bytes'], 61),
                     (['statistics', 'total', 'used_bytes'], 9007199254740992),
                     (['progress', 'disks', 0, 'id'], 1),
                     (['progress', 'disks', 0, 'work', 'current'], 'PRIVATE_PATH'),
                     (['progress', 'status'], 'running')]
        for keys, value in mutations:
            invalid = copy.deepcopy(report)
            target = invalid
            for key in keys[:-1]:
                target = target[key]
            target[keys[-1]] = value
            with self.subTest(keys=keys):
                self.assertFalse(is_report(invalid))
        invalid = copy.deepcopy(report)
        del invalid['statistics']['disks'][0]['file_bytes']
        self.assertFalse(is_report(invalid))

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
