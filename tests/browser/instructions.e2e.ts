import { expect, test } from '@playwright/test'

const instructionsUrl = 'https://raw.githubusercontent.com/frdkss/Duprove/main/instruction.md'
const markdown =
  '# Инструкция\n\n## Начало работы\n\nВыберите **диски** для анализа.\n\n' +
  Array.from({ length: 18 }, (_, index) =>
    `Абзац ${index + 1}. Проверяйте найденные файлы перед удалением. `.repeat(4),
  ).join('\n\n') +
  '\n\n## Последний раздел\n\nПолный текст загружен из main.\n\n<script>window.instructionScriptRan = true</script>\n\n[Источник](https://github.com/frdkss/Duprove/blob/main/instruction.md)'

test.beforeEach(async ({ page }) => {
  await page.route('https://api.github.com/repos/**/releases**', (route) =>
    route.fulfill({ status: route.request().url().endsWith('/latest') ? 404 : 200, json: [] }),
  )
})

test('Загружает инструкцию при приближении, показывает начало с градиентом и раскрывает по нажатию', async ({
  page,
}) => {
  let requests = 0
  await page.route(instructionsUrl, (route) => {
    requests += 1
    return route.fulfill({ contentType: 'text/plain; charset=utf-8', body: markdown })
  })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Duprove', exact: true })).toBeVisible()
  expect(requests).toBe(0)
  const section = page.locator('#instructions')
  await section.scrollIntoViewIfNeeded()
  const expand = section.getByRole('button', { name: 'Читать инструкцию полностью' })
  await expect(expand).toBeVisible()
  await expect(section.locator('.instructions__content strong')).toHaveText('диски')
  await expect(section.getByText('Полный текст загружен из main.')).toHaveCount(0)
  expect(await section.locator('.instructions__viewport').evaluate((el) => el.clientHeight)).toBe(
    220,
  )
  expect(await expand.evaluate((el) => getComputedStyle(el).backgroundImage)).toContain(
    'linear-gradient',
  )
  await section.screenshot({ path: '.verification/instructions-collapsed.png' })
  await expand.click({ position: { x: 30, y: 30 } })
  await expect(section.getByRole('heading', { name: 'Последний раздел' })).toBeVisible()
  await expect(section.getByText('Полный текст загружен из main.')).toBeVisible()
  await expect(expand).toHaveCount(0)
  expect(requests).toBe(1)
  await expect(section.locator('script')).toHaveCount(0)
  expect(await page.evaluate(() => 'instructionScriptRan' in window)).toBe(false)
})

test('Прямая ссылка #instructions сразу загружает и раскрывает полную инструкцию', async ({
  page,
}) => {
  await page.route(instructionsUrl, (route) =>
    route.fulfill({ contentType: 'text/plain', body: markdown }),
  )
  await page.goto('/#instructions')
  const section = page.locator('#instructions')
  await expect(section.locator('.instructions__reader')).toHaveClass(/is-expanded/)
  await expect(section.getByRole('heading', { name: 'Последний раздел' })).toBeVisible()
  await expect(section.getByRole('button', { name: 'Читать инструкцию полностью' })).toHaveCount(0)
  await expect(section.getByRole('link', { name: 'Инструкция на GitHub' })).toHaveAttribute(
    'href',
    'https://github.com/frdkss/Duprove/blob/main/instruction.md',
  )
  await expect
    .poll(() => section.evaluate((el) => Math.round(el.getBoundingClientRect().top)))
    .toBeGreaterThanOrEqual(100)
})

test('Переход из навигации раскрывает инструкцию, клавиатура работает и на телефоне нет переполнения', async ({
  page,
}) => {
  await page.route(instructionsUrl, (route) =>
    route.fulfill({ contentType: 'text/plain', body: markdown }),
  )
  await page.goto('/')
  await page.getByRole('link', { name: 'Инструкция', exact: true }).click()
  await expect(page).toHaveURL(/#instructions$/)
  await expect(page.locator('.instructions__reader')).toHaveClass(/is-expanded/)
  await expect(
    page.locator('#instructions').getByRole('heading', { name: 'Последний раздел' }),
  ).toBeVisible()
  await page.setViewportSize({ width: 320, height: 740 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.goto('/')
  const expand = page.getByRole('button', { name: 'Читать инструкцию полностью' })
  await page.locator('#instructions').scrollIntoViewIfNeeded()
  await expect(expand).toBeVisible()
  await expand.focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('.instructions__reader')).toHaveClass(/is-expanded/)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('Высота при раскрытии меняется плавно, а не скачком', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.route(instructionsUrl, (route) =>
    route.fulfill({ contentType: 'text/plain', body: markdown }),
  )
  await page.goto('/')
  await page.locator('#instructions').scrollIntoViewIfNeeded()
  await page.getByRole('button', { name: 'Читать инструкцию полностью' }).waitFor()
  const heights = await page.evaluate(async () => {
    const button = document.querySelector<HTMLButtonElement>('.instructions__expand')!
    const viewport = document.querySelector<HTMLElement>('.instructions__viewport')!
    const values = [viewport.getBoundingClientRect().height]
    button.click()
    for (let index = 0; index < 40; index += 1) {
      await new Promise(requestAnimationFrame)
      values.push(viewport.getBoundingClientRect().height)
    }
    return values
  })
  const final = heights.at(-1)!
  expect(final).toBeGreaterThan(500)
  expect(heights.some((height) => height > 225 && height < final - 10)).toBe(true)
})

test('Ошибка загрузки допускает повторный запрос, пустой файл обрабатывается', async ({ page }) => {
  await page.route(instructionsUrl, (route) => route.fulfill({ status: 503, body: '' }))
  await page.goto('/#instructions')
  const section = page.locator('#instructions')
  await expect(
    section.getByText('Не удалось загрузить инструкцию. Попробуйте ещё раз.'),
  ).toBeVisible()
  await page.unroute(instructionsUrl)
  await page.route(instructionsUrl, (route) => route.fulfill({ body: '' }))
  await section.getByRole('button', { name: 'Повторить' }).click()
  await expect(section.getByText('Инструкция пока не заполнена.')).toBeVisible()
})
