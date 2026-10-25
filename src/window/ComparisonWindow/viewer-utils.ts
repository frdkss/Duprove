export function decodeEditorText(bytes: Uint8Array): { text: string; encoding: string } {
  let encoding = 'utf-8'
  if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'utf-16le'
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'utf-16be'
  else if (bytes.length > 8) {
    const sample = bytes.subarray(0, 4096)
    let even = 0, odd = 0
    sample.forEach((value, i) => { if (!value) { if (i % 2) odd++; else even++ } })
    if (odd > sample.length / 4 && even < sample.length / 20) encoding = 'utf-16le'
    else if (even > sample.length / 4 && odd < sample.length / 20) encoding = 'utf-16be'
  }
  let text: string
  try { text = new TextDecoder(encoding, { fatal: true }).decode(bytes) }
  catch { encoding = 'windows-1251'; text = new TextDecoder(encoding).decode(bytes) }
  const controls = [...text.slice(0, 32768)].filter(char => /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(char)).length
  if (controls > 0) throw Error('BINARY_FILE')
  return { text, encoding }
}
// Inspect the central directory before allowing a document parser to inflate ZIP parts.
export function checkArchiveBudget(bytes: Uint8Array, maximum = 128 * 1024 ** 2) {
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) return
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let eocd = -1
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 65557); at--) if (data.getUint32(at, true) === 0x06054b50) { eocd = at; break }
  if (eocd < 0) throw Error('INVALID_DOCUMENT')
  const count = data.getUint16(eocd + 10, true)
  let at = data.getUint32(eocd + 16, true), total = 0
  if (count > 8192) throw Error('DOCUMENT_LIMIT')
  for (let i = 0; i < count; i++) {
    if (at + 46 > eocd || data.getUint32(at, true) !== 0x02014b50) throw Error('INVALID_DOCUMENT')
    const size = data.getUint32(at + 24, true)
    total += size
    if (size === 0xffffffff || total > maximum) throw Error('DOCUMENT_LIMIT')
    if (data.getUint16(at + 8, true) & 1) throw Error('PROTECTED_DOCUMENT')
    at += 46 + data.getUint16(at + 28, true) + data.getUint16(at + 30, true) + data.getUint16(at + 32, true)
  }
}
export async function documentBytes(url: string, size: number, signal?: AbortSignal): Promise<Uint8Array> {
  if (size > 64 * 1024 ** 2) throw Error('DOCUMENT_LIMIT')
  const response = await fetch(url, { signal })
  if (!response.ok) throw Error('FILE_UNAVAILABLE')
  const bytes = new Uint8Array(await response.arrayBuffer())
  checkArchiveBudget(bytes)
  return bytes
}
export function viewerError(error: unknown) {
  const code = String(error)
  if (code.includes('BINARY_FILE')) return 'В файле обнаружены двоичные данные. Текстовый редактор не может корректно показать их.'
  if (code.includes('DOCUMENT_LIMIT')) return 'Документ превышает предел размера для этого просмотрщика.'
  if (code.includes('PROTECTED_DOCUMENT') || code.includes('Password')) return 'Документ защищён паролем.'
  return 'Не удалось прочитать содержимое: файл повреждён, изменился или его вариант формата не поддерживается.'
}
