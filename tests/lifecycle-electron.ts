import electron from 'electron'
import { EventEmitter } from 'node:events'
export const { app, BrowserWindow, ipcMain, shell, Menu, nativeImage, dialog } = electron
// Inject this module only into the test bundle; do not mutate Electron exports.
export const Tray = function (image: Electron.NativeImage) {
  const tray = new electron.Tray(image)
  ;(globalThis as any).lifecycleTray = tray
  return tray
}
export class Notification extends EventEmitter {
  static isSupported() { return true }
  show() { (globalThis as any).lifecycleNotifications = ((globalThis as any).lifecycleNotifications ?? 0) + 1 }
}
