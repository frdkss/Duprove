import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('../', import.meta.url)))
const localCmake = join(root, '.venv/Scripts/cmake.exe')
const cmake = existsSync(localCmake) ? localCmake : 'cmake'
const commands = [
  [process.execPath, ['scripts/build-icons.mjs']],
  [cmake, ['-S', 'native', '-B', 'build/native']],
  [cmake, ['--build', 'build/native', '--config', 'Release']],
  [process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit']],
  [process.execPath, ['node_modules/vite/bin/vite.js', 'build']],
  [process.execPath, ['scripts/build-electron.mjs']],
]
for (const [executable, args] of commands) {
  const result = spawnSync(executable, args, { cwd: root, stdio: 'inherit', windowsHide: true })
  if (result.error) {
    console.error(`Не удалось запустить ${executable}. Выполните service.bat 1.`)
    process.exit(1)
  }
  if (result.status !== 0) process.exit(result.status ?? 1)
}
