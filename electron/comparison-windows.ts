import { BrowserWindow, screen } from 'electron'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileValid } from '../contracts/catalog'
import { isComparisonRequest, viewerKind, type ComparisonContext, type ComparisonDocument, type ComparisonRequest, type ComparisonSnapshot } from '../contracts/comparison'
import { channels } from './bridge'
import { previewResponse } from './services/preview-stream'

type Rpc = (method: 'comparison' | 'comparisonFile' | 'comparisonClose', value: unknown) => Promise<unknown>
export class ComparisonWindows {
  private window: BrowserWindow | null = null
  private request: ComparisonRequest | null = null
  private context: ComparisonContext | null = null
  private loaded = new Map<number, Promise<ComparisonDocument>>()
  private assets = new Map<number, { file: string; mime: string }>()
  constructor(private readonly rpc: Rpc, private readonly options: { preload: string; index: string; devURL?: string; icon?: string; show?: boolean; busy(): boolean }) {}
  async open(value: unknown, parent: BrowserWindow): Promise<void> {
    if (!isComparisonRequest(value)) throw Error('INVALID_COMPARISON_REQUEST')
    const context = await this.rpc('comparison', value) as ComparisonContext
    const old = this.context?.sessionId
    this.request = value; this.context = { ...context, sessionId: randomUUID() }; this.loaded.clear(); this.assets.clear()
    if (old) void this.rpc('comparisonClose', old).catch(() => {})
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.send(channels.comparisonChanged, this.context)
      if (this.window.isMinimized()) this.window.restore()
      if (this.options.show !== false) { this.window.show(); this.window.focus() }
      return
    }
    const area = screen.getDisplayMatching(parent.getBounds()).workArea
    const window = this.window = new BrowserWindow({ width: Math.max(640, area.width - 64), height: Math.max(480, area.height - 64),
      minWidth: 640, minHeight: 480, frame: false, parent, modal: false, show: false, autoHideMenuBar: true, icon: this.options.icon,
      enableLargerThanScreen: true, backgroundColor: '#141e1b', webPreferences: { preload: this.options.preload,
        contextIsolation: true, sandbox: true, nodeIntegration: false, offscreen: this.options.show === false, backgroundThrottling: false } })
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', event => event.preventDefault())
    window.on('close', event => { if (this.options.busy()) event.preventDefault() })
    window.on('closed', () => {
      const sessionId = this.context?.sessionId
      this.window = null; this.context = null; this.request = null; this.loaded.clear(); this.assets.clear()
      if (sessionId) void this.rpc('comparisonClose', sessionId).catch(() => {})
    })
    parent.once('closed', () => { if (!window.isDestroyed()) window.destroy() })
    if (this.options.devURL) await window.loadURL(this.options.devURL + '/#comparison')
    else await window.loadFile(this.options.index, { hash: 'comparison' })
    if (this.options.show !== false) window.show()
  }
  get(senderId: number): ComparisonContext {
    if (!this.window || this.window.webContents.id !== senderId || !this.context) throw Error('INVALID_COMPARISON_WINDOW')
    return this.context
  }
  async document(senderId: number, fileId: unknown): Promise<ComparisonDocument> {
    const context = this.get(senderId)
    if (!fileValid(fileId) || !context.files.some(file => file.id === fileId)) throw Error('INVALID_COMPARISON_FILE')
    let result = this.loaded.get(fileId)
    if (!result) {
      result = this.rpc('comparisonFile', { analysisId: context.analysisId, groupId: context.groupId, fileId, sessionId: context.sessionId }).then(value => {
        const snapshot = value as ComparisonSnapshot
        if (this.context?.sessionId !== context.sessionId) throw Error('COMPARISON_CLOSED')
        const kind = viewerKind(snapshot.name)
        let url: string | undefined
        if (snapshot.status === 'ready' && snapshot.snapshot) {
          const mime = mimeType(snapshot.name)
          this.assets.set(fileId, { file: snapshot.snapshot, mime })
          url = `duprove-preview://${context.sessionId}/${fileId}`
        }
        const { snapshot: _privatePath, sha256: _hash, ...display } = snapshot
        return { ...display, kind, url }
      }).catch(error => { if (this.loaded.get(fileId) === result) this.loaded.delete(fileId); throw error })
      this.loaded.set(fileId, result)
    }
    return result
  }
  async changed(analysisId: string, groupId: string, reset = false) {
    if (!this.request || this.request.analysisId !== analysisId || this.request.groupId !== groupId || !this.window) return
    const context = await this.rpc('comparison', this.request) as ComparisonContext
    const old = this.context?.sessionId
    if (reset) { this.loaded.clear(); this.assets.clear() }
    this.context = { ...context, sessionId: reset ? randomUUID() : old }
    this.window.webContents.send(channels.comparisonChanged, this.context)
    if (reset && old) void this.rpc('comparisonClose', old).catch(() => {})
  }
  async response(request: Request) {
    const url = new URL(request.url), id = Number(url.pathname.slice(1)), asset = this.assets.get(id)
    if (url.hostname !== this.context?.sessionId || !asset || url.search || url.hash) return new Response(null, { status: 404 })
    try { return await previewResponse(request, asset.file, asset.mime) } catch { return new Response(null, { status: 404 }) }
  }
}
function mimeType(name: string) {
  const types: Record<string, string> = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.wave': 'audio/wav', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg',
    '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.mp4': 'video/mp4', '.webm': 'video/webm', '.ogv': 'video/ogg', '.mov': 'video/quicktime' }
  return types[path.extname(name).toLowerCase()] ?? 'application/octet-stream'
}
