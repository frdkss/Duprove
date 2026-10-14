const { app, shell } = require('electron')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
app.setAppPath(path.resolve(__dirname, '..'))
app.setPath('userData', path.resolve(__dirname, '../.verification/startup-profile'))
const consentFile = path.join(app.getPath('userData'), 'statistics-consent.json')
fs.rmSync(consentFile, { force: true })
const helpLinks = []
shell.openExternal = async url => { helpLinks.push(url) }
const timeout = setTimeout(() => { console.error('APP_STARTUP_TIMEOUT'); app.exit(1) }, 20000)
app.on('browser-window-created', (_event, window) => {
  window.webContents.once('did-fail-load', () => { console.error('APP_LOAD_FAILED'); app.exit(1) })
  window.webContents.once('did-finish-load', async () => {
    try {
      await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
        const deadline = Date.now() + 5000;
        const check = () => document.querySelector('h1') ? resolve() : Date.now() > deadline ? reject(Error('NO_UI')) : setTimeout(check, 25);
        check();
      })`)
      assert.equal(window.isVisible(), true, 'The actual application window must be visible')
      assert.deepEqual(window.getMinimumSize(), [640, 480])
      assert.equal((await window.webContents.executeJavaScript('window.duprove.getStatisticsConsent()')).decision, 'default-enabled')
      await assert.rejects(window.webContents.executeJavaScript('window.duprove.setStatisticsConsent({enabled:"true", noticeVersion:2})'), /INVALID_CONSENT_REQUEST/)
      assert.equal((await window.webContents.executeJavaScript('window.duprove.getStatisticsConsent()')).decision, 'default-enabled')
      assert.equal((await window.webContents.executeJavaScript('window.duprove.setStatisticsConsent({enabled:false, noticeVersion:2})')).decision, 'declined')
      assert.equal((await window.webContents.executeJavaScript('window.duprove.setStatisticsConsent({enabled:true, noticeVersion:2})')).decision, 'granted')
      assert.equal(JSON.parse(fs.readFileSync(consentFile, 'utf8')).decision, 'granted')
      assert.equal((await window.webContents.executeJavaScript('window.duprove.setStatisticsConsent({enabled:false, noticeVersion:2})')).decision, 'declined')
      assert.equal(JSON.parse(fs.readFileSync(consentFile, 'utf8')).decision, 'declined')
      await window.webContents.executeJavaScript('window.duprove.openHelp()')
      assert.deepEqual(helpLinks, ['https://duprove.site/#instrucitons'])
      assert.equal(await window.webContents.executeJavaScript('document.querySelector("h1").textContent'), 'Ваши диски')
      const maximized = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('MAXIMIZE_TIMEOUT')), 4000)
        window.once('maximize', () => { clearTimeout(timer); resolve() })
      })
      await window.webContents.executeJavaScript('window.duprove.windowAction("maximize")')
      await maximized
      assert.equal(window.isMaximized(), true)
      const minimized = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('MINIMIZE_TIMEOUT')), 4000)
        window.once('minimize', () => { clearTimeout(timer); resolve() })
      })
      await window.webContents.executeJavaScript('window.duprove.windowAction("minimize")')
      await minimized
      assert.equal(window.isMinimized(), true)
      clearTimeout(timeout)
      console.log('APP_STARTUP_OK: actual consent IPC validated and persisted; Duprove window visible; native window controls work')
      window.close()
    } catch (error) { console.error(error); app.exit(1) }
  })
})
require('../dist-electron/main.js')
