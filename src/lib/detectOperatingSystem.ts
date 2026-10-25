import type { BrowserPlatform, OperatingSystem } from '../types/platform'

export default function detectOperatingSystem(
  browser: BrowserPlatform,
  architecture = '',
  renderer = '',
): OperatingSystem {
  const identity = `${browser.userAgentData?.platform ?? ''} ${browser.platform ?? ''} ${browser.userAgent}`
  if (/Android|iPhone|iPad|iPod|CrOS/i.test(identity)) return 'unknown'
  if (/Mac/i.test(identity) && (browser.maxTouchPoints ?? 0) > 1) return 'unknown'
  if (/Windows|Win32|Win64/i.test(identity)) return 'windows'
  if (/Mac/i.test(identity)) {
    if (/^(arm|arm64|aarch64)$/i.test(architecture)) return 'macos-arm'
    if (/^(x86|x86_64|x64|amd64)$/i.test(architecture)) return 'macos-intel'
    if (/arm64|aarch64/i.test(identity) || /Apple (M\d+|Silicon)/i.test(renderer))
      return 'macos-arm'
    if (/Intel|AMD|NVIDIA/i.test(renderer)) return 'macos-intel'
    // Apple Silicon browsers also report "Intel Mac" / "MacIntel" in their user agent.
    return 'unknown'
  }
  if (/Linux|X11/i.test(identity)) return 'linux'
  return 'unknown'
}
