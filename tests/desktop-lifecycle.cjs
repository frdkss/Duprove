const electron = require('electron')
const { app, BrowserWindow } = electron
const path = require('node:path')
const fs = require('node:fs')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const profile = path.join(root, `.verification/lifecycle-profile-${process.platform}`)
fs.mkdirSync(profile, { recursive: true })
fs.rmSync(path.join(profile, 'analysis/shutdown-verified'), { force: true })
app.setAppPath(root)
app.setPath('userData', profile)
app.disableHardwareAcceleration()
let stage = 'electron-bootstrap'
const timer = setTimeout(() => { console.error('LIFECYCLE_TIMEOUT: ' + stage); app.exit(1) }, 20000)
app.whenReady().then(() => { stage = 'electron-ready'; console.log('LIFECYCLE_STAGE: ' + stage) })
app.on('browser-window-created', (_event, window) => {
  stage = 'window-created'; console.log('LIFECYCLE_STAGE: ' + stage)
  window.webContents.on('did-fail-load', (_event, code, message) => { console.error('LIFECYCLE_LOAD_FAILED', code, message); app.exit(1) })
  window.webContents.on('render-process-gone', (_event, details) => { console.error('LIFECYCLE_RENDERER_GONE', details.reason); app.exit(1) })
  window.webContents.once('did-finish-load', async () => {
    try {
      stage = 'renderer-loaded'; console.log('LIFECYCLE_STAGE: ' + stage)
      await window.webContents.executeJavaScript('window.duprove.startAnalysis({version:1, roots:[], mode:"low", content:false})')
      await window.webContents.executeJavaScript('window.duprove.windowAction("close")')
      assert.equal(window.isDestroyed(), false)
      assert.equal(window.isVisible(), false, 'Close hides an active job in the real native tray')
      const tray = globalThis.lifecycleTray
      assert.ok(tray && !tray.isDestroyed())
      stage = 'active-window-hidden'
      await new Promise(resolve => setTimeout(resolve, 1000))
      assert.equal(globalThis.lifecycleNotifications, 1, 'Completion requests exactly one system notification')
      assert.equal(window.isVisible(), false, 'Completion must not open the window')
      tray.emit('click')
      assert.equal(window.isVisible(), true, 'Tray reopens the existing window')
      assert.equal(BrowserWindow.getAllWindows().length, 1)
      clearTimeout(timer)
      stage = 'graceful-shutdown'
      window.close()
    } catch (error) { console.error(error); app.exit(1) }
  })
})
app.on('will-quit', () => {
  try {
    assert.equal(fs.readFileSync(path.join(profile, 'analysis/shutdown-verified'), 'utf8'), 'yes')
    console.log('DESKTOP_LIFECYCLE_OK: real tray, active close, synthetic completion notification, no auto-open, idle close and graceful shutdown')
  } catch (error) { console.error(error); app.exit(1) }
})
require('../.verification/lifecycle/main.js')
