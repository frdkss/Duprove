import { expect, test } from '@playwright/test'
import release from '../fixtures/release'

test('Макет, пустые релизы, выбор ОС и навигация', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route('https://api.github.com/repos/**/releases**', (route) =>
    route.fulfill({ status: route.request().url().endsWith('/latest') ? 404 : 200, json: [] }),
  )
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Duprove', exact: true })).toBeVisible()
  await expect(page.getByText('Первый релиз ещё впереди')).toBeVisible()
  await page.screenshot({ path: '.verification/desktop.png', fullPage: true })
  await page.getByRole('combobox', { name: 'Ваша ОС' }).selectOption('macos')
  await expect(
    page.getByText(
      'На данный момент Duprove не разработан для macOS. Версия для macOS не планируется.',
    ),
  ).toBeVisible()
  await page.getByRole('link', { name: 'Установить', exact: true }).click()
  await expect(page).toHaveURL(/#install$/)
  expect(
    await page.locator('header').evaluate((element) => getComputedStyle(element).position),
  ).toBe('fixed')
  await expect(page.getByRole('link', { name: 'Инструкция', exact: true })).toBeInViewport()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await expect(page.getByText('Первый релиз ещё впереди')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  )
  await page.screenshot({ path: '.verification/mobile.png', fullPage: true })
  expect(errors).toEqual([])
})

test('Реальные поля GitHub превращаются в скачивания', async ({ page }) => {
  const current = release({
    body: '## Изменения\n- Проверка **хеша**\n\n<script>alert(1)</script>',
    assets: [
      {
        id: 1,
        name: 'duprove_windows_ARM64.exe',
        size: 2048,
        browser_download_url:
          'https://github.com/example/project/releases/download/v2.0.0/duprove_windows_ARM64.exe',
      },
      {
        id: 2,
        name: 'duprove_linux_x64.tar.gz',
        size: 4096,
        browser_download_url:
          'https://github.com/example/project/releases/download/v2.0.0/duprove_linux_x64.tar.gz',
      },
      {
        id: 3,
        name: 'duprove_windows_ARM64.exe.sha256',
        size: 128,
        browser_download_url: 'https://github.com/example/project/checksum',
      },
    ],
  })
  const previous = release({ id: 1, tag_name: 'v1.0.0', published_at: '2026-09-01T00:00:00Z' })
  await page.route('https://api.github.com/repos/**/releases**', (route) =>
    route.fulfill({
      json: route.request().url().endsWith('/latest') ? current : [current, previous],
    }),
  )
  await page.goto('/')
  await page.getByRole('combobox').selectOption('windows')
  await expect(
    page.getByRole('link', { name: 'Скачать duprove_windows_ARM64.exe, 2 КБ' }),
  ).toHaveAttribute('href', current.assets[0].browser_download_url)
  await expect(page.getByText('Duprove v1.0.0')).toBeVisible()
  await expect(page.getByText('Для этой ОС сборки не опубликованы.')).toBeVisible()
  await expect(page.getByText('.sha256', { exact: false })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Анонимный опрос' })).toBeVisible()
  await expect(page.getByText('Вопросы появятся позже.')).toBeVisible()
  await page.screenshot({ path: '.verification/releases.png', fullPage: true })
  await page.getByRole('combobox').selectOption('linux')
  await expect(
    page.getByRole('link', { name: 'Скачать duprove_linux_x64.tar.gz, 4 КБ' }),
  ).toHaveAttribute('href', current.assets[1].browser_download_url)
  await expect(page.getByRole('link', { name: /Скачать duprove_windows/ })).toHaveCount(0)
})

test('Повторный запрос после ограничения API', async ({ page }) => {
  await page.route('https://api.github.com/repos/**/releases**', (route) =>
    route.fulfill({ status: 403, json: {} }),
  )
  await page.goto('/')
  await expect(page.getByText(/GitHub временно ограничил запросы/)).toBeVisible()
  await page.unroute('https://api.github.com/repos/**/releases**')
  await page.route('https://api.github.com/repos/**/releases**', (route) =>
    route.fulfill({ status: route.request().url().endsWith('/latest') ? 404 : 200, json: [] }),
  )
  await page.getByRole('button', { name: 'Повторить', exact: true }).click()
  await expect(page.getByText('Первый релиз ещё впереди')).toBeVisible()
})

test('Дубликат повторяется, основное слово остаётся и пауза работает', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.route('https://api.github.com/repos/**/releases**', (route) =>
    route.fulfill({ status: route.request().url().endsWith('/latest') ? 404 : 200, json: [] }),
  )
  await page.goto('/')
  await expect(page.locator('.animated-title__original')).toHaveText('Duprove')
  const samples = await page.evaluate(async () => {
    const values: {
      original: string | null
      copy: string | null
      selected: boolean
      tooltip: string
      overflow: boolean
    }[] = []
    for (let index = 0; index < 200; index += 1) {
      values.push({
        original: document.querySelector('.animated-title__original')!.textContent,
        copy: document.querySelector('.animated-title__copy')!.textContent,
        selected: document
          .querySelector('.animated-title__duplicate')!
          .classList.contains('is-selected'),
        tooltip: getComputedStyle(document.querySelector('.animated-title__tooltip')!).visibility,
        overflow: document.documentElement.scrollWidth > innerWidth,
      })
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
    return values
  })
  expect(samples.every((sample) => sample.original === 'Duprove')).toBe(true)
  expect(
    samples.some(
      (sample) => sample.copy === 'Duprove' && sample.selected && sample.tooltip === 'visible',
    ),
  ).toBe(true)
  expect(samples.some((sample) => sample.copy === '')).toBe(true)
  expect(samples.every((sample) => !sample.overflow)).toBe(true)
  await page.getByRole('button', { name: 'Приостановить анимацию заголовка' }).click()
  const pausedText = await page.locator('.animated-title__copy').textContent()
  await page.waitForTimeout(600)
  await expect(page.locator('.animated-title__copy')).toHaveText(pausedText ?? '')
  await page.setViewportSize({ width: 320, height: 740 })
  await page.getByRole('button', { name: 'Включить анимацию заголовка' }).click()
  await expect(page.locator('.animated-title__copy')).toHaveText('Duprove', { timeout: 8000 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: '.verification/mobile-animation.png', fullPage: true })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(page.locator('.animated-title__original')).toHaveText('Duprove')
  await expect(page.locator('.animated-title__copy')).toHaveText('')
  await expect(page.getByRole('button', { name: /анимацию заголовка/ })).not.toBeVisible()
})
