"""Bounded native preview and identity verification on disposable local files."""
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import struct
import subprocess
import tempfile
import unittest
from test_content import docx, png, chunk

ROOT = Path(__file__).resolve().parents[1]
BINARY = Path(os.environ.get('DUPROVE_ANALYZER', ROOT / 'build/native/bin' /
              ('duprove-analyzer.exe' if os.name == 'nt' else 'duprove-analyzer')))


class LocalFileTests(unittest.TestCase):
    def setUp(self):
        directory = ROOT / '.verification/local-file-fixtures'
        directory.mkdir(parents=True, exist_ok=True)
        temporary = tempfile.TemporaryDirectory(dir=directory)
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)
        self.root = self.base / 'files'
        self.root.mkdir()
        self.private = self.base / 'private'
        self.database = self.private / 'work/index.sqlite'

    def record(self, name, data):
        file = self.root / name
        file.write_bytes(data)
        job = self.base / 'job.json'
        job.write_text(json.dumps({'roots': [str(self.root)], 'database': str(self.database),
                                  'private_directory': str(self.private), 'load': 2, 'content': False}), encoding='utf-8')
        process = subprocess.run([str(BINARY), '--job', str(job)], input='', capture_output=True,
                                 encoding='utf-8', timeout=60)
        self.assertEqual(process.returncode, 0, process.stdout)
        with sqlite3.connect(self.database) as db:
            row = db.execute('SELECT identity,size,CAST(mtime AS TEXT),CAST(ctime AS TEXT) FROM files WHERE path=?', (str(file),)).fetchone()
        self.assertIsNotNone(row)
        return {'action': 'preview', 'path': str(file), 'identity': row[0], 'size': row[1],
                'mtime': row[2], 'ctime': row[3], 'roots': [str(self.root)], 'private_directory': str(self.private)}

    def inspect(self, request):
        process = subprocess.run([str(BINARY), '--local-file'], input=json.dumps(request), capture_output=True,
                                 encoding='utf-8', timeout=20)
        self.assertEqual(process.returncode, 0, process.stdout)
        return json.loads(process.stdout)

    def test_active_html_and_markdown_are_literal_text(self):
        text = '<script>globalThis.PREVIEW_EXECUTED=true</script>\n<a href="https://example.invalid">test</a>'
        for extension in ['txt', 'md', 'html']:
            with self.subTest(extension=extension):
                request = self.record('active.' + extension, text.encode())
                result = self.inspect(request)
                self.assertEqual(result['status'], 'ready')
                self.assertEqual(result['text'], text)
                self.assertEqual(result['sha256'], hashlib.sha256(text.encode()).hexdigest())

    def test_encodings_truncation_and_input_limit(self):
        self.assertEqual(self.inspect(self.record('utf16.txt', 'текст'.encode('utf-16')))['text'], 'текст')
        self.assertEqual(self.inspect(self.record('broken.txt', b'\xff\xff'))['status'], 'invalid')
        result = self.inspect(self.record('truncated.txt', ('я' * 150000).encode()))
        self.assertTrue(result['truncated'])
        self.assertLessEqual(len(result['text'].encode()), 128 * 1024)
        self.assertEqual(self.inspect(self.record('too-large.txt', b'x' * (1024 * 1024 + 1)))['status'], 'limit')

    def test_docx_limits_corruption_and_external_entities(self):
        good = docx('<w:p><w:r><w:t>document text</w:t></w:r></w:p>')
        result = self.inspect(self.record('good.docx', good))
        self.assertEqual(result['status'], 'ready'); self.assertEqual(result['text'], 'document text')
        self.assertEqual(self.inspect(self.record('bad.docx', b'PK broken'))['status'], 'invalid')
        bomb = docx('<w:p><w:r><w:t>' + 'x' * (600 * 1024) + '</w:t></w:r></w:p>')
        self.assertEqual(self.inspect(self.record('bomb.docx', bomb))['status'], 'limit')
        active = docx('', extra={'word/document.xml': '<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><x>&e;</x>'})
        self.assertEqual(self.inspect(self.record('entity.docx', active))['status'], 'unsupported')

    def test_images_are_validated_before_browser_decode(self):
        image = png(2, 2, bytes([20, 80, 100, 255]) * 4)
        result = self.inspect(self.record('good.png', image))
        self.assertEqual(result['status'], 'ready'); self.assertEqual(result['width'], 2)
        self.assertTrue(result['data'].startswith('data:image/png;base64,'))
        self.assertEqual(self.inspect(self.record('bad.png', image[:-5]))['status'], 'invalid')
        huge = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 100000, 100000, 8, 6, 0, 0, 0))
        self.assertEqual(self.inspect(self.record('huge.png', huge))['status'], 'limit')
        self.assertEqual(self.inspect(self.record('bad.jpg', b'\xff\xd8garbage\xff\xd9'))['status'], 'invalid')

    def test_changes_replacements_roots_and_symlinks_fail_closed(self):
        request = self.record('proof.txt', b'original bytes')
        result = self.inspect({**request, 'action': 'verify'})
        self.assertEqual(result['sha256'], hashlib.sha256(b'original bytes').hexdigest())
        self.assertEqual(self.inspect({**request, 'roots': [str(self.base / 'other') ]})['status'], 'unavailable')
        self.assertEqual(self.inspect({**request, 'private_directory': str(self.root)})['status'], 'unavailable')
        file = Path(request['path']); before = file.stat()
        file.write_bytes(b'changed  bytes'); os.utime(file, ns=(before.st_atime_ns, before.st_mtime_ns))
        self.assertEqual(self.inspect(request)['status'], 'unavailable')
        request = self.record('replacement.txt', b'original bytes')
        file = Path(request['path']); replacement = self.root / 'replacement-new.txt'
        replacement.write_bytes(b'original bytes'); os.replace(replacement, file)
        self.assertEqual(self.inspect(request)['status'], 'unavailable')
        if os.name != 'nt':
            request = self.record('link.txt', b'original bytes')
            file = Path(request['path']); file.unlink(); file.symlink_to(self.root / 'proof.txt')
            self.assertEqual(self.inspect(request)['status'], 'unavailable')

    def test_unsupported_format_is_explicit(self):
        self.assertEqual(self.inspect(self.record('other.pdf', b'%PDF-1.7\n'))['status'], 'unsupported')


if __name__ == '__main__':
    unittest.main()
