import { createHash, randomUUID } from 'node:crypto'
import { open, readdir } from 'node:fs/promises'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import type { DeliverySnapshot } from '../../contracts/delivery'
import { isGrantId, type Consent } from './consent-service'
import { sendReport, validatePrepared, type PreparedReport, type ReportTransport } from './report-service'
import { DeliveryError, isDeliveryError, MAX_REPORT_BYTES } from './report-transport'
import { writeLocalJson } from './local-json'

type Status = 'pending' | 'sending' | 'sent' | 'failed' | 'excluded'
interface RecordState {
  version: 1; id: string; fingerprint: string; status: Status; attempts: number
  firstAttemptAt: number | null; nextAttemptAt: number; error: string | null
}
interface Entry { file: string; stateFile: string; grant: string | null; record: RecordState }
export const RETRY_DELAYS = [60_000, 5 * 60_000, 30 * 60_000, 6 * 3600_000]
export const DELIVERY_WINDOW = 24 * 3600_000
const MAX_ENVELOPE_BYTES = MAX_REPORT_BYTES + 4096
const terminal = (status: Status) => ['sent', 'failed', 'excluded'].includes(status)

async function readBounded(file: string, maximum: number): Promise<string> {
  const handle = await open(file, 'r')
  try {
    const buffer = Buffer.alloc(maximum + 1)
    let size = 0
    while (size < buffer.length) {
      const chunk = await handle.read(buffer, size, buffer.length - size, null)
      if (!chunk.bytesRead) break
      size += chunk.bytesRead
    }
    if (size > maximum) throw new DeliveryError('REPORT_TOO_LARGE', false)
    return buffer.subarray(0, size).toString('utf8')
  } finally { await handle.close() }
}
async function preparedFile(file: string): Promise<{ prepared: PreparedReport; raw: string }> {
  const raw = await readBounded(file, MAX_ENVELOPE_BYTES)
  const prepared: unknown = JSON.parse(raw)
  validatePrepared(prepared)
  return { prepared, raw }
}
const fingerprint = (name: string, raw: string) => createHash('sha256').update(name).update('\0').update(raw).digest('hex')
function validRecord(value: unknown, digest: string): value is RecordState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as RecordState
  return Object.keys(record).length === 8 && record.version === 1 && isGrantId(record.id) && record.fingerprint === digest
    && ['pending', 'sending', 'sent', 'failed', 'excluded'].includes(record.status)
    && Number.isInteger(record.attempts) && record.attempts >= 0 && record.attempts <= 5
    && (record.firstAttemptAt === null ? record.attempts === 0 : Number.isSafeInteger(record.firstAttemptAt) && record.firstAttemptAt >= 0)
    && Number.isSafeInteger(record.nextAttemptAt) && record.nextAttemptAt >= 0
    && (record.error === null || typeof record.error === 'string' && /^[A-Z_]{1,64}$/.test(record.error))
}

