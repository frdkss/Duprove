import type { OperatingSystem } from '../types/platform'

export default function detectAssetPlatform(filename: string): OperatingSystem {
  const name = filename.toLowerCase()
  if (/(macos|darwin|osx|\.dmg$|\.pkg$)/.test(name)) return 'macos'
  if (/(windows|(?:^|[._-])win(?:32|64)?(?:[._-]|$)|\.exe$|\.msi$|\.msix$)/.test(name))
    return 'windows'
  if (/(linux|\.appimage$|\.deb$|\.rpm$)/.test(name)) return 'linux'
  return 'unknown'
}
