import { EventEmitter } from 'node:events'
import { mkdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import type { UpdateSnapshot } from '../../contracts/update'
import { assetUrl, compareVersions, selectTarget, stableVersion, verifyManifest, type UpdateHost, type UpdateTarget } from './update-manifest'
import { writeLocalJson } from './local-json'

const interval = 6 * 60 * 60000
const retries = [60000, 5 * 60000, 30 * 60000, interval, 24 * 60 * 60000]
export interface UpdateTransport {
  releases(signal: AbortSignal): Promise<unknown>
  bytes(url: string, maximum: number, signal: AbortSignal): Promise<Buffer>
  download(version: string, target: UpdateTarget, file: string, signal: AbortSignal, progress: (percent: number) => void): Promise<void>
}
export interface UpdateInstaller {
  prepare(file: string, version: string, target: UpdateTarget): Promise<void>
  install(): Promise<void>
}
interface Options {
  directory: string; version: string; publicKey: string; host: UpdateHost | null
  transport: UpdateTransport; installer: UpdateInstaller
  busy(): boolean; notify(version: string): void
  now?: () => number
}
export class UpdateService extends EventEmitter {
  private state: UpdateSnapshot
  private failures = 0
  private inFlight: Promise<void> | null = null
  private controller = new AbortController()
  private timer?: ReturnType<typeof setInterval>
  private stopped = false
  private prepared = false
  private installing = false
  private blockedVersion: string | null = null
  private now: () => number
  constructor(private options: Options) {
    super(); this.now = options.now ?? Date.now
    this.state = { revision: 0, status: options.host && options.publicKey && stableVersion(options.version) ? 'idle' : 'unavailable',
      currentVersion: options.version, availableVersion: null, percent: null, restartAt: null, nextCheckAt: null, error: null }
  }
  snapshot(): UpdateSnapshot { return { ...this.state } }
  // The main process uses this synchronously before accepting start/resume IPC.
  get blocksAnalysis(): boolean { return this.installing }
  private change(patch: Partial<UpdateSnapshot>) { this.state = { ...this.state, ...patch, revision: this.state.revision + 1 }; this.emit('snapshot', this.snapshot()) }
  async start() {
    if (this.state.status === 'unavailable' || this.timer || this.stopped) return
    try {
      const result = JSON.parse(await readFile(path.join(this.options.directory, 'result.json'), 'utf8'))
      if (result.schema === 1 && ['rolled-back', 'failed'].includes(result.status)) {
        const transaction = JSON.parse(await readFile(path.join(this.options.directory, 'transaction.json'), 'utf8'))
        if (stableVersion(transaction.version)) {
          writeLocalJson(path.join(this.options.directory, 'blocked.json'), { version: transaction.version })
          this.change({ status: 'error', error: 'UPDATE_FAILED' })
        }
      }
    } catch {}
    try {
      const blocked = JSON.parse(await readFile(path.join(this.options.directory, 'blocked.json'), 'utf8'))
      if (stableVersion(blocked.version)) this.blockedVersion = blocked.version
    } catch {}
    try {
      const saved = JSON.parse(await readFile(path.join(this.options.directory, 'schedule.json'), 'utf8'))
      if (saved.schema !== 1 || !Number.isSafeInteger(saved.failures) || saved.failures < 0 || !Number.isSafeInteger(saved.nextCheckAt)) throw Error()
      this.failures = Math.min(saved.failures, retries.length)
      this.state.nextCheckAt = Math.min(saved.nextCheckAt, this.now() + retries.at(-1)!)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.failures = 1; this.state.nextCheckAt = this.now() + retries[0]
      }
    }
    if (this.stopped) return
    this.timer = setInterval(() => { void this.tick() }, 1000); this.timer.unref()
    await this.tick()
  }
  tick(): Promise<void> {
    if (this.stopped || this.state.status === 'unavailable' || this.installing) return Promise.resolve()
    if (this.inFlight) return this.inFlight
    this.inFlight = this.advance().finally(() => { this.inFlight = null })
    return this.inFlight
  }
  private schedule(delay: number) {
    const nextCheckAt = this.now() + delay
    // Persist before any network request, including across process restarts.
    writeLocalJson(path.join(this.options.directory, 'schedule.json'), { schema: 1, failures: this.failures, nextCheckAt })
    this.change({ nextCheckAt })
  }
  private async advance(): Promise<void> {
    try {
      if (this.prepared) {
        if (this.options.busy()) { if (this.state.status !== 'waiting') this.change({ status: 'waiting', restartAt: null }); return }
        if (this.state.restartAt === null) {
          this.change({ status: 'scheduled', restartAt: this.now() + 60000 })
          this.options.notify(this.state.availableVersion!); return
        }
        if (this.now() < this.state.restartAt) return
        // No await between busy check and locking start/resume commands.
        this.installing = true; this.change({ status: 'installing' })
        await this.options.installer.install()
        return
      }
      if (this.state.nextCheckAt !== null && this.now() < this.state.nextCheckAt) return
      this.schedule(retries[Math.min(this.failures, retries.length - 1)])
      this.change({ status: 'checking', error: null, percent: null, availableVersion: null })
      const releases = await this.options.transport.releases(this.controller.signal)
      if (!Array.isArray(releases)) throw Error('UPDATE_RELEASES_INVALID')
      const candidates = releases.filter(r => r && r.draft === false && r.prerelease === false && typeof r.tag_name === 'string'
        && r.tag_name.startsWith('v') && stableVersion(r.tag_name.slice(1)) && r.tag_name.slice(1) !== this.blockedVersion && compareVersions(r.tag_name.slice(1), this.options.version) > 0)
        .sort((a, b) => compareVersions(b.tag_name.slice(1), a.tag_name.slice(1))).slice(0, 10)
      for (const release of candidates) {
        if (this.stopped) return
        const version = release.tag_name.slice(1)
        const manifest = verifyManifest(await this.options.transport.bytes(assetUrl(version, 'stable.json'), 65536, this.controller.signal), this.options.publicKey, version)
        const target = selectTarget(manifest, this.options.host!)
        if (!target) continue
        const file = path.join(this.options.directory, `package.${target.format === 'nsis' ? 'exe' : 'tar.gz'}`)
        await mkdir(this.options.directory, { recursive: true, mode: 0o700 })
        await rm(file, { force: true })
        this.change({ status: 'downloading', availableVersion: version, percent: 0 })
        await this.options.transport.download(version, target, file, this.controller.signal, percent => {
          if (percent !== this.state.percent) this.change({ percent })
        })
        if (this.stopped) return
        await this.options.installer.prepare(file, version, target)
        this.prepared = true
        this.change({ status: 'waiting', percent: 100 })
        break
      }
      this.failures = 0; this.schedule(interval)
      if (!this.prepared) this.change({ status: 'idle' })
    } catch {
      this.installing = false; this.prepared = false
      if (this.stopped) return
      this.failures = Math.min(this.failures + 1, retries.length)
      try { this.schedule(retries[this.failures - 1]) } catch { this.state.nextCheckAt = this.now() + interval }
      this.change({ status: 'error', error: 'UPDATE_FAILED', restartAt: null, percent: null })
    }
  }
  async stop() {
    this.stopped = true; clearInterval(this.timer); this.controller.abort()
    await this.inFlight
  }
}
