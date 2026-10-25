const { test } = require('node:test')
const assert = require('node:assert/strict')
const { generateKeyPairSync, sign, createHash } = require('node:crypto')
const { mkdtemp, mkdir, rm, writeFile, readFile } = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const https = require('node:https')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
const { spawnSync } = require('node:child_process')
const { verifyManifest, selectTarget, compareVersions, stableVersion } = require('../.verification/tests/electron/services/update-manifest.js')
const { UpdateService } = require('../.verification/tests/electron/services/update-service.js')
const { verifyPackage, installedUpdateHost, PackageUpdateInstaller } = require('../.verification/tests/electron/services/update-installer.js')
const { allowedUpdateUrl, GithubUpdateTransport } = require('../.verification/tests/electron/services/update-transport.js')
const pair = generateKeyPairSync('ed25519')
const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' })
const target = { platform: 'win32', arch: 'x64', format: 'nsis', minOs: '10.0.19045', asset: 'Duprove-1.1.0-win-x64.exe', size: 3, sha512: createHash('sha512').update('new').digest('hex') }
const host = { platform: 'win32', arch: 'x64', format: 'nsis', osVersion: '10.0.22631' }
const manifest = () => ({ schema: 1, channel: 'stable', version: '1.1.0', dataSchema: 1, targets: [{ ...target }] })
const envelope = (value, key = pair.privateKey) => {
  const payload = Buffer.from(JSON.stringify(value))
  return Buffer.from(JSON.stringify({ payload: payload.toString('base64'), signature: sign(null, payload, key).toString('base64') }))
}
test('version 2 signed update metadata refers to the renamed Windows and Linux installers', async t => {
  const directory = await temporary(t)
  const { makeManifest } = await import('../scripts/release-manifest.mjs')
  const files = ['Duprove-2.0.0-windows-64bit-x86_64.exe', 'Duprove-2.0.0-linux-64bit-x86_64.tar.gz']
  for (const file of files) await writeFile(path.join(directory, file), 'new')
  const signed = await makeManifest(directory, '2.0.0', pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), publicKey)
  const verified = verifyManifest(Buffer.from(JSON.stringify(signed)), publicKey, '2.0.0')
  assert.deepEqual(verified.targets.map(target => target.asset), files)
  assert.ok(verified.targets.every(target => target.sha512 === createHash('sha512').update('new').digest('hex')))
})
async function temporary(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'duprove-update-'))
  t.after(() => rm(dir, { recursive: true, force: true })); return dir
}
test('signed manifest authenticates exact bytes, release identity, format and unique targets', () => {
  assert.deepEqual(verifyManifest(envelope(manifest()), publicKey, '1.1.0'), manifest())
  assert.throws(() => verifyManifest(envelope(manifest(), generateKeyPairSync('ed25519').privateKey), publicKey, '1.1.0'), /SIGNATURE/)
  const corrupt = JSON.parse(envelope(manifest())); corrupt.payload = Buffer.from('changed').toString('base64')
  assert.throws(() => verifyManifest(Buffer.from(JSON.stringify(corrupt)), publicKey, '1.1.0'), /SIGNATURE/)
  for (const change of [m => m.channel = 'beta', m => m.version = '2.0.0', m => m.targets.push(m.targets[0]), m => m.targets[0].asset = '../payload.exe', m => m.targets[0].format = 'zip', m => m.targets[0].size = 2 ** 40, m => m.targets[0].minOs = 'unknown']) {
    const m = manifest(); change(m); assert.throws(() => verifyManifest(envelope(m), publicKey, '1.1.0'))
  }
})
test('compatibility rejects architecture, installation, OS, libc and data schema mismatch', () => {
  const m = manifest(); assert.deepEqual(selectTarget(m, host), target)
  for (const patch of [{ arch: 'arm64' }, { format: 'portable' }, { osVersion: '6.1.7601' }, { platform: 'darwin' }, { osVersion: 'unknown' }]) assert.equal(selectTarget(m, { ...host, ...patch }), undefined)
  assert.equal(selectTarget({ ...m, dataSchema: 2 }, host), undefined)
  const linux = { ...target, platform: 'linux', format: 'tar.gz', minOs: '5.15.0', minGlibc: '2.35' }
  const linuxHost = { ...host, platform: 'linux', format: 'tar.gz', osVersion: '6.8.0', glibc: '2.39' }
  assert.deepEqual(selectTarget({ ...m, targets: [linux] }, linuxHost), linux)
  for (const glibc of [undefined, '2.31', 'musl']) assert.equal(selectTarget({ ...m, targets: [linux] }, { ...linuxHost, glibc }), undefined)
  for (const v of ['1.0.0-beta', '01.0.0', '1.0', 'v1.0.0', '1.0.0+build']) assert.equal(stableVersion(v), false)
  assert.ok(compareVersions('1.10.0', '1.9.99') > 0)
})
async function fixture(t, overrides = {}) {
  const directory = await temporary(t)
  let now = 1000000, busy = false, requests = 0, downloads = 0, installs = 0, notices = 0
  const options = { directory, version: '1.0.0', publicKey, host,
    transport: { releases: async () => { requests++; return [{ tag_name: 'v1.1.0', draft: false, prerelease: false }] },
      bytes: async () => envelope(manifest()), download: async (_v, _target, file, _signal, progress) => { downloads++; await writeFile(file, 'new'); progress(100) } },
    installer: { prepare: verifyPackageAdapter, install: async () => { installs++ } },
    busy: () => busy, notify: () => { notices++ }, now: () => now, ...overrides }
  async function verifyPackageAdapter(file, _version, t) { await verifyPackage(file, t) }
  const service = new UpdateService(options); t.after(() => service.stop())
  return { service, options, setBusy: value => busy = value, advance: ms => now += ms, counts: () => ({ requests, downloads, installs, notices }) }
}
test('download is independent of analysis; paused/running work postpones restart and resets notice', async t => {
  const f = await fixture(t); f.setBusy(true)
  await f.service.start()
  assert.equal(f.service.snapshot().status, 'waiting')
  f.advance(120000); await f.service.tick(); assert.equal(f.counts().installs, 0)
  f.setBusy(false); await f.service.tick(); assert.equal(f.service.snapshot().status, 'scheduled')
  f.advance(59000); await f.service.tick(); assert.equal(f.counts().installs, 0)
  f.setBusy(true); f.advance(2000); await f.service.tick(); assert.equal(f.service.snapshot().restartAt, null)
  f.setBusy(false); await f.service.tick(); f.advance(60000); await f.service.tick()
  assert.equal(f.counts().installs, 1); assert.equal(f.counts().notices, 2)
  assert.equal(f.service.blocksAnalysis, true)
  await f.service.tick(); assert.equal(f.counts().installs, 1)
  assert.equal(JSON.stringify(f.service.snapshot()).includes(f.options.directory), false)
})
test('failed request and retry budget survive app restart; no busy loop while offline', async t => {
  let requests = 0
  const f = await fixture(t, { transport: { releases: async () => { requests++; throw Error('offline PRIVATE PATH') } } })
  await f.service.start(); assert.equal(f.service.snapshot().status, 'error')
  await Promise.all([f.service.tick(), f.service.tick()]); assert.equal(requests, 1)
  assert.equal(f.service.snapshot().error, 'UPDATE_FAILED')
  await f.service.stop()
  const second = new UpdateService(f.options); t.after(() => second.stop()); await second.start(); assert.equal(requests, 1)
  f.advance(60000); await second.tick(); assert.equal(requests, 2)
  assert.equal(second.snapshot().nextCheckAt, 1000000 + 60000 + 5 * 60000)
})
test('stable channel skips drafts, previews, older versions and incompatible packages', async t => {
  const f = await fixture(t)
  f.options.transport.releases = async () => [
    { tag_name: 'v3.0.0', draft: true, prerelease: false }, { tag_name: 'v4.0.0', draft: false, prerelease: true },
    { tag_name: 'v1.0.0', draft: false, prerelease: false }, { tag_name: 'v2.0.0-beta', draft: false, prerelease: false },
    { tag_name: 'v1.1.0', draft: false, prerelease: false }]
  f.options.host = { ...host, osVersion: '6.1.7601' }
  await f.service.start(); assert.equal(f.service.snapshot().status, 'idle'); assert.equal(f.counts().downloads, 0)
})
test('failed startup quarantines that version across restarts', async t => {
  const f = await fixture(t)
  await writeFile(path.join(f.options.directory, 'result.json'), JSON.stringify({ schema: 1, status: 'rolled-back' }))
  await writeFile(path.join(f.options.directory, 'transaction.json'), JSON.stringify({ version: '1.1.0' }))
  await f.service.start(); assert.equal(f.counts().downloads, 0)
  assert.deepEqual(JSON.parse(await readFile(path.join(f.options.directory, 'blocked.json'))), { version: '1.1.0' })
})
test('invalid signature never downloads or starts installer', async t => {
  const f = await fixture(t); f.options.transport.bytes = async () => Buffer.from('{}')
  await f.service.start(); assert.equal(f.service.snapshot().status, 'error'); assert.equal(f.counts().downloads, 0)
})
test('helper failure releases start/resume lock and preserves current app', async t => {
  const f = await fixture(t); f.options.installer.install = async () => { throw Error('helper') }
  await f.service.start(); await f.service.tick(); f.advance(60000); await f.service.tick()
  assert.equal(f.service.blocksAnalysis, false); assert.equal(f.service.snapshot().status, 'error')
})
test('integrity and installation checks reject modified package and unpackaged app', async t => {
  const dir = await temporary(t), file = path.join(dir, 'payload')
  await writeFile(file, 'new'); await verifyPackage(file, target)
  await writeFile(file, 'bad'); await assert.rejects(verifyPackage(file, target), /HASH/)
  await writeFile(file, 'truncated'); await assert.rejects(verifyPackage(file, target), /SIZE/)
  assert.equal(await installedUpdateHost(process.execPath, false), null)
  assert.equal(await installedUpdateHost(process.execPath, true), null)
})
test('transport permits only HTTPS GitHub hosts and never URL credentials', () => {
  for (const url of ['http://github.com/x', 'https://github.com.evil.test/x', 'https://user:secret@github.com/x', 'https://127.0.0.1/x', 'https://github.com:444/x', 'file:///private', 'https://github.com/x#fragment']) assert.equal(allowedUpdateUrl(url), false)
  assert.equal(allowedUpdateUrl('https://release-assets.githubusercontent.com/file?signature=x'), true)
})
test('release signer emits client-verifiable metadata and rejects wrong trust root', async t => {
  const { makeManifest } = await import('../scripts/release-manifest.mjs')
  const dir = await temporary(t)
  await writeFile(path.join(dir, target.asset), 'new')
  await writeFile(path.join(dir, 'Duprove-1.1.0-linux-x64.tar.gz'), 'linux')
  const privatePem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' })
  const signed = await makeManifest(dir, '1.1.0', privatePem, publicKey)
  assert.equal(verifyManifest(Buffer.from(JSON.stringify(signed)), publicKey, '1.1.0').targets.length, 2)
  await assert.rejects(makeManifest(dir, '1.1.0', privatePem, generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' })), /MISMATCH/)
})
function mockHttps(t, serve) {
  const captured = []
  t.mock.method(https, 'get', (url, options, callback) => {
    captured.push({ url, options })
    const request = new EventEmitter()
    request.setTimeout = () => request
    request.destroy = error => { request.emit('error', error); return request }
    queueMicrotask(() => {
      const response = new PassThrough()
      response.statusCode = 200; response.headers = {}
      serve(response, captured.length)
      callback(response)
    })
    return request
  })
  return captured
}
test('transport uses fixed anonymous GET options; validates download and removes broken partial files', async t => {
  const directory = await temporary(t), file = path.join(directory, 'package.exe')
  let body = 'new'
  const captured = mockHttps(t, response => response.end(body))
  const transport = new GithubUpdateTransport(), signal = new AbortController().signal
  await transport.download('1.1.0', target, file, signal, () => {})
  assert.equal(await readFile(file, 'utf8'), 'new')
  const request = captured[0]
  assert.equal(request.url, 'https://github.com/frdkss/Duprove/releases/download/v1.1.0/Duprove-1.1.0-win-x64.exe')
  assert.deepEqual(request.options.headers, { 'User-Agent': 'Duprove-Updater', Accept: 'application/octet-stream', 'Accept-Encoding': 'identity' })
  assert.equal(request.options.rejectUnauthorized, true); assert.equal(request.options.minVersion, 'TLSv1.2')
  await rm(file); body = 'bad'
  await assert.rejects(transport.download('1.1.0', target, file, signal, () => {}), /HASH/)
  await assert.rejects(readFile(file), { code: 'ENOENT' })
  body = 'oversized'
  await assert.rejects(transport.download('1.1.0', target, file, signal, () => {}), /SIZE/)
  await assert.rejects(readFile(file), { code: 'ENOENT' })
  body = 'truncated'
  await assert.rejects(transport.bytes('https://api.github.com/repos/frdkss/Duprove/releases', 3, signal), /TOO_LARGE/)
  assert.equal(captured.at(-1).options.headers.Accept, 'application/vnd.github+json')
})
test('redirect to an untrusted host is refused before contacting it', async t => {
  const captured = mockHttps(t, response => { response.statusCode = 302; response.headers.location = 'https://evil.test/payload'; response.end() })
  await assert.rejects(new GithubUpdateTransport().bytes('https://github.com/frdkss/Duprove/releases/download/v1.1.0/stable.json', 65536, new AbortController().signal), /URL_INVALID/)
  assert.equal(captured.length, 1)
})
test('interrupted response does not leave an installable partial package', async t => {
  const file = path.join(await temporary(t), 'package.exe')
  mockHttps(t, response => { response.write('n'); setImmediate(() => response.destroy(Error('connection lost'))) })
  await assert.rejects(new GithubUpdateTransport().download('1.1.0', target, file, new AbortController().signal, () => {}))
  await assert.rejects(readFile(file), { code: 'ENOENT' })
})
test('shutdown cancels download without preparing or installing an update', async t => {
  const f = await fixture(t)
  let downloading
  const started = new Promise(resolve => downloading = resolve)
  f.options.transport.download = async (_version, _target, _file, signal) => {
    downloading()
    await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Error('aborted')), { once: true }))
  }
  f.options.installer.prepare = async () => assert.fail('Prepared a cancelled package')
  const attempt = f.service.start()
  await started; await f.service.stop(); await attempt
  assert.equal(f.counts().installs, 0); assert.equal(f.service.blocksAnalysis, false)
})
test('newest incompatible release does not prevent an older compatible upgrade', async t => {
  const f = await fixture(t)
  f.options.transport.releases = async () => ['2.0.0', '1.1.0'].map(v => ({ tag_name: `v${v}`, draft: false, prerelease: false }))
  f.options.transport.bytes = async url => {
    const m = manifest()
    if (url.includes('v2.0.0')) { m.version = '2.0.0'; m.targets[0].asset = 'Duprove-2.0.0-win-x64.exe'; m.targets[0].minOs = '99.0.0' }
    return envelope(m)
  }
  await f.service.start()
  assert.equal(f.service.snapshot().availableVersion, '1.1.0'); assert.equal(f.counts().downloads, 1)
})
test('unsupported installation makes no network requests', async t => {
  const f = await fixture(t, { host: null })
  await f.service.start(); await f.service.tick()
  assert.equal(f.service.snapshot().status, 'unavailable'); assert.equal(f.counts().requests, 0)
})
test('Windows installer executes hash verification with its own PowerShell modules before shutdown', { skip: process.platform !== 'win32' }, async t => {
  const base = await temporary(t), directory = path.join(base, 'updates'), app = path.join(base, 'app'), helpers = path.join(base, 'helpers')
  for (const folder of [directory, app, helpers]) await mkdir(folder)
  const file = path.join(directory, 'package.exe'); await writeFile(file, 'new')
  await writeFile(path.join(helpers, 'update-windows.ps1'), `param([string]$Transaction)\n$ErrorActionPreference='Stop'\n$job = Get-Content -LiteralPath $Transaction -Raw | ConvertFrom-Json\nif ((Get-FileHash -LiteralPath $job.package -Algorithm SHA512).Hash.ToLowerInvariant() -ne $job.sha512) { throw 'BAD_HASH' }\nif ($env:PSModulePath.Contains('nonexistent-PS7-modules')) { throw 'INHERITED_PS7_MODULES' }\n[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'armed'), $job.token)\n`)
  let stopped = false
  const installer = new PackageUpdateInstaller({ directory, executable: path.join(app, 'Duprove.exe'), helperDirectory: helpers, shutdown: async () => { stopped = true } })
  const inherited = process.env.PSModulePath
  process.env.PSModulePath = 'Z:\\nonexistent-PS7-modules'
  try { await installer.prepare(file, '1.1.0', target); await installer.install() }
  finally { if (inherited === undefined) delete process.env.PSModulePath; else process.env.PSModulePath = inherited }
  assert.equal(stopped, true)
})

test('release signing CLI accepts a planned main-branch release and rejects a mismatched version', async t => {
  const directory = await temporary(t)
  await mkdir(path.join(directory, 'config')); await mkdir(path.join(directory, 'release'))
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ version: '1.1.0' }))
  await writeFile(path.join(directory, 'config/update-public-key.pem'), publicKey)
  for (const name of [target.asset, 'Duprove-1.1.0-linux-x64.tar.gz']) await writeFile(path.join(directory, 'release', name), 'new')
  const env = { ...process.env, GITHUB_REF_NAME: 'main', DUPROVE_RELEASE_TAG: 'v1.1.0', DUPROVE_UPDATE_PRIVATE_KEY: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }) }
  const run = () => spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/release-manifest.mjs')], { cwd: directory, env, encoding: 'utf8', windowsHide: true, timeout: 30000 })
  const result = run(); assert.equal(result.status, 0, result.stderr)
  assert.equal(verifyManifest(await readFile(path.join(directory, 'release/stable.json')), publicKey, '1.1.0').version, '1.1.0')
  env.DUPROVE_RELEASE_TAG = 'v2.0.0'
  assert.notEqual(run().status, 0)
})
