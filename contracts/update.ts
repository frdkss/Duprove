// Public, read-only state. No URLs, local paths, reports or installer commands cross IPC.
export type UpdateStatus = 'unavailable' | 'idle' | 'checking' | 'downloading' | 'waiting' | 'scheduled' | 'installing' | 'error'
export interface UpdateSnapshot {
  revision: number
  status: UpdateStatus
  currentVersion: string
  availableVersion: string | null
  percent: number | null
  restartAt: number | null
  nextCheckAt: number | null
  error: string | null
}
