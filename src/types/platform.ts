export type OperatingSystem = 'windows' | 'linux' | 'macos-intel' | 'macos-arm' | 'unknown'

export interface BrowserPlatform {
  userAgent: string
  platform?: string
  maxTouchPoints?: number
  userAgentData?: {
    platform: string
    getHighEntropyValues?: (hints: string[]) => Promise<{ architecture?: string }>
  }
}
