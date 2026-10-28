const { spawn } = require('node:child_process')
const { mkdtempSync, rmSync, readFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const { waitForMain } = require('./helpers/packaged-readiness.cjs')
if (process.argv.length !== 3) throw Error('Usage: node tests/packaged-startup.cjs <packaged executable>')
const profile = mkdtempSync(path.join(tmpdir(), 'duprove-packaged-ui-'))
const binary = process.argv[2]
const expectedVersion = JSON.parse(readFileSync(path.join(__dirname, '../package.json'), 'utf8')).version
const environment = { ...process.env, XDG_CONFIG_HOME: profile }
delete environment.ELECTRON_RUN_AS_NODE
const child = spawn(binary, ['--inspect=0', `--user-data-dir=${profile}`], {
  env: environment,
  stdio: ['ignore', 'pipe', 'pipe']
})
let socket
let logs = ''
let finished = false
const pending = new Map()
let nextId = 0
const timer = setTimeout(() => finish(Error('PACKAGED_UI_TIMEOUT')), 30000)
function finish(error) {
  if (finished) return
  finished = true
  clearTimeout(timer)
  socket?.close()
  if (child.exitCode === null) child.kill('SIGTERM')
  if (error) {
    console.error(error.message)
    console.error(logs.slice(-4000))
    process.exitCode = 1
  }
}
child.once('close', () => rmSync(profile, { recursive: true, force: true }))
child.on('error', finish)
child.on('exit', code => { if (!finished) finish(Error(`PACKAGED_EXIT_${code}`)) })
child.stderr.on('data', chunk => {
  logs += chunk
  const match = logs.match(/Debugger listening on (ws:\/\/[^\s]+)/)
  if (match && !socket) {
    socket = new WebSocket(match[1])
    socket.onmessage = event => {
      const message = JSON.parse(event.data)
      if (message.id && pending.has(message.id)) {
        pending.get(message.id)(message)
        pending.delete(message.id)
      }
    }
    socket.onopen = check
    socket.onerror = () => finish(Error('INSPECTOR_CONNECTION_FAILED'))
  }
})
function evaluate(expression) {
  return new Promise(resolve => {
    const id = ++nextId
    pending.set(id, resolve)
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
  })
}
async function check() {
  try {
    await waitForMain(evaluate)
    if (finished) return
    const response = await evaluate(`(async () => {
      const {app, BrowserWindow} = process.mainModule.require('electron');
      await app.whenReady();
      for (let i=0; i<100; i++) {
        const window = BrowserWindow.getAllWindows()[0];
        if (window && !window.webContents.isLoading()) {
          const result = await window.webContents.executeJavaScript('(async()=>{if(!window.duprove || !document.querySelector("h1")) return null; return {drives:await window.duprove.listDrives(),consent:await window.duprove.getStatisticsConsent(),rendered:document.querySelectorAll(".sidebar-drives .drive-item").length};})()');
          if (result && result.rendered === result.drives.length) return {packaged:app.isPackaged,version:app.getVersion(),visible:window.isVisible(),count:result.drives.length,paths:result.drives.map(d=>d.path),rendered:result.rendered,decision:result.consent.decision,updateVersion:(await window.webContents.executeJavaScript('window.duprove.getUpdate()')).currentVersion};
        }
        await new Promise(resolve=>setTimeout(resolve,100));
      }
      throw Error('UI_NOT_LOADED');
    })()`)
    if (response.error || response.result?.exceptionDetails) throw Error(JSON.stringify(response))
    const value = response.result.result.value
    assert.equal(value.packaged, true)
    assert.equal(value.version, expectedVersion, 'Packaged application metadata has the requested version')
    assert.equal(value.updateVersion, expectedVersion, 'Application settings receive the packaged version')
    assert.equal(value.visible, true)
    assert.ok(process.platform === 'win32' ? value.paths.some(p => /^[a-z]:[\\/]+$/i.test(p)) : value.paths.includes('/'), 'A system drive must be listed')
    assert.ok(value.count > 0)
    assert.equal(value.rendered, value.count, 'The actual drive list must appear in the renderer')
    assert.equal(value.decision, 'default-enabled')
    console.log('PACKAGED_STARTUP_OK: visible window; real preload/native drives; fresh profile enabled; count=' + value.count)
    finish()
  } catch(error) { finish(error) }
}
