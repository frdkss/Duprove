import { expect, test } from '@playwright/test'
import { resolve } from 'node:path'
import { discoverScreenshots } from '../../vite.screenshots'

const screenshots = discoverScreenshots(resolve('public/screenshots'))

test.beforeEach(async ({ page }) => {
  await page.route('https://api.github.com/repos/**/releases**', (route) =>
    route.fulfill({ status: route.request().url().endsWith('/latest') ? 404 : 200, json: [] }),
  )
})

test('Находит все реальные скриншоты и автоматически переключает их каждые 3,5 секунды по кругу', async ({
  page,
}) => {
  test.skip(screenshots.length < 2, 'Для автослайда нужны хотя бы два скриншота')
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  const start = new Date('2026-10-25T00:00:00Z')
  await page.clock.install({ time: start })
  await page.clock.pauseAt(new Date(start.getTime() + 1000))
  await page.goto('/')
  await page.mouse.move(0, 0)
  const gallery = page.getByRole('region', { name: 'Скриншоты Duprove' })
  await expect(gallery.getByRole('img')).toHaveAttribute('src', `/${screenshots[0].src}`)
  await expect(gallery.getByRole('button')).toHaveCount(0)
  await expect(gallery.locator('.gallery__count')).toHaveCount(0)
  await expect
    .poll(() =>
      gallery
        .getByRole('img')
        .evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0),
    )
    .toBe(true)
  await page.clock.runFor(3400)
  await expect(gallery.getByRole('img')).toHaveAttribute('src', `/${screenshots[0].src}`)
  await page.clock.runFor(700)
  await expect(gallery.getByRole('img')).toHaveAttribute('src', `/${screenshots[1].src}`)
  for (let index = 2; index <= screenshots.length; index += 1) {
    await page.clock.runFor(3500)
    await expect(gallery.getByRole('img')).toHaveAttribute(
      'src',
      `/${screenshots[index % screenshots.length].src}`,
    )
  }
})

test('Скриншоты плавно наслаиваются без пустого кадра и продолжают меняться при наведении', async ({
  page,
}) => {
  test.skip(screenshots.length < 2, 'Для переключения нужны хотя бы два скриншота')
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.goto('/')
  const gallery = page.getByRole('region', { name: 'Скриншоты Duprove' })
  await gallery.hover()
  await page.waitForFunction(
    () => {
      const current = document.querySelector<HTMLElement>('.gallery__image[data-active="true"]')
      const opacity = current ? Number(getComputedStyle(current).opacity) : 0
      return (
        document.querySelectorAll('.gallery__image').length === 2 && opacity > 0.1 && opacity < 0.8
      )
    },
    null,
    { timeout: 7000 },
  )
  const [samples] = await Promise.all([
    page.evaluate(async () => {
      const samples: { layers: number; coverage: number; blending: boolean; aligned: boolean }[] =
        []
      const start = performance.now()
      while (performance.now() - start < 1400) {
        const images = Array.from(document.querySelectorAll<HTMLImageElement>('.gallery__image'))
        const opacities = images.map((image) =>
          image.complete && image.naturalWidth > 0 ? Number(getComputedStyle(image).opacity) : 0,
        )
        const first = images[0]?.getBoundingClientRect()
        samples.push({
          layers: images.length,
          coverage: 1 - opacities.reduce((transparent, opacity) => transparent * (1 - opacity), 1),
          blending: opacities.some((opacity) => opacity > 0.1 && opacity < 0.9),
          aligned: images.every((image) => {
            const bounds = image.getBoundingClientRect()
            return (
              first &&
              bounds.top === first.top &&
              bounds.left === first.left &&
              bounds.width === first.width &&
              bounds.height === first.height
            )
          }),
        })
        await new Promise(requestAnimationFrame)
      }
      return samples
    }),
    gallery.screenshot({ path: '.verification/gallery-overlap.png' }),
  ])
  expect(samples.some((sample) => sample.layers === 2 && sample.blending)).toBe(true)
  expect(samples.every((sample) => sample.coverage > 0.99 && sample.aligned)).toBe(true)
  await expect(gallery.locator('.gallery__image')).toHaveCount(1)
  await expect(gallery.getByRole('button')).toHaveCount(0)
})

test('Показывает скриншот целиком на телефоне без горизонтальной прокрутки', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  const gallery = page.getByRole('region', { name: 'Скриншоты Duprove' })
  await expect(gallery.getByRole('img')).toBeVisible()
  expect(
    await gallery.getByRole('img').evaluate((image) => getComputedStyle(image).objectFit),
  ).toBe('contain')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await gallery.screenshot({ path: '.verification/gallery-mobile.png' })
})
