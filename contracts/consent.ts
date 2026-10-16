// Local desktop API only. These fields never belong to the public report.
export const STATISTICS_NOTICE_VERSION = 2
export type ConsentDecision = 'not-decided' | 'default-enabled' | 'granted' | 'declined'
export interface ConsentSnapshot {
  decision: ConsentDecision
  noticeVersion: number
  persistenceError: boolean
}
export interface ConsentChange { enabled: boolean; noticeVersion: number }

export function isConsentChange(value: unknown): value is ConsentChange {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const request = value as Record<string, unknown>
  return Object.keys(request).length === 2 && typeof request.enabled === 'boolean'
    && request.noticeVersion === STATISTICS_NOTICE_VERSION
}
