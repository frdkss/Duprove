import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'

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
