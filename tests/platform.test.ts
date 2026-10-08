import { describe, expect, it } from 'vitest'
import detectOperatingSystem from '../src/lib/detectOperatingSystem'
import detectAssetPlatform from '../src/lib/detectAssetPlatform'
import isInstallableAsset from '../src/lib/isInstallableAsset'

describe('Определение ОС', () => {
  it.each([
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'windows'],
    ['Mozilla/5.0 (X11; Linux x86_64)', 'linux'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'macos'],
    ['Mozilla/5.0 (Linux; Android 15)', 'unknown'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', 'unknown'],
    ['Mozilla/5.0 (X11; CrOS x86_64)', 'unknown'],
    ['', 'unknown'],
  ])('%s → %s', (userAgent, expected) => {
    expect(detectOperatingSystem({ userAgent })).toBe(expected)
  })

  it('Не определяет iPad в режиме компьютера как macOS', () => {
    expect(
      detectOperatingSystem({ userAgent: 'Macintosh', platform: 'MacIntel', maxTouchPoints: 5 }),
    ).toBe('unknown')
  })

  it('Читает Client Hints', () => {
    expect(detectOperatingSystem({ userAgent: '', userAgentData: { platform: 'Windows' } })).toBe(
      'windows',
    )
  })
})

describe('Сборки для каждой ОС', () => {
  it.each([
    ['duprove_windows_ARM64.exe', 'windows'],
    ['Duprove-win-x64.zip', 'windows'],
    ['Duprove-x86.msi', 'windows'],
    ['Duprove_linux_AMD64.tar.gz', 'linux'],
    ['Duprove-aarch64.AppImage', 'linux'],
    ['duprove_amd64.deb', 'linux'],
    ['duprove-x64.rpm', 'linux'],
    ['duprove-darwin-arm64.tar.gz', 'macos'],
    ['duprove-macos.zip', 'macos'],
    ['duprove.zip', 'unknown'],
    ['duprove.tar.gz', 'unknown'],
  ])('%s → %s', (filename, expected) => {
    expect(detectAssetPlatform(filename)).toBe(expected)
  })

  it.each([
    'SHA256SUMS',
    'duprove.exe.sha256',
    'duprove.exe.sig',
    'duprove-windows-debug.zip',
    'duprove-linux-source.tar.gz',
  ])('Не предлагает служебный файл %s как установку', (filename) => {
    expect(isInstallableAsset(filename)).toBe(false)
  })
})
