import { app, BrowserWindow, ipcMain, shell, Tray, Menu, Notification, nativeImage, dialog } from 'electron'
import path from 'node:path'
import { channels } from './bridge'
import { listDrives } from './services/analyzer-service'
import { ConsentService } from './services/consent-service'
import { JobClient } from './services/job-client'
import { activeJob } from '../contracts/analysis'
import { getAutostart, setAutostart } from './services/autostart'
import { DeliveryService } from './services/delivery-service'
import { HttpsReportTransport, readTransportSettings } from './services/report-transport'
import { UpdateService } from './services/update-service'
import { GithubUpdateTransport } from './services/update-transport'
import { PackageUpdateInstaller, installedUpdateHost, acknowledgeUpdate } from './services/update-installer'
import { TrashService } from './services/trash-service'
import { trashConfirmationOptions } from './services/trash-confirmation'

declare const __DUPROVE_UPDATE_KEY__: string

let jobs: JobClient | undefined
let tray: Tray | undefined
let quitting = false
let closing = false
let notification: Notification | undefined
let delivery: DeliveryService | undefined
let updates: UpdateService | undefined
let analysisCommands = 0
let trashService: TrashService | undefined
async function analysisCall(method: 'start' | 'command', request: unknown) {
  if (closing || updates?.blocksAnalysis || trashService?.busy) throw Error('APP_BUSY')
  analysisCommands++
  try { return await jobs!.call(method, request) } finally { analysisCommands-- }
}
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
    if (trashService?.busy) { event.preventDefault(); return }
    if (!quitting && updates?.blocksAnalysis) { event.preventDefault(); return }
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
    trashService = new TrashService((method, value) => jobs!.call(method, value), async plan => {
      const result = await dialog.showMessageBox(trashConfirmationOptions(plan))
      return result.response === 1
    }, file => shell.trashItem(file), () => closing || !!updates?.blocksAnalysis || analysisCommands > 0 || activeJob(jobs!.snapshot().status))
    ipcMain.handle(channels.catalog, (event, request: unknown) => {
      trusted(event)
      if (closing || updates?.blocksAnalysis || trashService!.busy) throw Error('CATALOG_BUSY')
      return jobs!.call('catalog', request)
    })
    ipcMain.handle(channels.trash, (event, request: unknown) => { trusted(event); return trashService!.run(request) })
    ipcMain.handle(channels.analysisStart, (event, request: unknown) => { trusted(event); return analysisCall('start', request) })
    ipcMain.handle(channels.analysisControl, (event, request: unknown) => { trusted(event); return analysisCall('command', request) })
    ipcMain.handle(channels.analysisReport, event => { trusted(event); return jobs!.call('report') })
    ipcMain.handle(channels.deliveryGet, event => { trusted(event); return delivery!.snapshot() })
    ipcMain.handle(channels.updateGet, event => { trusted(event); return updates!.snapshot() })
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
    const updateDirectory = path.join(app.getPath('userData'), 'updates')
    updates = new UpdateService({ directory: updateDirectory, version: app.getVersion(), publicKey: __DUPROVE_UPDATE_KEY__,
      host: await installedUpdateHost(process.execPath, app.isPackaged), transport: new GithubUpdateTransport(),
      installer: new PackageUpdateInstaller({ directory: updateDirectory, executable: process.execPath,
        helperDirectory: app.isPackaged ? path.join(process.resourcesPath, 'updater') : path.join(app.getAppPath(), 'installer'),
        shutdown: async () => {
          if (closing || trashService?.busy || activeJob(jobs!.snapshot().status)) throw Error('UPDATE_APP_BUSY')
          closing = true
          try { await jobs!.call('shutdown'); await delivery!.stop() }
          catch (error) { closing = false; throw error }
          quitting = true; tray?.destroy(); app.quit()
        } }),
      busy: () => closing || !!trashService?.busy || analysisCommands > 0 || activeJob(jobs!.snapshot().status),
      notify: version => {
        if (Notification.isSupported()) {
          notification = new Notification({ title: 'Обновление Duprove', body: `Версия ${version} загружена. Приложение перезапустится через минуту, если анализ не запущен.`, icon: applicationIcon() })
          notification.on('failed', () => {}); notification.show()
        }
      } })
    updates.on('snapshot', snapshot => {
      for (const window of BrowserWindow.getAllWindows()) if (!window.webContents.isDestroyed()) window.webContents.send(channels.updateEvent, snapshot)
    })
    createWindow()
    // Acknowledge only after worker startup and renderer load, so a broken build rolls back.
    const mainWindow = BrowserWindow.getAllWindows()[0]
    mainWindow.webContents.once('did-finish-load', () => {
      void mainWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
        let attempts = 0;
        const check = () => window.duprove && document.querySelector('h1') ? resolve(true)
          : attempts++ > 100 ? reject(Error('UI_NOT_READY')) : setTimeout(check, 100);
        check();
      })`).then(async () => {
        if (process.argv.includes('--duprove-updated')) {
          if (jobs!.snapshot().error === 'ANALYSIS_WORKER_FAILED') throw Error('UPDATE_WORKER_NOT_READY')
          await listDrives(executable())
        }
        await acknowledgeUpdate(updateDirectory, app.getVersion())
        await updates!.start()
      }).catch(() => {})
    })
    app.on('activate', showWindow)
  })
  app.on('window-all-closed', () => app.quit())
  app.on('before-quit', event => {
    if (quitting || !jobs) return
    event.preventDefault()
    if (trashService?.busy) return
    if (updates?.blocksAnalysis) return
    if (closing) return
    closing = true
    void Promise.allSettled([updates?.stop(), delivery?.stop(), jobs.call('shutdown')]).finally(() => { quitting = true; tray?.destroy(); app.quit() })
  })
}
