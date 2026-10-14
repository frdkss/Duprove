import { app, BrowserWindow, ipcMain, shell } from 'electron'
import path from 'node:path'
import { channels } from './bridge'
import { listDrives } from './services/analyzer-service'
import { ConsentService } from './services/consent-service'

if (process.platform === 'win32') app.setAppUserModelId('ru.duprove.desktop')

function applicationIcon() {
  const directory = app.isPackaged ? 'dist' : 'public'
  return path.join(app.getAppPath(), directory, process.platform === 'win32' ? 'logo.ico' : 'logo.png')
}

function executable() {
  const base = app.isPackaged ? path.join(process.resourcesPath, 'analyzer') : path.join(app.getAppPath(), 'build/native/bin')
  return path.join(base, process.platform === 'win32' ? 'duprove-analyzer.exe' : 'duprove-analyzer')
}

function createWindow() {
  const window = new BrowserWindow({ width: 1280, height: 800, minWidth: 640, minHeight: 480,
    icon: applicationIcon(),
    frame: false, backgroundColor: '#f4f9f7', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => event.preventDefault())
  const developmentUrl = !app.isPackaged && process.env.DUPROVE_DEV_URL
  if (developmentUrl === 'http://127.0.0.1:5173') void window.loadURL(developmentUrl)
  else void window.loadFile(path.join(__dirname, '../dist/index.html'))
}

// One authority for consent: another process must not retain an outdated grant.
if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => {
    const window = BrowserWindow.getAllWindows()[0]
    if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus() }
  })
  void app.whenReady().then(() => {
    if (process.platform === 'darwin') app.dock?.setIcon(applicationIcon())
    const consent = new ConsentService(path.join(app.getPath('userData'), 'statistics-consent.json'))
    ipcMain.handle(channels.consentGet, event => {
      if (!BrowserWindow.fromWebContents(event.sender) || event.senderFrame !== event.sender.mainFrame) throw new Error('INVALID_CONSENT_SENDER')
      return consent.snapshot()
    })
    ipcMain.handle(channels.consentSet, (event, request: unknown) => {
      if (!BrowserWindow.fromWebContents(event.sender) || event.senderFrame !== event.sender.mainFrame) throw new Error('INVALID_CONSENT_SENDER')
      return consent.set(request)
    })
    ipcMain.handle(channels.drives, () => listDrives(executable()))
    ipcMain.handle(channels.help, event => {
      if (!BrowserWindow.fromWebContents(event.sender) || event.senderFrame !== event.sender.mainFrame) return
      return shell.openExternal('https://duprove.site/#instrucitons')
    })
    ipcMain.handle(channels.window, (event, action: unknown) => {
      const window = BrowserWindow.fromWebContents(event.sender)
      if (!window || event.senderFrame !== event.sender.mainFrame) return
      if (action === 'minimize') window.minimize()
      else if (action === 'maximize') { if (window.isMaximized()) window.unmaximize(); else window.maximize() }
      else if (action === 'close') window.close()
    })
    createWindow()
    app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow() })
  })
  app.on('window-all-closed', () => app.quit())
}
