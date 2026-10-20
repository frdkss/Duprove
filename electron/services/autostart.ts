import { app } from 'electron'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

function desktopFile() { return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'autostart', 'duprove.desktop') }
export async function getAutostart() {
  if (!app.isPackaged) return { supported: false, enabled: false }
  if (process.platform !== 'linux') return { supported: true, enabled: app.getLoginItemSettings().openAtLogin }
  try { const text = await readFile(desktopFile(), 'utf8'); return { supported: true, enabled: text.includes('X-Duprove-Autostart=true') && !text.includes('Hidden=true') } }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('AUTOSTART_READ_FAILED'); return { supported: true, enabled: false } }
}
export async function setAutostart(value: unknown) {
  if (typeof value !== 'boolean' || !app.isPackaged) throw new Error('INVALID_AUTOSTART_REQUEST')
  try {
    if (process.platform === 'linux') {
      const file = desktopFile()
      if (value) {
        // Desktop Entry escaping, followed by Exec quoted-argument escaping; no shell.
        if (/[\r\n]/.test(process.execPath)) throw new Error()
        const executable = process.execPath.replace(/%/g, '%%').replace(/(["`$\\])/g, '\\$1').replace(/\\/g, '\\\\')
        await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
        await writeFile(file, `[Desktop Entry]\nType=Application\nName=Duprove\nExec="${executable}" --autostart\nTerminal=false\nX-Duprove-Autostart=true\n`, { mode: 0o600 })
      } else { await unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error }) }
    } else app.setLoginItemSettings({ openAtLogin: value })
    return await getAutostart()
  } catch { throw new Error('AUTOSTART_SAVE_FAILED') }
}
