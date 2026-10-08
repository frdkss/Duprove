export default function showStartupMessage() {
  const sourceEntry = document.querySelector('script[src$="/src/main.tsx"]')
  const viteClient = document.querySelector('script[src*="/@vite/client"]')
  const message = document.getElementById('startup-message')
  const help = document.getElementById('startup-help')

  if (!sourceEntry || viteClient || !message || !help) return

  message.textContent =
    'Исходный сайт запускается через Vite. Live Server не обрабатывает React и TypeScript.'
  help.hidden = false
}

showStartupMessage()
