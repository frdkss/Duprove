"""Stage 4 CLI checks. All files are synthetic and local to each fixture."""
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
BINARY = Path(os.environ.get('DUPROVE_ANALYZER', str(ROOT / 'build/native/bin' /
              ('duprove-analyzer.exe' if os.name == 'nt' else 'duprove-analyzer'))))


class ComparisonTests(unittest.TestCase):
    def setUp(self):
        fixtures = ROOT / '.verification/native-fixtures'
        fixtures.mkdir(parents=True, exist_ok=True)
        temporary = tempfile.TemporaryDirectory(prefix='stage4-', dir=fixtures)
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)
        self.roots = [self.base / 'disk-a', self.base / 'disk-b']
        for root in self.roots:
            root.mkdir()
        self.database = self.base / 'work/index.sqlite'

    def write(self, disk, name, data):
        path = self.roots[disk] / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return path

    def scan(self):
        job = self.base / 'job.json'
        job.write_text(json.dumps({'roots': list(map(str, self.roots)),
                                  'database': str(self.database), 'load': 2, 'content': False}), encoding='utf-8')
        process = subprocess.run([str(BINARY), '--job', str(job)], input='', capture_output=True,
                                 text=True, encoding='utf-8', timeout=60)
        self.assertEqual(process.returncode, 0, process.stdout + process.stderr)
        result = json.loads(process.stdout.splitlines()[-1])
        self.assertTrue(result['report']['complete'], result)
        return result['report']

    def test_renamed_dated_cross_disk_copies_and_metadata_false_positive(self):
        a = self.write(0, 'private-name.TXT', b'identical payload')
        b = self.write(1, 'renamed.bin', b'identical payload')
        c = self.write(0, 'nested/private-name.TXT', b'different payload')
        os.utime(a, (1000000000, 1000000000))
        os.utime(b, (1700000000, 1700000000))
        os.utime(c, (1000000000, 1000000000))
        before = {p: (p.read_bytes(), p.stat().st_mtime_ns) for p in (a, b, c)}
        report = self.scan()
        self.assertEqual(report['statistics']['total']['duplicates'], 1)
        self.assertEqual(report['duplicates'][0]['copies'], 2)
        self.assertEqual(report['duplicates'][0]['extensions'], {'.bin': 1, '.txt': 1})
        self.assertEqual(report['duplicates'][0]['disks'], {'0': 1, '1': 1})
        public = json.dumps(report)
        for private in ('private-name', 'renamed', str(self.base), '1000000000',
                        hashlib.sha256(b'identical payload').hexdigest()):
            self.assertNotIn(private, public)
        for path, expected in before.items():
            self.assertEqual((path.read_bytes(), path.stat().st_mtime_ns), expected)

    def test_size_filter_avoids_reading_unique_sizes_and_empty_files(self):
        self.write(0, 'empty', b'')
        self.write(1, 'empty.txt', b'')
        self.write(0, 'unique', b'unique size')
        self.write(0, 'a', b'same')
        self.write(1, 'b', b'same')
        self.write(1, 'c', b'diff')
        report = self.scan()
        self.assertEqual(report['statistics']['total']['empty'], 2)
        self.assertEqual(report['statistics']['total']['duplicates'], 1)
        with closing(sqlite3.connect(self.database)) as db:
            rows = db.execute('SELECT name,size,hash,gid FROM files').fetchall()
        for name, size, digest, group in rows:
            if size in (0, len(b'unique size')):
                self.assertEqual((digest, group), ('', 0), name)
            else:
                self.assertEqual(len(digest), 64)

    def test_extensions_and_hardlinks_do_not_split_or_inflate_group(self):
        names = ['a.JPG', 'b.jpg', 'c.tar.gz', 'd.TAR.GZ', 'no-extension', '.hidden', 'many.dots.txt']
        paths = [self.write(i % 2, name, b'one exact group') for i, name in enumerate(names)]
        os.link(paths[0], self.roots[1] / 'hard-link')
        report = self.scan()
        self.assertEqual(report['statistics']['total']['files'], 7)
        self.assertEqual(report['statistics']['total']['duplicates'], 6)
        self.assertEqual(report['duplicates'][0]['extensions'],
                         {'.jpg': 2, '.tar.gz': 2, 'none': 2, '.txt': 1})

    def test_large_binary_copies_and_last_byte_difference(self):
        payload = bytes(range(256)) * 4096 + b'end'
        self.write(0, 'large', payload)
        self.write(1, 'copy', payload)
        self.write(1, 'different', payload[:-1] + b'!')
        report = self.scan()
        self.assertEqual(report['statistics']['total']['duplicates'], 1)
        with closing(sqlite3.connect(self.database)) as db:
            digest = db.execute("SELECT hash FROM files WHERE name='large'").fetchone()[0]
        self.assertEqual(digest, hashlib.sha256(payload).hexdigest())

    def test_legacy_working_database_is_rebuilt(self):
        self.database.parent.mkdir()
        with closing(sqlite3.connect(self.database)) as db:
            db.execute("CREATE TABLE files(path TEXT PRIMARY KEY,identity TEXT UNIQUE,root INTEGER,"
                       "size INTEGER,mtime INTEGER,ext TEXT,cat TEXT,hash TEXT DEFAULT '',"
                       "norm TEXT DEFAULT '',gid INTEGER DEFAULT 0,seen INTEGER DEFAULT 0)")
        self.write(0, 'a', b'data')
        self.write(1, 'b', b'data')
        self.assertEqual(self.scan()['statistics']['total']['duplicates'], 1)


if __name__ == '__main__':
    unittest.main()
