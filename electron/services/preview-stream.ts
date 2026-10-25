import { open } from 'node:fs/promises'
import { Readable } from 'node:stream'

export async function previewResponse(request: Request, file: string, mime: string): Promise<Response> {
  const headers = new Headers({ 'Content-Type': mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Range', 'X-Content-Type-Options': 'nosniff' })
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers })
  if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 })
  const handle = await open(file, 'r')
  try {
    const { size } = await handle.stat()
    let start = 0, end = size - 1, status = 200
    const range = request.headers.get('range')
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range)
      if (!match || !size || !match[1] && !match[2]) throw Error('INVALID_RANGE')
      if (!match[1]) { start = Math.max(0, size - Number(match[2])); if (!Number(match[2])) throw Error('INVALID_RANGE') }
      else { start = Number(match[1]); end = match[2] ? Math.min(size - 1, Number(match[2])) : size - 1 }
      if (!Number.isSafeInteger(start) || start < 0 || start >= size || end < start) throw Error('INVALID_RANGE')
      status = 206; headers.set('Content-Range', `bytes ${start}-${end}/${size}`)
    }
    headers.set('Content-Length', String(Math.max(0, end - start + 1)))
    if (request.method === 'HEAD' || !size) { await handle.close(); return new Response(null, { status, headers }) }
    const stream = handle.createReadStream({ start, end, autoClose: true, signal: request.signal })
    return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { status, headers })
  } catch (error) {
    const { size } = await handle.stat().catch(() => ({ size: 0 }))
    await handle.close()
    if (error instanceof Error && error.message === 'INVALID_RANGE') {
      headers.set('Content-Range', `bytes */${size}`)
      return new Response(null, { status: 416, headers })
    }
    throw error
  }
}
