import type { OperatingSystem } from '../types/platform'

export default function detectAssetPlatform(filename: string): OperatingSystem {
  const name = filename.toLowerCase()
  if (/(macos|darwin|osx|\.dmg$|\.pkg$)/.test(name)) {
    if (/(?:^|[._-])(arm64|aarch64|arm)(?:[._-]|$)/.test(name)) return 'macos-arm'
    if (/(?:^|[._-])(x86_64|x86-64|amd64|x64|intel)(?:[._-]|$)/.test(name)) return 'macos-intel'
    return 'unknown'
  }
  if (/(windows|(?:^|[._-])win(?:32|64)?(?:[._-]|$)|\.exe$|\.msi$|\.msix$)/.test(name))
    return 'windows'
  if (/(linux|\.appimage$|\.deb$|\.rpm$)/.test(name)) return 'linux'
  return 'unknown'
}
