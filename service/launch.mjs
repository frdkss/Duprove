import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, openSync, writeSync, closeSync, readFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

export async function launch({ root, mode, execute } = {}) {
  if (!['--log', '--no-logs'].includes(mode)) throw new Error('Неизвестный режим запуска')
  let log, logPath, child
  let interrupted = false
  const output = chunk => {
    if (log === undefined) return
    writeSync(log, chunk)
    process.stdout.write(chunk)
  }
  const run = execute ?? ((executable, args, env, stage, { windowsHide = true } = {}) => new Promise((done, fail) => {
    let tail = ''
    child = spawn(executable, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide })
    const capture = chunk => {
      tail = (tail + chunk).slice(-16000)
      output(chunk)
    }
    child.stdout.setEncoding('utf8').on('data', capture)
    child.stderr.setEncoding('utf8').on('data', capture)
    child.once('error', fail)
    child.once('close', (code, signal) => {
      child = undefined
      if (interrupted) return fail(new Error('Запуск прерван'))
      if (code === 0) return done()
      fail(new Error(`${stage}: код ${code ?? signal}.\n${tail.trim()}`))
    })
  }))
  const interrupt = () => { interrupted = true; child?.kill() }
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', interrupt)
  try {
    if (mode === '--log') {
      const directory = join(root, 'service/logs')
      mkdirSync(directory, { recursive: true })
      logPath = join(directory, `run-${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${randomUUID()}.log`)
      log = openSync(logPath, 'wx')
      output(`[service] log-file: ${logPath}\n`)
    }
    const require = createRequire(join(root, 'package.json'))
    const electronDirectory = dirname(require.resolve('electron/package.json'))
    const pathFile = join(electronDirectory, 'path.txt')
    if (!existsSync(pathFile)) throw new Error('Electron runtime не установлен. Выполните service.bat 1.')
    const electron = resolve(electronDirectory, 'dist', readFileSync(pathFile, 'utf8').trim())
    for (const file of [electron, join(root, 'node_modules/typescript/bin/tsc'), join(root, 'node_modules/vite/bin/vite.js')]) {
      if (!existsSync(file)) throw new Error('Не найдены зависимости. Выполните service.bat 1.')
    }
    const env = { ...process.env, PATH: `${dirname(process.execPath)}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}` }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.ELECTRON_ENABLE_LOGGING
    delete env.ELECTRON_LOG_FILE
    output('[service] Сборка Duprove: C++, TypeScript, React, Electron…\n')
    await run(process.execPath, [join(root, 'service/build-desktop.mjs')], env, 'Сборка')
    if (interrupted) throw new Error('Запуск прерван')
    output('[service] Запуск Duprove…\n')
    await run(electron, ['--disable-logging', root], env, 'Electron', { windowsHide: false })
    output('[service] Приложение закрыто. Код выхода: 0.\n')
  } catch (error) {
    const message = `Ошибка запуска Duprove: ${error.message}\n`
    if (log !== undefined) output(message)
    else process.stderr.write(message)
    throw error
  } finally {
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', interrupt)
    if (log !== undefined) closeSync(log)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 3 || !['--log', '--no-logs'].includes(process.argv[2] ?? '--no-logs')) {
    console.error('Использование: node service/launch.mjs [--log|--no-logs]')
    process.exitCode = 1
  } else {
    try { await launch({ root: resolve(fileURLToPath(new URL('../', import.meta.url))), mode: process.argv[2] ?? '--no-logs' }) }
    catch { process.exitCode = 1 }
  }
}