// One instance per profile, owned by main alongside the sole ConsentService.
// Source envelopes are never changed, retagged or deleted by the sender.
export class DeliveryService extends EventEmitter {
  private entries = new Map<string, Entry>()
  private revision = 0
  private error: string | null
  private timer?: ReturnType<typeof setTimeout>
  private running: Promise<void> | null = null
  private scanning: Promise<void> | null = null
  private stopped = false
  private controller = new AbortController()
  private nextNetworkAt = 0
  constructor(private readonly directory: string, private readonly consent: Consent,
    private readonly transport: ReportTransport | null, configurationError: string | null = null,
    private readonly now = Date.now, private readonly spacingMs = 12_000) {
    super(); this.error = configurationError
  }
  snapshot(): DeliverySnapshot {
    const records = [...this.entries.values()].map(entry => entry.record)
    const pending = records.filter(record => record.status === 'pending')
    const enabled = !!this.consent.current()
    return { revision: this.revision, configured: !!this.transport, enabled,
      pending: pending.length, sending: records.some(record => record.status === 'sending'),
      sent: records.filter(record => record.status === 'sent').length,
      failed: records.filter(record => record.status === 'failed').length,
      excluded: records.filter(record => record.status === 'excluded').length,
      nextAttemptAt: enabled && this.transport && pending.length ? Math.max(this.nextNetworkAt, Math.min(...pending.map(record => record.nextAttemptAt))) : null,
      error: this.error }
  }
  private publish() { this.revision++; this.emit('snapshot', this.snapshot()) }
  private sourceFile(file: string) { return path.join(this.directory, 'delivery-sources', path.basename(file)) }
  private persist(entry: Entry): boolean {
    try {
      writeLocalJson(entry.stateFile, entry.record)
      // Link the rolling source to its last attempt across process restarts.
      writeLocalJson(this.sourceFile(entry.file), { version: 1, grant: entry.grant, record: entry.record })
      return true
    }
    catch { entry.record.status = 'failed'; entry.record.error = 'DELIVERY_SAVE_FAILED'; this.error = 'DELIVERY_SAVE_FAILED'; return false }
  }
  refresh(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    if (this.scanning) return this.scanning.then(() => this.refresh())
    this.scanning = this.scan().catch(() => { this.error = 'DELIVERY_READ_FAILED' }).finally(() => {
      this.scanning = null; this.consentChanged()
    })
    return this.scanning
  }
  private async scan() {
    let names: string[]
    try { names = await readdir(path.join(this.directory, 'reports')) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    for (const name of names) {
      if (this.stopped) return
      if (!name.endsWith('.json') || !isGrantId(name.slice(0, -5))) continue
      const file = path.join(this.directory, 'reports', name)
      try {
        const { prepared, raw } = await preparedFile(file)
        const digest = fingerprint(name, raw)
        let previous = this.entries.get(name)
        if (previous?.record.fingerprint === digest || previous?.record.status === 'sending') continue
        if (!previous) {
          try {
            const source: unknown = JSON.parse(await readBounded(this.sourceFile(file), 4096))
            if (!source || typeof source !== 'object' || Array.isArray(source)) throw Error()
            const saved = source as { version: number; grant: string | null; record: RecordState }
            if (Object.keys(saved).length !== 3 || saved.version !== 1 || saved.grant !== null && !isGrantId(saved.grant)
              || !saved.record || typeof saved.record.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(saved.record.fingerprint)
              || !validRecord(saved.record, saved.record.fingerprint)) throw Error()
            if (saved.record.status === 'sending') saved.record.status = 'pending'
            previous = { file, stateFile: '', grant: saved.grant, record: saved.record }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw Error('INVALID_DELIVERY_STATE')
          }
        }
        const stateFile = path.join(this.directory, 'delivery', `${digest}.json`)
        let record: RecordState = { version: 1, id: randomUUID(), fingerprint: digest, status: 'pending',
          attempts: 0, firstAttemptAt: null, nextAttemptAt: 0, error: null }
        // A newer checkpoint supersedes unsent data, preserving network backoff.
        // Its new payload needs a new idempotency key even after a lost response.
        if (previous && previous.grant === prepared.consentGrantId
          && (previous.record.status === 'pending' || previous.record.attempts >= 5)) {
          record = { ...previous.record, id: record.id, fingerprint: digest }
        }
        try {
          const stored: unknown = JSON.parse(await readBounded(stateFile, 4096))
          if (!validRecord(stored, digest)) throw new Error('INVALID_DELIVERY_STATE')
          record = stored
          if (record.status === 'sending') record.status = 'pending' // Attempt was durably counted before sending.
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { record.status = 'failed'; record.error = 'INVALID_DELIVERY_STATE' }
        }
        const entry = { file, stateFile, grant: prepared.consentGrantId, record }
        this.entries.set(name, entry)
        if (record.error !== 'INVALID_DELIVERY_STATE') this.persist(entry)
      } catch (error) {
        this.entries.set(name, { file, stateFile: '', grant: null, record: { version: 1, id: randomUUID(), fingerprint: '',
          status: 'failed', attempts: 0, firstAttemptAt: null, nextAttemptAt: 0,
          error: error instanceof DeliveryError ? error.code : 'INVALID_REPORT' } })
      }
    }
  }
  consentChanged(): void {
    const authorization = this.consent.current()
    for (const entry of this.entries.values()) {
      if (!terminal(entry.record.status) && (!authorization || authorization.grantId !== entry.grant)) {
        entry.record.status = 'excluded'; entry.record.error = null; this.persist(entry)
      }
    }
    this.publish(); this.schedule()
  }
  private schedule() {
    clearTimeout(this.timer)
    if (this.stopped || this.running || !this.transport || !this.consent.current()) return
    const pending = [...this.entries.values()].filter(entry => entry.record.status === 'pending')
    if (!pending.length) return
    const at = Math.max(this.nextNetworkAt, Math.min(...pending.map(entry => entry.record.nextAttemptAt)))
    this.timer = setTimeout(() => {
      this.running = this.attempt().catch(() => { this.error = 'DELIVERY_FAILED' }).finally(() => {
        this.running = null; this.publish(); void this.refresh()
      })
    }, Math.max(0, Math.min(2_147_483_647, at - this.now())))
    this.timer.unref()
  }
  private async attempt() {
    const entry = [...this.entries.values()].find(item => item.record.status === 'pending' && item.record.nextAttemptAt <= this.now())
    if (!entry || !this.transport || this.stopped) return
    const record = entry.record
    if (record.attempts >= 5 || record.firstAttemptAt !== null && this.now() - record.firstAttemptAt >= DELIVERY_WINDOW) {
      record.status = 'failed'; record.error = 'RETRIES_EXHAUSTED'; this.persist(entry); return
    }
    let prepared: PreparedReport
    try {
      const loaded = await preparedFile(entry.file)
      if (fingerprint(path.basename(entry.file), loaded.raw) !== record.fingerprint) { await this.refresh(); return }
      prepared = loaded.prepared
    } catch { record.status = 'failed'; record.error = 'INVALID_REPORT'; this.persist(entry); return }
    if (this.stopped) return
    const authorization = this.consent.current()
    if (!authorization || authorization.grantId !== prepared.consentGrantId) { this.consentChanged(); return }
    record.attempts++; record.firstAttemptAt ??= this.now(); record.status = 'sending'; record.error = null
    // Persist both the attempt and a future retry before any bytes can leave.
    record.nextAttemptAt = this.now() + (RETRY_DELAYS[record.attempts - 1] ?? DELIVERY_WINDOW)
    if (!this.persist(entry)) return
    this.nextNetworkAt = this.now() + this.spacingMs
    this.publish()
    const liveConsent: Consent = { current: () => {
      const current = this.consent.current()
      return current ? { grantId: current.grantId, signal: AbortSignal.any([current.signal, this.controller.signal]) } : null
    } }
    try {
      const sent = await sendReport(prepared, liveConsent, this.transport, record.id)
      record.status = sent ? 'sent' : this.stopped && this.consent.current()?.grantId === entry.grant ? 'pending' : 'excluded'
      record.error = null
    } catch (error) {
      const failure = isDeliveryError(error) ? error : new DeliveryError('NETWORK_UNAVAILABLE', true)
      record.status = failure.retryable && record.attempts < 5 ? 'pending' : 'failed'
      record.error = failure.code
      record.nextAttemptAt = Math.max(record.nextAttemptAt, this.now() + failure.retryAfterMs)
    }
    this.persist(entry)
  }
  async stop(): Promise<void> {
    this.stopped = true; clearTimeout(this.timer); this.controller.abort()
    await this.scanning; await this.running
  }
}
