import https from 'node:https'
import type { ClientRequest } from 'node:http'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseEnv } from 'node:util'
import { isGrantId } from './consent-service'
import type { ReportTransport } from './report-service'

export const MAX_REPORT_BYTES = 32 * 1024 * 1024
export class DeliveryError extends Error {
  constructor(readonly code: string, readonly retryable: boolean, readonly retryAfterMs = 0) { super(code); this.name = 'DeliveryError' }
}
export function isDeliveryError(error: unknown): error is DeliveryError {
  if (!(error instanceof Error) || error.name !== 'DeliveryError') return false
  const failure = error as DeliveryError
  return typeof failure.code === 'string' && /^[A-Z_]{1,64}$/.test(failure.code)
    && typeof failure.retryable === 'boolean' && Number.isFinite(failure.retryAfterMs) && failure.retryAfterMs >= 0
}
export interface TransportSettings { url: string; ca?: string; timeoutMs?: number }

export function validateEndpoint(value: string): URL {
  let url: URL
  try { url = new URL(value) } catch { throw new DeliveryError('INVALID_ENDPOINT', false) }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || url.pathname !== '/v1/reports') throw new DeliveryError('INVALID_ENDPOINT', false)
  return url
}

// Development reads only these two .env values. Packaged apps never read a cwd .env.
// No public endpoint is assumed: an unconfigured build stays local.
export function readTransportSettings(root: string, packaged: boolean, environment = process.env): TransportSettings | null {
  let local: Record<string, string | undefined> = {}
  if (!packaged) {
    try { local = parseEnv(readFileSync(resolve(root, '.env'), 'utf8')) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new DeliveryError('INVALID_ENDPOINT', false) }
  }
  const url = environment.DUPROVE_REPORT_URL ?? local.DUPROVE_REPORT_URL
  if (!url) return null
  const endpoint = validateEndpoint(url)
  const certificate = environment.DUPROVE_CA_FILE ?? local.DUPROVE_CA_FILE
  let ca: string | undefined
  if (certificate) {
    // A development CA is allowed only on loopback, never for an external server.
    if (packaged || !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)) throw new DeliveryError('INVALID_ENDPOINT', false)
    try { ca = readFileSync(resolve(root, certificate), 'utf8') }
    catch { throw new DeliveryError('INVALID_CERTIFICATE', false) }
  }
  return { url: endpoint.href, ca }
}

export class HttpsReportTransport implements ReportTransport {
  private readonly url: URL
  constructor(private readonly settings: TransportSettings) { this.url = validateEndpoint(settings.url) }
  send(json: string, { signal, reportId }: { signal: AbortSignal; reportId?: string }): Promise<void> {
    if (!isGrantId(reportId)) return Promise.reject(new DeliveryError('INVALID_REPORT_ID', false))
    const bytes = Buffer.byteLength(json)
    if (bytes > MAX_REPORT_BYTES) return Promise.reject(new DeliveryError('REPORT_TOO_LARGE', false))
    if (signal.aborted) return Promise.reject(new DeliveryError('CANCELLED', false))
    return new Promise((resolveRequest, rejectRequest) => {
      let settled = false
      let request: ClientRequest | undefined
      const finish = (error?: DeliveryError) => {
        if (settled) return
        settled = true; clearTimeout(deadline)
        if (error) rejectRequest(error); else resolveRequest()
      }
      // Absolute deadline includes DNS, TLS, upload and a slow/trickling response.
      const deadline = setTimeout(() => request?.destroy(new DeliveryError('DELIVERY_TIMEOUT', true)), this.settings.timeoutMs ?? 60_000)
      try { request = https.request(this.url, {
        method: 'POST', agent: false, signal, ca: this.settings.ca, rejectUnauthorized: true,
        minVersion: 'TLSv1.2', headers: { 'Content-Type': 'application/json', 'Content-Length': bytes,
          'Idempotency-Key': reportId, Connection: 'close' },
      }, response => {
        let size = 0
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > 4096) { request?.destroy(new DeliveryError('INVALID_RESPONSE', true)); return }
          chunks.push(chunk)
        })
        response.on('error', () => finish(new DeliveryError('NETWORK_UNAVAILABLE', true)))
        response.on('aborted', () => finish(new DeliveryError('NETWORK_UNAVAILABLE', true)))
        response.on('end', () => {
          const status = response.statusCode ?? 0
          if (status === 200 || status === 201) {
            try {
              const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
              if (!/^application\/json(?:\s*;|$)/i.test(String(response.headers['content-type']))
                || !body || Object.keys(body).length !== 2 || body.accepted !== true || body.receipt_id !== reportId) throw new Error()
              finish()
            } catch { finish(new DeliveryError('INVALID_RESPONSE', true)) }
          } else {
            const retryable = [408, 429, 500, 502, 503, 504].includes(status)
            const header = response.headers['retry-after']
            const delay = typeof header === 'string' ? (/^\d+$/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now()) : 0
            finish(new DeliveryError(status === 429 ? 'RATE_LIMITED' : status === 413 ? 'REPORT_TOO_LARGE'
              : status === 409 ? 'REPORT_CONFLICT' : retryable ? 'SERVER_UNAVAILABLE' : 'REPORT_REJECTED', retryable,
            Number.isFinite(delay) ? Math.max(0, Math.min(delay, 24 * 3600_000)) : 0))
          }
        })
      })
      request.on('error', (error: NodeJS.ErrnoException) => finish(error instanceof DeliveryError ? error
        : new DeliveryError(signal.aborted ? 'CANCELLED' : /CERT|TLS|SSL|SELF_SIGNED|VERIFY_LEAF/.test(error.code ?? '')
          ? 'TLS_FAILED' : 'NETWORK_UNAVAILABLE', !signal.aborted)))
      request.end(json)
      } catch { request?.destroy(); finish(new DeliveryError('TLS_FAILED', false)) }
    })
  }
}
