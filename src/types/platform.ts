export type OperatingSystem = 'windows' | 'linux' | 'macos' | 'unknown'

export interface BrowserPlatform {
  userAgent: string
  platform?: string
  maxTouchPoints?: number
  userAgentData?: { platform: string }
}
