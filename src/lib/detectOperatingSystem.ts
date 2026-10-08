import type { BrowserPlatform, OperatingSystem } from '../types/platform'

export default function detectOperatingSystem(browser: BrowserPlatform): OperatingSystem {
  const identity = `${browser.userAgentData?.platform ?? ''} ${browser.platform ?? ''} ${browser.userAgent}`
  if (/Android|iPhone|iPad|iPod|CrOS/i.test(identity)) return 'unknown'
  if (/Mac/i.test(identity) && (browser.maxTouchPoints ?? 0) > 1) return 'unknown'
  if (/Windows|Win32|Win64/i.test(identity)) return 'windows'
  if (/Mac/i.test(identity)) return 'macos'
  if (/Linux|X11/i.test(identity)) return 'linux'
  return 'unknown'
}
