// Optional Windows integration: two real NSIS packages, isolated app identity/profile.
// No release is published, and no existing Duprove installation is touched.
const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs/promises')
const path = require('node:path')
const assert = require('node:assert/strict')
const { randomUUID, createHash } = require('node:crypto')
const { createReadStream } = require('node:fs')
const root = path.resolve(__dirname, '..')
async function run(command, args, options = {}) {
  const child = spawn(command, args, { cwd: root, windowsHide: true, stdio: 'inherit', ...options })
  await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(Error(`CHILD_EXIT_${code}`))) })
}
if (process.argv[2] === '--driver') {
  ;(async () => {
    const childProcess = require('node:child_process')
    const originalSpawn = childProcess.spawn
    childProcess.spawn = (command, args, options) => {
      const child = originalSpawn(command, args, { ...options, stdio: 'inherit' })
      child.once('exit', (code, signal) => console.error('TEST_HELPER_EXIT', code, signal))
      return child
    }
    const { PackageUpdateInstaller } = require('../.verification/tests/electron/services/update-installer.js')
    const input = JSON.parse(await fs.readFile(process.argv[3], 'utf8'))
    const installer = new PackageUpdateInstaller({ directory: input.directory, executable: input.executable,
      helperDirectory: path.join(root, 'installer'), shutdown: async () => process.exit(0) })
    await installer.prepare(input.package, '1.0.1', input.target)
    try { await installer.install() }
    catch (error) {
      try { console.error(await fs.readFile(path.join(input.directory, 'result.json'), 'utf8')) } catch {}
      throw error
    }
  })().catch(e => { console.error(e); process.exitCode = 1 })
} else {
  ;(async () => {
    if (process.platform !== 'win32') throw Error('WINDOWS_ONLY')
    const descriptor = path.join(root, '.verification/stage10-nsis-fixture.json')
    let id
    try { id = JSON.parse(await fs.readFile(descriptor, 'utf8')).id } catch { id = randomUUID() }
    if (!/^[a-f0-9-]{36}$/.test(id)) throw Error('INVALID_TEST_ID')
    const name = `DuproveUpdateTest-${id}`
    const base = path.join(root, '.verification', name)
    const profile = path.join(process.env.APPDATA, name)
    const target = path.join(base, 'installed app')
    const directory = path.join(profile, 'updates')
    await assert.rejects(fs.access(profile), { code: 'ENOENT' })
    await fs.mkdir(base, { recursive: true })
    await fs.writeFile(descriptor, JSON.stringify({ id }))
    let installed = false
    let success = false
    try {
      for (const version of ['1.0.0', '1.0.1']) {
        try { await fs.access(path.join(base, version, `Duprove-${version}-win-x64.exe`)); continue } catch {}
        await run(process.execPath, ['node_modules/electron-builder/cli.js', '--win', 'nsis', '--x64', '--publish', 'never',
          '-c.artifactName=Duprove-${version}-win-x64.${ext}',
          `-c.appId=ru.duprove.update-test.${id}`, `-c.directories.output=${path.join(base, version)}`,
          `-c.extraMetadata.name=${name}`, `-c.extraMetadata.productName=${name}`, `-c.extraMetadata.version=${version}`,
          '-c.nsis.createDesktopShortcut=false', '-c.nsis.createStartMenuShortcut=false', `-c.nsis.uninstallDisplayName=${name}`])
      }
      // NSIS expects /D to contain all remaining text, including spaces.
      const initial = path.join(base, '1.0.0/Duprove-1.0.0-win-x64.exe')
      const install = spawnSync(initial, ['/S', '/currentuser', `/D=${target}`], { windowsHide: true, windowsVerbatimArguments: true })
      if (install.error || install.status !== 0) throw Error('INITIAL_NSIS_FAILED')
      installed = true
      assert.equal((await fs.readFile(path.join(target, '.duprove-managed'), 'utf8')).trim(), 'Duprove NSIS per-user v1')
      await fs.mkdir(directory, { recursive: true })
      const original = JSON.stringify({ version: 1, decision: 'declined', noticeVersion: 2, grantId: null })
      // Use the real consent service to generate a supported saved refusal.
      const { ConsentService } = require('../.verification/tests/electron/services/consent-service.js')
      const consentFile = path.join(profile, 'statistics-consent.json')
      const consent = new ConsentService(consentFile)
      consent.set({ noticeVersion: consent.snapshot().noticeVersion, enabled: false })
      const consentBefore = await fs.readFile(consentFile)
      await fs.writeFile(path.join(profile, 'retained-report.json'), original)
      const packageFile = path.join(base, '1.0.1/Duprove-1.0.1-win-x64.exe')
      const hash = createHash('sha512')
      for await (const chunk of createReadStream(packageFile)) hash.update(chunk)
      const input = { directory, executable: path.join(target, 'Duprove.exe'), package: packageFile,
        target: { platform: 'win32', arch: 'x64', format: 'nsis', size: (await fs.stat(packageFile)).size, sha512: hash.digest('hex') } }
      const inputFile = path.join(base, 'driver.json')
      await fs.writeFile(inputFile, JSON.stringify(input))
      await run(process.execPath, [__filename, '--driver', inputFile])
      let result
      for (let i = 0; i < 1800; i++) {
        try { result = JSON.parse(await fs.readFile(path.join(directory, 'result.json'), 'utf8')); break } catch {}
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      assert.equal(result?.status, 'installed')
      assert.deepEqual(await fs.readFile(consentFile), consentBefore)
      assert.equal(await fs.readFile(path.join(profile, 'retained-report.json'), 'utf8'), original)
      const asar = require('@electron/asar')
      const metadata = JSON.parse(asar.extractFile(path.join(target, 'resources/app.asar'), 'package.json').toString())
      assert.equal(metadata.version, '1.0.1')
      success = true
      console.log('REAL_NSIS_UPDATE_OK: installed 1.0.0 -> 1.0.1; application acknowledged startup; consent/report preserved')
    } finally {
      // Stop only this test's installed app, then remove only its unique installation/profile.
      const stopped = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        "Get-CimInstance Win32_Process -Filter \"Name='Duprove.exe'\" | Where-Object { $_.ExecutablePath -eq $env:DUPROVE_TEST_EXECUTABLE } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"],
      { env: { ...process.env, DUPROVE_TEST_EXECUTABLE: path.join(target, 'Duprove.exe') }, windowsHide: true })
      if (stopped.status !== 0) throw Error('TEST_APP_CLEANUP_FAILED')
      if (installed) await run(path.join(target, 'Uninstall Duprove.exe'), ['/S'])
      const safeBase = path.resolve(root, '.verification') + path.sep
      if (!path.resolve(base).startsWith(safeBase) || path.basename(profile) !== name) throw Error('TEST_CLEANUP_PATH_INVALID')
      await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
      if (success) {
        await fs.rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
        await fs.rm(descriptor)
      }
    }
  })().catch(e => { console.error(e); process.exitCode = 1 })
}
