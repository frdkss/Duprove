import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'

test('Несколько вопросов, свой ответ, возврат и завершение без отправки', async ({ page }) => {
  const questions = [
    {
      id: 'first',
      title: 'Первый тестовый вопрос',
      options: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
        { id: 'c', label: 'C' },
      ],
    },
    {
      id: 'second',
      title: 'Второй тестовый вопрос',
      options: [
        { id: 'yes', label: 'Да' },
        { id: 'no', label: 'Нет' },
      ],
    },
  ]
  await page.route('**/src/config/survey.ts', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: `export const surveyQuestions = ${JSON.stringify(questions)}`,
    }),
  )
  await page.route('https://api.github.com/repos/**/releases**', (route) =>
    route.fulfill({ status: route.request().url().endsWith('/latest') ? 404 : 200, json: [] }),
  )
  await page.goto('/')
  const survey = page.getByRole('region', { name: 'Анонимный опрос' })
  await expect(survey.getByRole('button', { name: 'Далее' })).toBeDisabled()
  await survey.getByRole('radio', { name: 'A', exact: true }).check()
  await expect(survey.getByRole('button', { name: 'Далее' })).toBeEnabled()
  await survey.screenshot({ path: '.verification/survey-desktop.png' })
  await survey.getByRole('button', { name: 'Далее' }).click()
  await expect(survey.getByText('Вопрос 2 из 2')).toBeVisible()
  await survey.getByRole('textbox', { name: 'Свой ответ' }).fill('   ')
  await expect(survey.getByRole('button', { name: 'Завершить' })).toBeDisabled()
  await survey.getByRole('textbox', { name: 'Свой ответ' }).fill('Тестовый ответ')
  await survey.getByRole('button', { name: 'Назад' }).click()
  await expect(survey.getByRole('radio', { name: 'A', exact: true })).toBeChecked()
  await survey.getByRole('textbox', { name: 'Свой ответ' }).fill('Другой ответ')
  await expect(survey.getByRole('radio', { name: 'A', exact: true })).not.toBeChecked()
  await survey.getByRole('button', { name: 'Далее' }).click()
  await expect(survey.getByRole('textbox', { name: 'Свой ответ' })).toHaveValue('Тестовый ответ')
  await page.setViewportSize({ width: 320, height: 740 })
  await survey.screenshot({ path: '.verification/survey-mobile.png' })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await survey.getByRole('button', { name: 'Завершить' }).click()
  await expect(
    survey.getByText('Отправка пока не подключена. Ответы никуда не переданы.'),
  ).toBeVisible()
  await survey.getByRole('button', { name: 'Начать заново' }).click()
  await expect(survey.getByText('Вопрос 1 из 2')).toBeVisible()
  await expect(survey.getByRole('button', { name: 'Далее' })).toBeDisabled()
})

test('При открытии исходного HTML без Vite есть пояснение вместо пустой страницы', async ({
  page,
}) => {
  const source = await readFile('index.html', 'utf8')
  await page.route('**/raw-index.html', (route) =>
    route.fulfill({ contentType: 'text/html', body: source }),
  )
  await page.route('**/src/main.tsx', (route) => route.abort())
  await page.goto('/raw-index.html')
  await expect(
    page.getByText(
      'Исходный сайт запускается через Vite. Live Server не обрабатывает React и TypeScript.',
    ),
  ).toBeVisible()
  await expect(page.getByRole('link', { name: 'Открыть сайт на Vite' })).toHaveAttribute(
    'href',
    'http://127.0.0.1:5173/',
  )
})
