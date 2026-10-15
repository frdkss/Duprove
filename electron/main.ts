import { app, BrowserWindow, ipcMain, shell, Tray, Menu, Notification, nativeImage } from 'electron'
import path from 'node:path'
import { channels } from './bridge'
import { listDrives } from './services/analyzer-service'
import { ConsentService } from './services/consent-service'
import { JobClient } from './services/job-client'
import { activeJob } from '../contracts/analysis'
import { getAutostart, setAutostart } from './services/autostart'
import { DeliveryService } from './services/delivery-service'
import { HttpsReportTransport, readTransportSettings } from './services/report-transport'

let jobs: JobClient | undefined
let tray: Tray | undefined
let quitting = false
let closing = false
let notification: Notification | undefined
let delivery: DeliveryService | undefined
function showWindow() {
  const window = BrowserWindow.getAllWindows()[0]
  if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus() }
  else createWindow()
}
function ensureTray() {
  if (tray) return
  tray = new Tray(nativeImage.createFromPath(applicationIcon()).resize({ width: 20, height: 20 }))
  tray.setToolTip('Duprove')
  tray.setContextMenu(Menu.buildFromTemplate([{ label: 'Открыть Duprove', click: showWindow },
    { label: 'Выйти и сохранить прогресс', click: () => app.quit() }]))
  tray.on('click', showWindow)
}

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
  window.on('close', event => {
    if (!quitting && jobs && activeJob(jobs.snapshot().status)) {
      event.preventDefault()
      try { ensureTray(); window.hide() } catch { /* Keep the window reachable if the tray is unavailable. */ }
    }
  })
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
  void app.whenReady().then(async () => {
    if (process.platform === 'darwin') app.dock?.setIcon(applicationIcon())
    const consent = new ConsentService(path.join(app.getPath('userData'), 'statistics-consent.json'))
    let transport: HttpsReportTransport | null = null
    let configurationError: string | null = null
    try {
      const settings = readTransportSettings(app.getAppPath(), app.isPackaged)
      if (settings) transport = new HttpsReportTransport(settings)
    } catch { configurationError = 'DELIVERY_CONFIGURATION_FAILED' }
    delivery = new DeliveryService(path.join(app.getPath('userData'), 'analysis'), consent, transport, configurationError)
    delivery.on('snapshot', snapshot => {
      for (const window of BrowserWindow.getAllWindows()) if (!window.webContents.isDestroyed()) window.webContents.send(channels.deliveryEvent, snapshot)
    })
    void delivery.refresh()
    jobs = new JobClient(path.join(__dirname, 'analysis-worker.js'), { executable: executable(),
      directory: path.join(app.getPath('userData'), 'analysis'), consentFile: path.join(app.getPath('userData'), 'statistics-consent.json') })
    let previousStatus = 'idle'
    jobs.on('snapshot', snapshot => {
      if (!activeJob(snapshot.status) && snapshot.status !== 'idle') void delivery!.refresh()
      for (const window of BrowserWindow.getAllWindows()) if (!window.webContents.isDestroyed()) window.webContents.send(channels.analysisEvent, snapshot)
      if (snapshot.status === 'completed' && previousStatus !== 'completed' && BrowserWindow.getAllWindows().some(w => !w.isVisible())) {
        tray?.setToolTip('Duprove — анализ завершён')
        if (Notification.isSupported()) {
          notification = new Notification({ title: 'Duprove', body: 'Анализ завершён. Результаты доступны в приложении.', icon: applicationIcon() })
          notification.on('failed', () => { tray?.setToolTip('Duprove — анализ завершён, уведомление недоступно') })
          notification.show()
        }
      }
      previousStatus = snapshot.status
    })
    const trusted = (event: Electron.IpcMainInvokeEvent) => {
      if (!BrowserWindow.fromWebContents(event.sender) || event.senderFrame !== event.sender.mainFrame) throw new Error('INVALID_SENDER')
    }
    ipcMain.handle(channels.analysisGet, event => { trusted(event); return jobs!.snapshot() })
    ipcMain.handle(channels.analysisStart, (event, request: unknown) => { trusted(event); return jobs!.call('start', request) })
    ipcMain.handle(channels.analysisControl, (event, request: unknown) => { trusted(event); return jobs!.call('command', request) })
    ipcMain.handle(channels.analysisReport, event => { trusted(event); return jobs!.call('report') })
    ipcMain.handle(channels.deliveryGet, event => { trusted(event); return delivery!.snapshot() })
    ipcMain.handle(channels.autostartGet, event => { trusted(event); return getAutostart() })
    ipcMain.handle(channels.autostartSet, (event, enabled: unknown) => { trusted(event); return setAutostart(enabled) })
    ipcMain.handle(channels.consentGet, event => {
      if (!BrowserWindow.fromWebContents(event.sender) || event.senderFrame !== event.sender.mainFrame) throw new Error('INVALID_CONSENT_SENDER')
      return consent.snapshot()
    })
    ipcMain.handle(channels.consentSet, (event, request: unknown) => {
      if (!BrowserWindow.fromWebContents(event.sender) || event.senderFrame !== event.sender.mainFrame) throw new Error('INVALID_CONSENT_SENDER')
      const snapshot = consent.set(request)
      delivery!.consentChanged()
      return snapshot
    })
    ipcMain.handle(channels.drives, event => { trusted(event); return listDrives(executable()) })
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
    await jobs.ready
    createWindow()
    app.on('activate', showWindow)
  })
  app.on('window-all-closed', () => app.quit())
  app.on('before-quit', event => {
    if (quitting || !jobs) return
    event.preventDefault()
    if (closing) return
    closing = true
    void Promise.allSettled([delivery?.stop(), jobs.call('shutdown')]).finally(() => { quitting = true; tray?.destroy(); app.quit() })
  })
}
