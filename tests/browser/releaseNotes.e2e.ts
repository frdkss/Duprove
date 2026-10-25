import { expect, test } from '@playwright/test'
import release from '../fixtures/release'

const macRelease = release({
  tag_name: 'v3.1.0',
  name: 'Duprove v3.1.0',
  html_url: 'https://github.com/example/project/releases/tag/v3.1.0',
  body: '<h1>Новая версия</h1><p>Автоматическое <strong>обновление описания</strong>.</p><ul><li>Новый просмотр</li></ul><script>window.releaseScriptRan = true</script><img src="x" onerror="window.releaseScriptRan = true"><a href="javascript:alert(1)">Опасная ссылка</a>',
  assets: ['x86_64.dmg', 'x86_64.pkg', 'arm64.dmg', 'arm64.pkg', 'arm64.pkg.sha256'].map(
    (suffix, index) => ({
      id: index + 1,
      name: `Duprove-3.1.0-macos-64bit-${suffix}`,
      size: 2048,
      browser_download_url: `https://github.com/example/project/releases/download/v3.1.0/Duprove-3.1.0-macos-64bit-${suffix}`,
    }),
  ),
})

for (const [architecture, option, suffix] of [
  ['x86', 'macos-intel', 'x86_64'],
  ['arm', 'macos-arm', 'arm64'],
]) {
  test(`Автоматически выбирает ${option} и берёт оба установщика из нового релиза`, async ({
    page,
  }) => {
    await page.addInitScript((architecture) => {
      Object.defineProperty(navigator, 'userAgent', {
        value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      })
      Object.defineProperty(navigator, 'platform', { value: 'MacIntel' })
      Object.defineProperty(navigator, 'userAgentData', {
        value: {
          platform: 'macOS',
          getHighEntropyValues: async () => ({ architecture }),
        },
      })
    }, architecture)
    await page.route('https://api.github.com/repos/**/releases**', (route) =>
      route.fulfill({
        json: route.request().url().endsWith('/latest') ? macRelease : [macRelease],
      }),
    )
    await page.goto('/')
    await expect(page.getByRole('combobox', { name: 'Ваша ОС' })).toHaveValue(option)
    const downloads = page.locator('.downloads')
    await expect(downloads.getByRole('link', { name: /^Скачать / })).toHaveCount(2)
    for (const extension of ['pkg', 'dmg']) {
      await expect(
        downloads.getByRole('link', {
          name: `Скачать Duprove-3.1.0-macos-64bit-${suffix}.${extension}, 2 КБ`,
        }),
      ).toHaveAttribute(
        'href',
        `https://github.com/example/project/releases/download/v3.1.0/Duprove-3.1.0-macos-64bit-${suffix}.${extension}`,
      )
    }
    await page
      .getByRole('combobox')
      .selectOption(option === 'macos-arm' ? 'macos-intel' : 'macos-arm')
    await expect(
      downloads.getByRole('link', { name: new RegExp(`Скачать .*${suffix}`) }),
    ).toHaveCount(0)
    await expect(downloads.getByRole('link', { name: /^Скачать / })).toHaveCount(2)
  })
}

test('Показывает HTML-описание актуального релиза, очищает опасную разметку и помещается на телефоне', async ({
  page,
}) => {
  await page.route('https://api.github.com/repos/**/releases**', (route) =>
    route.fulfill({ json: route.request().url().endsWith('/latest') ? macRelease : [macRelease] }),
  )
  await page.goto('/')
  const notes = page.getByRole('region', { name: 'Что нового' })
  await expect(notes.getByRole('link', { name: 'Duprove v3.1.0' })).toHaveAttribute(
    'href',
    macRelease.html_url,
  )
  await expect(notes.getByRole('heading', { name: 'Новая версия' })).toBeVisible()
  await expect(notes.locator('strong')).toHaveText('обновление описания')
  await expect(notes.getByRole('listitem')).toHaveText('Новый просмотр')
  await expect(notes.locator('script, img, [onerror], a[href^="javascript:"]')).toHaveCount(0)
  expect(await page.evaluate(() => 'releaseScriptRan' in window)).toBe(false)
  await page.getByRole('combobox').selectOption('macos-arm')
  await page.setViewportSize({ width: 320, height: 740 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: '.verification/macos-release-mobile.png', fullPage: true })
})

test('Не перезаписывает ручной выбор после запоздавшего определения архитектуры', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'userAgent', { value: 'Macintosh; Intel Mac OS X' })
    Object.defineProperty(navigator, 'userAgentData', {
      value: {
        platform: 'macOS',
        getHighEntropyValues: () =>
          new Promise((resolve) => {
            window.addEventListener(
              'resolve-architecture',
              () => resolve({ architecture: 'arm' }),
              { once: true },
            )
          }),
      },
    })
  })
  await page.route('https://api.github.com/repos/**/releases**', (route) =>
    route.fulfill({ json: route.request().url().endsWith('/latest') ? macRelease : [macRelease] }),
  )
  await page.goto('/')
  await page.getByRole('combobox').selectOption('macos-intel')
  await page.evaluate(() => window.dispatchEvent(new Event('resolve-architecture')))
  await expect(page.getByRole('combobox')).toHaveValue('macos-intel')
  await expect(page.getByRole('link', { name: /Скачать .*x86_64.pkg/ })).toBeVisible()
})

test('Обрабатывает отсутствие описания и повторяет общий запрос из панели релиза', async ({
  page,
}) => {
  await page.route('https://api.github.com/repos/**/releases**', (route) =>
    route.fulfill({ status: 403, json: {} }),
  )
  await page.goto('/')
  const notes = page.getByRole('region', { name: 'Что нового' })
  await expect(notes.getByText(/GitHub временно ограничил запросы/)).toBeVisible()
  await page.unroute('https://api.github.com/repos/**/releases**')
  const empty = release({ body: null })
  await page.route('https://api.github.com/repos/**/releases**', (route) =>
    route.fulfill({ json: route.request().url().endsWith('/latest') ? empty : [empty] }),
  )
  await notes.getByRole('button', { name: 'Повторить' }).click()
  await expect(notes.getByText('У этого релиза пока нет описания.')).toBeVisible()
})
