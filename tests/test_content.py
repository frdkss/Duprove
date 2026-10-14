"""Cross-platform content fixtures, generated with the Python standard library."""
from contextlib import closing
from io import BytesIO
import json
import os
from pathlib import Path
import sqlite3
import struct
import subprocess
import tempfile
import unittest
import zipfile
import zlib

ROOT = Path(__file__).resolve().parents[1]
BINARY = Path(os.environ.get('DUPROVE_ANALYZER', str(ROOT / 'build/native/bin' /
              ('duprove-analyzer.exe' if os.name == 'nt' else 'duprove-analyzer'))))
W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
R = 'http://schemas.openxmlformats.org/package/2006/relationships'
REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/'


def docx(body, prefix='w', extra=None):
    output = BytesIO()
    entries = {
        '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
        '_rels/.rels': f'<Relationships xmlns="{R}"><Relationship Id="rId1" Type="{REL}officeDocument" Target="word/document.xml"/></Relationships>',
        'word/document.xml': f'<{prefix}:document xmlns:{prefix}="{W}"><{prefix}:body>{body}</{prefix}:body></{prefix}:document>',
    }
    entries.update(extra or {})
    with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for name, value in entries.items():
            archive.writestr(name, value)
    return output.getvalue()


def chunk(kind, data):
    return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))


def png(width, height, pixels, exif=None):
    header = chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0))
    rows = b''.join(b'\0' + pixels[y*width*4:(y+1)*width*4] for y in range(height))
    return b'\x89PNG\r\n\x1a\n' + header + (chunk(b'eXIf', exif) if exif else b'') + chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b'')


