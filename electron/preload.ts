import { contextBridge, ipcRenderer } from 'electron'
import { channels, type DesktopBridge } from './bridge'
const bridge: DesktopBridge = {
  requestCatalog: request => ipcRenderer.invoke(channels.catalog, request),
  trashCatalog: request => ipcRenderer.invoke(channels.trash, request),
  listDrives: () => ipcRenderer.invoke(channels.drives),
  windowAction: action => ipcRenderer.invoke(channels.window, action),
  openHelp: () => ipcRenderer.invoke(channels.help),
  getStatisticsConsent: () => ipcRenderer.invoke(channels.consentGet),
  setStatisticsConsent: change => ipcRenderer.invoke(channels.consentSet, change),
  getAnalysis: () => ipcRenderer.invoke(channels.analysisGet),
  startAnalysis: request => ipcRenderer.invoke(channels.analysisStart, request),
  controlAnalysis: command => ipcRenderer.invoke(channels.analysisControl, command),
  getAnalysisReport: () => ipcRenderer.invoke(channels.analysisReport),
  getReportDelivery: () => ipcRenderer.invoke(channels.deliveryGet),
  getUpdate: () => ipcRenderer.invoke(channels.updateGet),
  onUpdate: listener => {
    const receive = (_event: Electron.IpcRendererEvent, snapshot: Parameters<typeof listener>[0]) => listener(snapshot)
    ipcRenderer.on(channels.updateEvent, receive)
    return () => { ipcRenderer.removeListener(channels.updateEvent, receive) }
  },
  onReportDelivery: listener => {
    const receive = (_event: Electron.IpcRendererEvent, snapshot: Parameters<typeof listener>[0]) => listener(snapshot)
    ipcRenderer.on(channels.deliveryEvent, receive)
    return () => { ipcRenderer.removeListener(channels.deliveryEvent, receive) }
  },
  onAnalysis: listener => {
    const receive = (_event: Electron.IpcRendererEvent, snapshot: Parameters<typeof listener>[0]) => listener(snapshot)
    ipcRenderer.on(channels.analysisEvent, receive)
    return () => { ipcRenderer.removeListener(channels.analysisEvent, receive) }
  },
  getAutostart: () => ipcRenderer.invoke(channels.autostartGet),
  setAutostart: enabled => ipcRenderer.invoke(channels.autostartSet, enabled),
}
contextBridge.exposeInMainWorld('duprove', bridge)
