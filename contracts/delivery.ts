// Local UI state, never part of the public statistics report.
export interface DeliverySnapshot {
  revision: number
  configured: boolean
  enabled: boolean
  pending: number
  sending: boolean
  sent: number
  failed: number
  excluded: number
  nextAttemptAt: number | null
  error: string | null
}
