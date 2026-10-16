import { access, chmod, copyFile, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { constants, createReadStream } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import os from 'node:os'
import type { UpdateHost, UpdateTarget } from './update-manifest'
import { writeLocalJson } from './local-json'

const execute = promisify(execFile)
const linuxMarker = 'Duprove managed installation v1'
const windowsMarker = 'Duprove NSIS per-user v1'
export async function installedUpdateHost(executable: string, packaged: boolean): Promise<UpdateHost | null> {
  if (!packaged || !['win32', 'linux'].includes(process.platform) || !['x64', 'arm64'].includes(process.arch)) return null
  const directory = path.dirname(executable)
  try {
    if ((await lstat(directory)).isSymbolicLink()) return null
    const marker = (await readFile(path.join(directory, '.duprove-managed'), 'utf8')).trim()
    if (marker !== (process.platform === 'win32' ? windowsMarker : linuxMarker)) return null
    await access(directory, constants.W_OK); await access(path.dirname(directory), constants.W_OK)
    if (process.platform === 'linux' && process.getuid?.() === 0) return null
    const report = process.platform === 'linux' ? process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } : null
    return { platform: process.platform, arch: process.arch, format: process.platform === 'win32' ? 'nsis' : 'tar.gz',
      osVersion: os.release().split('-')[0], glibc: report?.header?.glibcVersionRuntime }
  } catch { return null }
}
export async function verifyPackage(file: string, target: Pick<UpdateTarget, 'size' | 'sha512'>) {
  const stat = await lstat(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== target.size) throw Error('UPDATE_SIZE_INVALID')
  const hash = createHash('sha512')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  if (hash.digest('hex') !== target.sha512) throw Error('UPDATE_HASH_INVALID')
}
async function noLinks(directory: string) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || !entry.isFile() && !entry.isDirectory()) throw Error('UPDATE_LINK_INVALID')
    if (entry.isDirectory()) await noLinks(path.join(directory, entry.name))
  }
}
interface Options { directory: string; executable: string; helperDirectory: string; shutdown(): Promise<void> }
export class PackageUpdateInstaller {
  private transaction?: Record<string, unknown>
  constructor(private options: Options) {}
  async prepare(file: string, version: string, target: UpdateTarget) {
    await verifyPackage(file, target)
    const directory = await realpath(this.options.directory)
    const destination = await realpath(path.dirname(this.options.executable))
    // The updater and the profile must live outside the replaced application directory.
    const relative = path.relative(destination, directory)
    if (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)) throw Error('UPDATE_PROFILE_LOCATION_INVALID')
    if (process.platform === 'linux') {
      const stage = path.join(directory, 'stage')
      await rm(stage, { recursive: true, force: true }); await mkdir(stage, { mode: 0o700 })
      const listing = await execute('/usr/bin/tar', ['-tzf', file], { maxBuffer: 8 * 1024 ** 2, timeout: 60000 })
      if (!listing.stdout.trim() || listing.stdout.split('\n').some(name => name && (name.startsWith('/') || name.split('/').includes('..')))) throw Error('UPDATE_ARCHIVE_INVALID')
      await execute('/usr/bin/tar', ['-xzf', file, '--no-same-owner', '--no-same-permissions', '-C', stage], { timeout: 120000, maxBuffer: 4096 })
      // electron-builder's tar target has a single versioned top-level directory.
      let source = stage
      try { await access(path.join(source, 'duprove')) } catch {
        const entries = await readdir(stage)
        if (entries.length !== 1) throw Error('UPDATE_ARCHIVE_INVALID')
        source = path.join(stage, entries[0])
      }
      await noLinks(source)
      await access(path.join(source, 'duprove'), constants.X_OK)
      await access(path.join(source, 'resources/analyzer/duprove-analyzer'), constants.X_OK)
      await access(path.join(source, 'resources/app.asar'))
      await writeFile(path.join(source, '.duprove-managed'), linuxMarker + '\n', { mode: 0o600 })
      this.transaction = { source }
    } else this.transaction = {}
    Object.assign(this.transaction, { schema: 1, version, token: randomBytes(24).toString('hex'),
      parentPid: process.pid, target: destination, executable: path.basename(this.options.executable),
      package: file, sha512: target.sha512, directory })
  }
  async install() {
    if (!this.transaction) throw Error('UPDATE_NOT_PREPARED')
    const { directory } = this.options
    for (const name of ['armed', 'ready', 'result.json']) await rm(path.join(directory, name), { force: true })
    writeLocalJson(path.join(directory, 'transaction.json'), this.transaction)
    const windows = process.platform === 'win32'
    const helper = path.join(directory, windows ? 'install.ps1' : 'install.sh')
    await copyFile(path.join(this.options.helperDirectory, windows ? 'update-windows.ps1' : 'update-linux.sh'), helper)
    await chmod(helper, 0o700)
    // All arguments are separate argv entries. No shell interpolation of user paths.
    const command = windows ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe') : '/bin/bash'
    const args = windows ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, '-Transaction', path.join(directory, 'transaction.json')]
      : [helper, directory, String(this.transaction.parentPid), String(this.transaction.target), String(this.transaction.source), String(this.transaction.token)]
    // Windows PowerShell can exit 0 without executing -File with DETACHED_PROCESS.
    // Windows children outlive the parent with ignored handles + unref; POSIX needs setsid.
    // A GUI started from pwsh can inherit PS7 module paths too. The PS5 helper
    // needs its own modules for Get-FileHash and JSON/file operations.
    const env = windows ? Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'PSMODULEPATH')) : process.env
    const child = spawn(command, args, { detached: !windows, stdio: 'ignore', windowsHide: true, env })
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
    child.unref()
    // Never quit the working app until the independent installer has checked its inputs.
    for (let i = 0; i < 300; i++) {
      let armed = false
      try { armed = (await readFile(path.join(directory, 'armed'), 'utf8')).trim() === this.transaction.token } catch {}
      if (armed) { await this.options.shutdown(); return }
      if (child.exitCode !== null) throw Error('UPDATE_HELPER_FAILED')
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    child.kill(); throw Error('UPDATE_HELPER_TIMEOUT')
  }
}
export async function acknowledgeUpdate(directory: string, version: string) {
  try {
    const transaction = JSON.parse(await readFile(path.join(directory, 'transaction.json'), 'utf8'))
    if (transaction.schema === 1 && transaction.version === version && /^[a-f0-9]{48}$/.test(transaction.token)
      && path.relative(transaction.target, path.dirname(process.execPath)) === '') {
      await writeFile(path.join(directory, 'ready'), transaction.token, { mode: 0o600 })
    }
  } catch { /* A normal startup has no update transaction. */ }
}
