import { describe, expect, it } from 'vitest'
import detectOperatingSystem from '../src/lib/detectOperatingSystem'
import detectAssetPlatform from '../src/lib/detectAssetPlatform'
import isInstallableAsset from '../src/lib/isInstallableAsset'

describe('Определение ОС', () => {
  it.each([
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'windows'],
    ['Mozilla/5.0 (X11; Linux x86_64)', 'linux'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'unknown'],
    ['Mozilla/5.0 (Macintosh; arm64 Mac OS X)', 'macos-arm'],
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

  it.each([
    ['arm', 'macos-arm'],
    ['arm64', 'macos-arm'],
    ['x86', 'macos-intel'],
    ['x86_64', 'macos-intel'],
  ])(
    'Выбирает macOS по архитектуре %s, несмотря на Intel в User-Agent',
    (architecture, expected) => {
      expect(
        detectOperatingSystem(
          { userAgent: 'Macintosh; Intel Mac OS X', platform: 'MacIntel' },
          architecture,
        ),
      ).toBe(expected)
    },
  )

  it.each([
    ['ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Pro, Unspecified Version)', 'macos-arm'],
    ['Intel Iris OpenGL Engine', 'macos-intel'],
    ['AMD Radeon Pro 5500M OpenGL Engine', 'macos-intel'],
    ['Apple GPU', 'unknown'],
    ['', 'unknown'],
  ])('Использует доступное имя GPU %s без догадки по MacIntel', (renderer, expected) => {
    expect(
      detectOperatingSystem(
        { userAgent: 'Macintosh; Intel Mac OS X', platform: 'MacIntel' },
        '',
        renderer,
      ),
    ).toBe(expected)
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
    ['duprove-darwin-arm64.tar.gz', 'macos-arm'],
    ['Duprove-2.0.0-macos-64bit-x86_64.pkg', 'macos-intel'],
    ['Duprove-2.0.0-macos-64bit-x86_64.dmg', 'macos-intel'],
    ['Duprove-2.0.0-macos-64bit-arm64.pkg', 'macos-arm'],
    ['Duprove-2.0.0-macos-64bit-arm64.dmg', 'macos-arm'],
    ['Duprove-3.1.0-darwin-aarch64.dmg', 'macos-arm'],
    ['Duprove-macos-amd64.pkg', 'macos-intel'],
    ['duprove-macos.zip', 'unknown'],
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
    'Duprove-macos-arm64.pkg.sha256',
    'Duprove-macos-x86_64.dmg.sig',
    'Duprove-macos-arm64-debug.pkg',
  ])('Не предлагает служебный файл %s как установку', (filename) => {
    expect(isInstallableAsset(filename)).toBe(false)
  })

  it.each(['Duprove-macos-x86_64.pkg', 'Duprove-macos-arm64.dmg'])(
    'Предлагает установщик %s',
    (filename) => expect(isInstallableAsset(filename)).toBe(true),
  )
})
