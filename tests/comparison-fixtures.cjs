const JSZip = require('jszip')
const XLSX = require('xlsx')
const UTIF = require('utif')
const fs = require('node:fs/promises')
const path = require('node:path')

function pdf() {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 500] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
  for (const page of [1, 2]) {
    if (page === 2) objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 500] /Resources << /Font << /F1 4 0 R >> >> /Contents 7 0 R >>')
    const text = `BT /F1 18 Tf 30 430 Td (Comparison PDF page ${page}) Tj ET\n`
    objects.push(`<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}endstream`)
  }
  let output = '%PDF-1.4\n', offsets = [0]
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(output)); output += `${i + 1} 0 obj\n${object}\nendobj\n` })
  const xref = Buffer.byteLength(output)
  output += `xref\n0 ${offsets.length}\n0000000000 65535 f \n` + offsets.slice(1).map(n => String(n).padStart(10, '0') + ' 00000 n \n').join('')
  return Buffer.from(output + `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)
}
function wav() {
  const rate = 8000, count = rate * 2, bytes = Buffer.alloc(44 + count * 2)
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8)
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36); bytes.writeUInt32LE(count * 2, 40)
  for (let i = 0; i < count; i++) bytes.writeInt16LE(Math.round(Math.sin(i / rate * Math.PI * 2 * 440) * 1000), 44 + i * 2)
  return bytes
}
async function fixtures() {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
  zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
  zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Comparison Word document</w:t></w:r></w:p><w:p><w:r><w:t>Unicode: Привет</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>')
  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Name', 'Value'], ['Comparison sheet', 42], ...Array.from({ length: 110 }, (_, i) => [`Row ${i}`, i])]), 'First')
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Second sheet marker', 99]]), 'Second')
  const data = {
    'source.py': Buffer.from('print("Привет")\n<script>globalThis.PREVIEW_EXECUTED=true</script>\n'),
    'data.json': Buffer.from('{"literal":"<script>globalThis.PREVIEW_EXECUTED=true</script>"}'),
    'document.pdf': pdf(), 'sound.wav': wav(),
    'image.png': Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
    'image.svg': Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60"><rect width="80" height="60" fill="#397fc9"/><script>globalThis.PREVIEW_EXECUTED=true</script></svg>'),
    'image.tiff': Buffer.from(UTIF.encodeImage(new Uint8Array([220, 60, 90, 255, 30, 150, 90, 255]).buffer, 2, 1)),
    'document.docx': await zip.generateAsync({ type: 'nodebuffer' }),
    'legacy.doc': await fs.readFile(path.join(__dirname, 'fixtures/comparison/legacy.doc')),
    'document.rtf': Buffer.from('{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Arial;}}\\f0\\fs24 Comparison RTF document\\par Second paragraph}'),
  }
  for (const type of ['xlsx', 'xls', 'ods']) data[`table.${type}`] = XLSX.write(book, { type: 'buffer', bookType: type })
  return data
}
module.exports = { fixtures }
