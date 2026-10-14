import { spawnSync } from 'node:child_process'
import { existsSync, chmodSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const requested = process.argv[2] ?? process.platform
if (process.argv.length > 3 || requested !== process.platform || !['win32', 'linux', 'darwin'].includes(requested)
  || !['x64', 'arm64'].includes(process.arch)) {
  throw Error('Package on the target OS and architecture: win32, linux or darwin; x64 or arm64.')
}
const localCmake = resolve(root, '.venv/Scripts/cmake.exe')
const cmake = process.platform === 'win32' && existsSync(localCmake) ? localCmake : 'cmake'
const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', windowsHide: true })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
run(cmake, ['-S', 'native', '-B', 'build/native', '-DCMAKE_BUILD_TYPE=Release',
  ...(process.platform === 'darwin' ? [`-DCMAKE_OSX_ARCHITECTURES=${process.arch === 'x64' ? 'x86_64' : 'arm64'}`] : [])])
run(cmake, ['--build', 'build/native', '--config', 'Release', '--parallel', '2'])
run(process.execPath, ['scripts/build-icons.mjs'])
run(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit'])
run(process.execPath, ['node_modules/vite/bin/vite.js', 'build'])
run(process.execPath, ['scripts/build-electron.mjs'])
run(process.execPath, ['scripts/build-installer-resources.mjs'])
if (process.platform === 'linux') chmodSync(resolve(root, 'installer/linux/install.sh'), 0o755)
run(process.execPath, ['node_modules/electron-builder/cli.js', `--${{win32:'win',linux:'linux',darwin:'mac'}[requested]}`, `--${process.arch}`, '--publish', 'never'])
