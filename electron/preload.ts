import { contextBridge, ipcRenderer } from 'electron'
import { channels, type DesktopBridge } from './bridge'
const bridge: DesktopBridge = {
  listDrives: () => ipcRenderer.invoke(channels.drives),
  windowAction: action => ipcRenderer.invoke(channels.window, action),
  openHelp: () => ipcRenderer.invoke(channels.help),
  getStatisticsConsent: () => ipcRenderer.invoke(channels.consentGet),
  setStatisticsConsent: change => ipcRenderer.invoke(channels.consentSet, change),
}
contextBridge.exposeInMainWorld('duprove', bridge)
