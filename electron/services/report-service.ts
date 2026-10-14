import { serializeReport } from '../../contracts/validate'


export interface ReportTransport { send(json: string): Promise<void> }
export interface Consent { current(): boolean }
export async function sendReport(report: unknown, consent: Consent, transport: ReportTransport): Promise<boolean> {
  const payload = serializeReport(report)
  if (!consent.current()) return false
  await transport.send(payload)
  return true
}
