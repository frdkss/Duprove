import { contextBridge, ipcRenderer } from 'electron'
import { channels, type DesktopBridge } from './bridge'
const bridge: DesktopBridge = { listDrives: () => ipcRenderer.invoke(channels.drives), windowAction: action => ipcRenderer.invoke(channels.window, action), openHelp: () => ipcRenderer.invoke(channels.help) }
contextBridge.exposeInMainWorld('duprove', bridge)
