import { readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { isConsentChange, STATISTICS_NOTICE_VERSION, type ConsentDecision, type ConsentSnapshot } from '../../contracts/consent'
import { writeLocalJson } from './local-json'

export interface ConsentAuthorization { grantId: string; signal: AbortSignal }
export interface Consent { current(): ConsentAuthorization | null }
interface StoredConsent {
  version: 1
  noticeVersion: number
  decision: Exclude<ConsentDecision, 'not-decided'>
  grantId: string | null
}
export const isGrantId = (value: unknown): value is string => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)

function isStoredConsent(value: unknown): value is StoredConsent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  // Notice v2 changes the default, not the reported fields. Preserve existing v1 choices.
  const knownNotice = record.noticeVersion === STATISTICS_NOTICE_VERSION
    || (record.noticeVersion === 1 && record.decision !== 'default-enabled')
  return Object.keys(record).length === 4 && record.version === 1 && knownNotice
    && (record.decision === 'granted' || record.decision === 'default-enabled'
      ? isGrantId(record.grantId) : record.decision === 'declined' && record.grantId === null)
}

export class ConsentService implements Consent {
  private decision: ConsentDecision = 'not-decided'
  private authorization: ConsentAuthorization | null = null
  private controller: AbortController | null = null
  private persistenceError = false

  constructor(private readonly file: string) {
    try {
      const record: unknown = JSON.parse(readFileSync(file, 'utf8'))
      if (!isStoredConsent(record)) return // Invalid/unsupported records must never be replaced by the default.
      this.decision = record.decision
      if (record.grantId) this.authorize(record.grantId)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.save({ version: 1, noticeVersion: STATISTICS_NOTICE_VERSION,
          decision: 'default-enabled', grantId: randomUUID() })
      } else this.persistenceError = true
    }
  }

  snapshot(): ConsentSnapshot {
    return { decision: this.decision, noticeVersion: STATISTICS_NOTICE_VERSION, persistenceError: this.persistenceError }
  }

  current(): ConsentAuthorization | null { return this.authorization }

  set(request: unknown): ConsentSnapshot {
    if (!isConsentChange(request)) throw new Error('INVALID_CONSENT_REQUEST')
    if (request.enabled && this.authorization) return this.snapshot()
    // Stop pending/in-flight work before any disk operation, including a failed save.
    if (!request.enabled) {
      this.authorization = null
      this.decision = 'declined'
      this.controller?.abort()
      this.controller = null
    }
    this.save({ version: 1, noticeVersion: STATISTICS_NOTICE_VERSION,
      decision: request.enabled ? 'granted' : 'declined', grantId: request.enabled ? randomUUID() : null })
    return this.snapshot()
  }

  private save(record: StoredConsent): void {
    try {
      writeLocalJson(this.file, record)
      this.persistenceError = false
      this.decision = record.decision
      if (record.grantId) this.authorize(record.grantId)
    } catch {
      this.persistenceError = true
      // Keep a denial on disk: deleting the file would re-enable the default on restart.
      // A partial fallback write is also safe: invalid JSON never authorizes sending.
      if (record.decision === 'declined') {
        try {
          writeFileSync(this.file, JSON.stringify(record), { encoding: 'utf8', mode: 0o600, flush: true })
          this.persistenceError = false
        } catch { /* UI reports that persistence failed. */ }
      }
    }
  }

  private authorize(grantId: string): void {
    this.controller = new AbortController()
    this.authorization = { grantId, signal: this.controller.signal }
  }
}