class ContentTests(unittest.TestCase):
    def setUp(self):
        fixtures = ROOT / '.verification/native-fixtures'
        fixtures.mkdir(parents=True, exist_ok=True)
        temporary = tempfile.TemporaryDirectory(prefix='content-', dir=fixtures)
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)
        self.roots = [self.base / 'disk-a', self.base / 'disk-b']
        for root in self.roots:
            root.mkdir()
        self.database = self.base / 'work/index.sqlite'

    def write(self, name, data, disk=0):
        path = self.roots[disk] / name
        path.write_bytes(data)
        return path

    def scan(self, enabled=True):
        job = self.base / 'job.json'
        job.write_text(json.dumps({'roots': list(map(str, self.roots)), 'database': str(self.database),
                                  'load': 2, 'content': enabled}), encoding='utf-8')
        process = subprocess.run([str(BINARY), '--job', str(job)], input='', capture_output=True,
                                 text=True, encoding='utf-8', timeout=60)
        self.assertEqual(process.returncode, 0, process.stdout + process.stderr)
        return json.loads(process.stdout.splitlines()[-1])

    def test_formatted_docx_markdown_unicode_and_plain_text(self):
        secret = 'PRIVATE_CONTENT_MARKER Привет мир'
        self.write('one.txt', (' \t' + secret + '\r\n').encode())
        self.write('two.TXT', secret.encode('utf-16'), 1)
        self.write('three.md', '# PRIVATE_CONTENT_MARKER **Привет**\nмир'.encode())
        self.write('four.docx', docx('<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>PRIVATE_CONTENT_MARKER Привет</w:t></w:r>'
                   '<w:r><w:t xml:space="preserve">  мир</w:t></w:r></w:p>'), 1)
        self.write('five.docx', docx('<x:p><x:r><x:t>PRIVATE_CONTENT_MARKER Привет мир</x:t></x:r></x:p>', prefix='x'))
        self.write('different.txt', (secret + '!').encode())
        result = self.scan()
        self.assertTrue(result['report']['complete'])
        self.assertEqual(result['report']['statistics']['total']['duplicates'], 0)
        self.assertEqual(result['content']['warning_pairs'], {'text': 10, 'image': 0})
        self.assertEqual(result['content']['files']['ready'], 6)
        for warning in result['content']['warnings']:
            self.assertEqual(warning['status'], 'warn')
            self.assertEqual(len(warning['files']), 2)
        self.assertNotIn(secret, json.dumps(result, ensure_ascii=False))
        self.assertNotIn(secret.encode(), self.database.read_bytes())
        self.assertNotIn('one.txt', json.dumps(result['content']))

    def test_content_off_exact_only_and_repeated_scan_clears_warnings(self):
        self.write('a.txt', b'hello world')
        self.write('b.txt', b'hello world')
        self.write('c.md', b'**hello** world', 1)
        enabled = self.scan()
        self.assertEqual(enabled['content']['warning_pairs']['text'], 2)
        self.assertEqual(enabled['report']['statistics']['total']['duplicates'], 1)
        disabled = self.scan(False)
        self.assertEqual(disabled['report'], enabled['report'])
        self.assertEqual(disabled['content']['warnings'], [])
        self.assertFalse(disabled['content']['enabled'])
        with closing(sqlite3.connect(self.database)) as db:
            self.assertEqual(db.execute("SELECT count(*) FROM sqlite_master WHERE name='content_matches'").fetchone()[0], 0)

    def test_empty_text_binary_text_and_unsupported_formats(self):
        self.write('empty.txt', b'')
        self.write('blank.md', b' \n\t')
        self.write('bad.txt', b'hello\x00world')
        self.write('bad-utf8.txt', b'\xc0\xaf')
        self.write('page.md', b'<b>Hello</b>')
        self.write('image.md', b'![hello](local.png)')
        self.write('file.pdf', b'%PDF-1.7 synthetic')
        result = self.scan()['content']
        self.assertEqual(result['files']['empty'], 2)
        self.assertEqual(result['files']['invalid'], 2)
        self.assertEqual(result['files']['unsupported'], 3)
        self.assertEqual(result['warnings'], [])

    def test_docx_corruption_protection_and_non_text_features(self):
        valid = docx('<w:p><w:r><w:t>Hello</w:t></w:r></w:p>')
        self.write('plain.txt', b'Hello')
        self.write('truncated.docx', valid[:-15])
        self.write('bad-xml.docx', docx('<w:p>'))
        self.write('ole.docx', bytes.fromhex('d0cf11e0a1b11ae1') + b'EncryptedPackage')
        encrypted = bytearray(valid)
        for signature, offset in [(b'PK\x03\x04', 6), (b'PK\x01\x02', 8)]:
            start = 0
            while (start := encrypted.find(signature, start)) >= 0:
                encrypted[start + offset] |= 1
                start += 4
        self.write('encrypted.docx', encrypted)
        self.write('drawing.docx', docx('<w:p><w:r><w:t>Hello</w:t><w:drawing/></w:r></w:p>'))
        self.write('field.docx', docx('<w:p><w:fldSimple><w:r><w:t>Hello</w:t></w:r></w:fldSimple></w:p>'))
        self.write('entity.docx', docx('<w:p><w:r><w:t>Hello</w:t></w:r></w:p>', extra={
            'word/document.xml': f'<!DOCTYPE document [<!ENTITY file SYSTEM "file:///private">]><w:document xmlns:w="{W}"><w:body><w:p><w:r><w:t>&file;</w:t></w:r></w:p></w:body></w:document>'}))
        result = self.scan()['content']
        self.assertEqual(result['files']['protected'], 2)
        self.assertEqual(result['files']['invalid'], 2)
        self.assertEqual(result['files']['unsupported'], 3)
        self.assertEqual(result['warnings'], [])

    def test_headers_and_footnotes_are_not_silently_ignored(self):
        body = '<w:p><w:r><w:t>Hello</w:t></w:r></w:p>'
        for suffix, footer in [('a', 'First'), ('b', 'Second')]:
            self.write(suffix + '.docx', docx(body, extra={
                'word/_rels/document.xml.rels': f'<Relationships xmlns="{R}"><Relationship Id="r1" Type="{REL}footer" Target="footer1.xml"/></Relationships>',
                'word/footer1.xml': f'<w:ftr xmlns:w="{W}"><w:p><w:r><w:t>{footer}</w:t></w:r></w:p></w:ftr>'}))
        self.assertEqual(self.scan()['content']['warnings'], [])

    def test_png_exif_orientation_and_alpha(self):
        width, height = 40, 24
        raw = bytes(channel for y in range(height) for x in range(width) for channel in (x*5, y*9, 40, 255))
        rotated = bytes(channel for y in range(width) for x in range(height)
                        for channel in raw[((height-1-x)*width+y)*4:((height-1-x)*width+y)*4+4])
        # TIFF IFD: count=1, tag=orientation, type=SHORT, count=1, value=6, next=0.
        exif = b'II*\0' + struct.pack('<IHHHIHHI', 8, 1, 0x112, 3, 1, 6, 0, 0)
        self.write('exif.png', png(width, height, raw, exif))
        self.write('rotated.png', png(height, width, rotated), 1)
        self.write('transparent-red.png', png(8, 8, bytes((255, 0, 0, 0))*64))
        self.write('transparent-blue.png', png(8, 8, bytes((0, 0, 255, 0))*64))
        self.write('opaque-blue.png', png(8, 8, bytes((0, 0, 255, 255))*64))
        self.assertEqual(self.scan()['content']['warning_pairs']['image'], 2)

    def test_limits_and_png_crc_prevent_false_matches(self):
        self.write('huge.txt', b'a' * (8*1024*1024+1))
        oversized = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 100000, 100000, 8, 6, 0, 0, 0))
        self.write('huge.png', oversized)
        self.write('corrupt.png', png(1, 1, b'\0\0\0\xff')[:-1] + b'!')
        self.write('unknown.docx', b'not a zip')
        result = self.scan()['content']
        self.assertEqual(result['files']['limit'], 2)
        self.assertEqual(result['files']['invalid'], 2)
        self.assertEqual(result['warnings'], [])

    def test_invalid_xml_entities_and_embedded_math_do_not_match_plain_text(self):
        for index, entity in enumerate(['&unknown;', '&#0;', '&#x110000;', '&#xD800;']):
            self.write(f'invalid-{index}.docx', docx(f'<w:p><w:r><w:t>Hello{entity}</w:t></w:r></w:p>'))
        self.write('math.docx', docx('<w:p><w:r><w:t>Hello</w:t></w:r>'
                   '<m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><m:r><m:t>x</m:t></m:r></m:oMath></w:p>'))
        self.write('plain.txt', b'Hello')
        result = self.scan()['content']
        self.assertEqual(result['files']['invalid'], 4)
        self.assertEqual(result['files']['unsupported'], 1)
        self.assertEqual(result['warnings'], [])

    def test_xml_entities_cdata_and_archive_limits(self):
        self.write('a.docx', docx('<w:p><!-- comment & text --><w:r><w:t>A &amp; B</w:t></w:r></w:p>'))
        self.write('b.docx', docx('<w:p><w:r><w:t><![CDATA[A & B]]></w:t></w:r></w:p>'))
        self.write('large.docx', docx('<w:p><w:r><w:t>' + 'a'*(8*1024*1024) + '</w:t></w:r></w:p>'))
        self.write('traversal.docx', docx('<w:p><w:r><w:t>A &amp; B</w:t></w:r></w:p>', extra={'../outside': 'no extraction'}))
        result = self.scan()['content']
        self.assertEqual(result['warning_pairs']['text'], 1)
        self.assertEqual(result['files']['limit'], 1)
        self.assertEqual(result['files']['invalid'], 1)
        self.assertFalse((self.base / 'outside').exists())

    def test_unicode_file_and_percent_encoded_package_path(self):
        body = '<w:p><w:r><w:t>Hello world</w:t></w:r></w:p>'
        self.write('документ.docx', docx(body, extra={
            '_rels/.rels': f'<Relationships xmlns="{R}"><Relationship Id="r1" Type="{REL}officeDocument" Target="word/main%20file.xml"/></Relationships>',
            '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/main file.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
            'word/main file.xml': f'<w:document xmlns:w="{W}"><w:body>{body}</w:body></w:document>'}))
        self.write('копия.txt', b'Hello world', 1)
        self.assertEqual(self.scan()['content']['warning_pairs']['text'], 1)


if __name__ == '__main__':
    unittest.main()
