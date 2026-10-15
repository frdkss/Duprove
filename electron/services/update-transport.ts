import https from 'node:https'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { rm } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import type { IncomingMessage } from 'node:http'
import { assetUrl, repository, type UpdateTarget } from './update-manifest'

const allowedHosts = new Set(['api.github.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'])
export function allowedUpdateUrl(value: string): boolean {
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && !u.hash && (!u.port || u.port === '443') && allowedHosts.has(u.hostname) } catch { return false }
}
export class GithubUpdateTransport {
  private async response(url: string, signal: AbortSignal, redirects = 0): Promise<IncomingMessage> {
    if (!allowedUpdateUrl(url) || redirects > 4) throw Error('UPDATE_URL_INVALID')
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const request = https.get(url, { signal, minVersion: 'TLSv1.2', rejectUnauthorized: true,
        headers: { 'User-Agent': 'Duprove-Updater', Accept: new URL(url).hostname === 'api.github.com' ? 'application/vnd.github+json' : 'application/octet-stream', 'Accept-Encoding': 'identity' } }, resolve)
      request.on('error', reject)
      request.setTimeout(30000, () => request.destroy(Error('UPDATE_TIMEOUT')))
    })
    if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
      response.resume()
      if (!response.headers.location) throw Error('UPDATE_HTTP_FAILED')
      return this.response(new URL(response.headers.location, url).href, signal, redirects + 1)
    }
    if (response.statusCode !== 200 || response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
      response.resume(); throw Error('UPDATE_HTTP_FAILED')
    }
    return response
  }
  async bytes(url: string, maximum: number, signal: AbortSignal): Promise<Buffer> {
    const response = await this.response(url, AbortSignal.any([signal, AbortSignal.timeout(60000)]))
    const chunks: Buffer[] = []; let size = 0
    for await (const chunk of response) {
      size += chunk.length
      if (size > maximum) { response.destroy(); throw Error('UPDATE_RESPONSE_TOO_LARGE') }
      chunks.push(chunk)
    }
    return Buffer.concat(chunks)
  }
  async releases(signal: AbortSignal): Promise<unknown> {
    return JSON.parse((await this.bytes(`https://api.github.com/repos/${repository}/releases?per_page=10`, 1024 ** 2, signal)).toString('utf8'))
  }
  async download(version: string, target: UpdateTarget, file: string, signal: AbortSignal, progress: (percent: number) => void): Promise<void> {
    try {
      const response = await this.response(assetUrl(version, target.asset), AbortSignal.any([signal, AbortSignal.timeout(15 * 60000)]))
      const hash = createHash('sha512'); let size = 0
      const meter = new Transform({ transform(chunk, _encoding, callback) {
        size += chunk.length
        if (size > target.size) { callback(Error('UPDATE_SIZE_INVALID')); return }
        hash.update(chunk); progress(Math.floor(size / target.size * 100)); callback(null, chunk)
      } })
      await pipeline(response, meter, createWriteStream(file, { flags: 'wx', mode: 0o600 }), { signal })
      if (size !== target.size || hash.digest('hex') !== target.sha512) throw Error('UPDATE_HASH_INVALID')
    } catch (error) { await rm(file, { force: true }); throw error }
  }
}
