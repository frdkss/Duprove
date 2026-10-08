import { expect, test } from '@playwright/test'

test('Автослайд, ручное управление и остановка при фокусе', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.clock.install()
  await page.route('**/src/config/screenshots.ts', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: `export const screenshots = [{ src: 'favicon.svg?first', alt: 'Первое тестовое изображение' }, { src: 'favicon.svg?second', alt: 'Второе тестовое изображение' }]; export const slideshowInterval = 5000;`,
    }),
  )
  await page.route('https://api.github.com/repos/**/releases**', (route) =>
    route.fulfill({ status: route.request().url().endsWith('/latest') ? 404 : 200, json: [] }),
  )
  await page.goto('/')
  await expect(page.getByRole('img', { name: 'Первое тестовое изображение' })).toBeVisible()
  await page.clock.runFor(5600)
  await expect(page.getByRole('img', { name: 'Второе тестовое изображение' })).toBeVisible()
  await page.getByRole('button', { name: 'Предыдущий скриншот' }).click()
  await page.clock.runFor(600)
  await expect(page.getByRole('img', { name: 'Первое тестовое изображение' })).toBeVisible()
  await page.mouse.move(0, 0)
  await page.clock.runFor(5500)
  await expect(page.getByRole('img', { name: 'Первое тестовое изображение' })).toBeVisible()
  await page.getByRole('button', { name: 'Остановить автослайд' }).click()
  await page.getByRole('link', { name: 'Duprove — в начало' }).focus()
  await page.mouse.move(0, 0)
  await page.clock.runFor(5500)
  await expect(page.getByRole('img', { name: 'Первое тестовое изображение' })).toBeVisible()
})
