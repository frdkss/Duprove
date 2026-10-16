import { mkdir, readFile, writeFile } from 'node:fs/promises'

const notice = await readFile(new URL('../docs/statistics-notice.txt', import.meta.url), 'utf8')
const escape = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
const paragraphs = notice.trim().split(/\r?\n\s*\r?\n/).map(text => `<p>${escape(text).replace(/\r?\n/g, '<br>')}</p>`).join('\n')
const directory = new URL('../build/installer/', import.meta.url)
await mkdir(directory, { recursive: true })
await writeFile(new URL('macos-welcome.html', directory), `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><title>Duprove — данные и конфиденциальность</title>
<style>body{font:13px -apple-system,Helvetica,sans-serif;line-height:1.45;padding:12px}p{margin:0 0 14px}</style></head>
<body><h1>Установка Duprove</h1>${paragraphs}</body></html>\n`, 'utf8')
