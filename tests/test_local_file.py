"""Bounded native preview and identity verification on disposable local files."""
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import struct
import subprocess
import sys
import tempfile
import unittest
from contextlib import closing
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
        with closing(sqlite3.connect(self.database)) as db:
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

    def test_snapshot_accepts_all_formats_without_executing_or_changing_source(self):
        data = b'print("comparison-only")\n'
        request = self.record('source.py', data)
        output = self.private / 'preview-cache' / 'snapshot.bin'
        output.parent.mkdir(parents=True, exist_ok=True)
        request.update(action='snapshot', output=str(output))
        result = self.inspect(request)
        self.assertEqual(result['status'], 'ready')
        self.assertEqual(result['sha256'], hashlib.sha256(data).hexdigest())
        self.assertEqual(output.read_bytes(), data)
        self.assertEqual(Path(request['path']).read_bytes(), data)
        self.assertEqual(self.inspect(request)['status'], 'unavailable', 'A snapshot never overwrites an existing file')
        self.assertEqual(output.read_bytes(), data)
        outside = self.root / 'must-not-write.bin'
        self.assertEqual(self.inspect({**request, 'output': str(outside)})['status'], 'unavailable')
        self.assertFalse(outside.exists())
        Path(request['path']).write_bytes(b'changed')
        changed = output.with_name('changed.bin')
        self.assertEqual(self.inspect({**request, 'output': str(changed)})['status'], 'unavailable')
        self.assertFalse(changed.exists())

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

    def test_pair_requires_current_metadata_and_true_byte_equality(self):
        left = self.record('original.txt', b'abc')
        right = self.record('duplicate.txt', b'abc')
        request = {'action': 'pair', 'left': left, 'right': right, 'exact': True}
        result = self.inspect(request)
        self.assertEqual(result['status'], 'ready'); self.assertTrue(result['equal'])
        self.assertEqual(result['sha256'], result['otherSha256'])
        other = self.record('other.txt', b'abd')
        self.assertEqual(self.inspect({**request, 'right': other})['status'], 'unavailable')
        warning = self.inspect({**request, 'right': other, 'exact': False})
        self.assertEqual(warning['status'], 'ready'); self.assertFalse(warning['equal'])
        self.assertNotEqual(warning['sha256'], warning['otherSha256'])
        Path(left['path']).write_bytes(b'bad')
        self.assertEqual(self.inspect(request)['status'], 'unavailable')

    @unittest.skipIf(os.name == 'nt', 'Windows access denial is exercised separately using ACLs')
    def test_read_denial_without_administrator_never_changes_the_file(self):
        self.assertNotEqual(os.geteuid(), 0, 'run the access-denial check as an ordinary user')
        if sys.platform == 'linux':
            # DrvFS/NTFS can ignore POSIX read-mode bits; use Linux's temporary
            # filesystem so chmod actually exercises a denied read.
            temporary = tempfile.TemporaryDirectory(prefix='duprove-results-access-')
            self.addCleanup(temporary.cleanup)
            self.root = Path(temporary.name) / 'files'
            self.root.mkdir()
            self.private = Path(temporary.name) / 'private'
            self.database = self.private / 'work/index.sqlite'
        request = self.record('protected.txt', b'protected bytes')
        file = Path(request['path'])
        file.chmod(0)
        self.addCleanup(file.chmod, 0o600)
        # Use current metadata to isolate an actual read denial from stale metadata.
        info = file.stat()
        request.update(identity=f'{info.st_dev}:{info.st_ino}', mtime=str(info.st_mtime_ns), ctime=str(info.st_ctime_ns))
        self.assertEqual(self.inspect(request)['status'], 'unavailable')
        file.chmod(0o600)
        self.assertEqual(file.read_bytes(), b'protected bytes')

    def test_trash_requires_verified_digests_and_never_removes_connected_files(self):
        left = self.record('preserved.html', b'<p>identical test bytes</p>')
        right = self.record('candidate.html', b'<p>identical test bytes</p>')
        related = self.root / 'candidate_files'
        related.mkdir(); (related / 'must-remain.txt').write_text('unselected resource', encoding='utf-8')
        pair = self.inspect({'action': 'pair', 'left': left, 'right': right, 'exact': True})
        request = {'action': 'trash', 'left': left, 'right': right, 'exact': True,
                   'expected_left_sha256': pair['sha256'], 'expected_right_sha256': '0' * 64}
        self.assertEqual(self.inspect(request)['status'], 'refused')
        self.assertTrue(Path(right['path']).is_file())
        request['expected_right_sha256'] = pair['otherSha256']
        result = self.inspect(request)
        if os.name == 'nt':
            self.assertEqual(result['status'], 'trashed')
            self.assertFalse(Path(right['path']).exists())
        else:
            self.assertEqual(result['status'], 'refused', 'Windows adapter is unavailable on this platform')
            self.assertTrue(Path(right['path']).is_file())
        self.assertEqual(Path(left['path']).read_bytes(), b'<p>identical test bytes</p>')
        self.assertEqual((related / 'must-remain.txt').read_text(encoding='utf-8'), 'unselected resource')


if __name__ == '__main__':
    unittest.main()
