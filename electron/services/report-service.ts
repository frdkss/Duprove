import { readFileSync } from 'node:fs'
import { serializeReport } from '../../contracts/validate'
import type { Report } from '../../contracts/report'
import { isGrantId, type Consent } from './consent-service'
import { writeLocalJson } from './local-json'

// Transport must honor signal, including during retries. Every retry re-enters sendReport.
export interface ReportTransport { send(json: string, options: { signal: AbortSignal }): Promise<void> }
export interface PreparedReport {
  version: 1
  consentGrantId: string | null
  report: Report
}

export function prepareReport(report: unknown, consent: Consent): PreparedReport {
  const copy: Report = JSON.parse(serializeReport(report))
  return { version: 1, consentGrantId: consent.current()?.grantId ?? null, report: copy }
}

function validatePrepared(value: unknown): asserts value is PreparedReport {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_PREPARED_REPORT')
  const item = value as Record<string, unknown>
  if (Object.keys(item).length !== 3 || item.version !== 1 || !('report' in item)
    || (item.consentGrantId !== null && !isGrantId(item.consentGrantId))) throw new Error('INVALID_PREPARED_REPORT')
  serializeReport(item.report)
}

// Store the local envelope once, at report creation. Never retag old reports on retry.
export function savePreparedReport(file: string, prepared: PreparedReport): void {
  validatePrepared(prepared)
  try { writeLocalJson(file, prepared) } catch { throw new Error('REPORT_SAVE_FAILED') }
}

export function loadPreparedReport(file: string): PreparedReport {
  let value: unknown
  try { value = JSON.parse(readFileSync(file, 'utf8')) } catch { throw new Error('REPORT_READ_FAILED') }
  validatePrepared(value)
  return value
}

export async function sendReport(prepared: unknown, consent: Consent, transport: ReportTransport): Promise<boolean> {
  validatePrepared(prepared)
  const payload = serializeReport(prepared.report)
  // No await between the fresh authorization check and handing data to transport.
  const authorization = consent.current()
  if (!authorization || authorization.signal.aborted || authorization.grantId !== prepared.consentGrantId) return false
  try { await transport.send(payload, { signal: authorization.signal }) }
  catch (error) { if (authorization.signal.aborted) return false; throw error }
  return !authorization.signal.aborted
}
