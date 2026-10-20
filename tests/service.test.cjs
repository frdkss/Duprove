const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'duprove-service-'))
  t.after(() => {
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('duprove-service-')) throw Error('Unsafe test cleanup')
    fs.rmSync(root, { recursive: true, force: true })
  })
  const write = (file, data = '') => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    fs.writeFileSync(path.join(root, file), data)
  }
  write('package.json', '{}')
  write('node_modules/electron/package.json', '{"name":"electron","version":"0.0.0"}')
  write('node_modules/electron/path.txt', 'electron.exe')
  write('node_modules/electron/dist/electron.exe')
  write('node_modules/typescript/bin/tsc')
  write('node_modules/vite/bin/vite.js')
  return root
}

test('service builds before launch and removes inherited Electron flags without writing logs', async t => {
  const { launch } = await import('../service/launch.mjs')
  const root = fixture(t)
  const calls = []
  const previous = process.env.ELECTRON_RUN_AS_NODE
  process.env.ELECTRON_RUN_AS_NODE = '1'
  try {
    await launch({ root, mode: '--no-logs', execute: async (...args) => calls.push(args) })
  } finally {
    if (previous === undefined) delete process.env.ELECTRON_RUN_AS_NODE
    else process.env.ELECTRON_RUN_AS_NODE = previous
  }
  assert.equal(calls.length, 2)
  assert.equal(calls[0][1][0], path.join(root, 'service/build-desktop.mjs'))
  assert.deepEqual(calls[1][1], ['--disable-logging', root])
  assert.deepEqual(calls[1][4], { windowsHide: false })
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_ENABLE_LOGGING', 'ELECTRON_LOG_FILE']) assert.equal(calls[1][2][key], undefined)
  assert.equal(fs.existsSync(path.join(root, 'service/logs')), false)
})
test('service logs successful lifecycle only when requested', async t => {
  const { launch } = await import('../service/launch.mjs')
  const root = fixture(t)
  await launch({ root, mode: '--log', execute: async () => {} })
  const files = fs.readdirSync(path.join(root, 'service/logs'))
  assert.equal(files.length, 1)
  const log = fs.readFileSync(path.join(root, 'service/logs', files[0]), 'utf8')
  assert.match(log, /log-file:/)
  assert.match(log, /Код выхода: 0/)
})
test('failed build prevents launch and records failure in log', async t => {
  const { launch } = await import('../service/launch.mjs')
  const root = fixture(t)
  let calls = 0
  await assert.rejects(launch({ root, mode: '--log', execute: async () => { calls++; throw Error('BUILD_FAILED') } }), /BUILD_FAILED/)
  assert.equal(calls, 1)
  const file = fs.readdirSync(path.join(root, 'service/logs'))[0]
  assert.match(fs.readFileSync(path.join(root, 'service/logs', file), 'utf8'), /BUILD_FAILED/)
})
test('missing runtime fails without implicit network installation', async t => {
  const { launch } = await import('../service/launch.mjs')
  const root = fixture(t)
  fs.unlinkSync(path.join(root, 'node_modules/electron/path.txt'))
  let calls = 0
  await assert.rejects(launch({ root, mode: '--no-logs', execute: async () => { calls++ } }), /service.bat 1/)
  assert.equal(calls, 0)
  assert.equal(fs.existsSync(path.join(root, 'service/logs')), false)
})
