import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { readFile, stat, unlink, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { AnalysisTimingTracker } from './analysis-timing'
import { activeJob, analysisFinished, emptySnapshot, isDiskProgress, isStartAnalysis, object, overallProgress, waitingDisk, type AnalysisSnapshot, type AnalysisDrive, type DiskProgress } from '../../contracts/analysis'
import { isContentResult } from '../../contracts/content'
import { listDrives, contentFromEvent, reportFromEvent } from './analyzer-service'
import { writeLocalJson } from './local-json'
import { ConsentService } from './consent-service'
import { prepareReport, loadPreparedReport, savePreparedReport } from './report-service'
import { CatalogService } from './catalog-service'

export const WORK_FILE_THRESHOLD = 5 * 1024 * 1024
const MAX_EVENT_BYTES = 32 * 1024 * 1024
// Legacy snapshots/events may contain diagnostic paths. Discard these at ingress;
// the live current path is kept in memory only and is unnecessary for resuming.
function cleanProgress(disk: DiskProgress, persisted = false): DiskProgress {
  return { ...disk,
    ...(disk.issues ? { issues: disk.issues.map(issue => ({ ...issue, examples: [] })) } : {}),
    ...(persisted && disk.work ? { work: { ...disk.work, current: '' } } : {}) }
}
export async function cleanupWorkFile(file: string, complete: boolean): Promise<void> {
  if (!complete) return
  try { if ((await stat(file)).size > WORK_FILE_THRESHOLD) await unlink(file) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('WORK_CLEANUP_FAILED') }
}

// No Electron or renderer dependencies. Production runs this service in a worker.
export class JobService extends EventEmitter {
  readonly catalog: CatalogService
  private timing = new AnalysisTimingTracker()
  private state = emptySnapshot()
  private child: ChildProcessWithoutNullStreams | null = null
  private busy = false
  private stopTimer: ReturnType<typeof setTimeout> | undefined
  private lastSave = 0
  private readonly stateFile: string
  private readonly database: string
  private completion: Promise<void> = Promise.resolve()
  constructor(private readonly executable: string, private readonly directory: string,
    private readonly consentFile: string, private readonly enumerate: () => Promise<AnalysisDrive[]> = () => listDrives(executable),
    private readonly launchProcess: (file: string, input: string) => ChildProcessWithoutNullStreams = (file, input) =>
      spawn(file, ['--job', input], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })) {
    super()
    this.catalog = new CatalogService(directory, executable)
    this.stateFile = path.join(directory, 'job.json')
    this.database = path.join(directory, 'work', 'index.sqlite')
  }
  snapshot(): AnalysisSnapshot { return structuredClone(this.state) }
  async restore(): Promise<void> {
    try {
      if ((await stat(this.stateFile)).size > MAX_EVENT_BYTES) throw new Error()
      const v: unknown = JSON.parse(await readFile(this.stateFile, 'utf8'))
      if (!object(v) || v.version !== 1 || typeof v.id !== 'string' || !/^[0-9a-f-]{36}$/.test(v.id)
        || !isStartAnalysis({ version: 1, roots: Array.isArray(v.drives) ? v.drives.map(d => d?.path) : [], mode: v.mode, content: v.content })
        || !Array.isArray(v.disks) || !v.disks.every(isDiskProgress) || !Array.isArray(v.drives)
        || v.drives.length !== v.disks.length || !v.drives.every((d, i) => object(d) && typeof d.name === 'string'
          && typeof d.path === 'string' && d.path === (v.disks as AnalysisSnapshot['disks'])[i].path
          && Number.isSafeInteger(d.capacity) && Number(d.capacity) >= 0 && Number.isSafeInteger(d.available) && Number(d.available) >= 0)
        || !['running', 'paused', 'stopping', 'stopped', 'interrupted', 'completed', 'error'].includes(String(v.status))) throw new Error()
      this.state = { ...emptySnapshot(), id: v.id, drives: v.drives as AnalysisDrive[], disks: v.disks.map(d => cleanProgress(d, true)),
        mode: v.mode as AnalysisSnapshot['mode'], content: v.content as boolean,
        status: v.status === 'completed' ? 'completed' : 'interrupted' }
      // Restore summaries only from the separately validated report.
      try {
        const report = loadPreparedReport(this.reportPath()).report
        if (report.statistics.disks.length !== this.state.drives.length || this.state.status === 'completed' && !report.complete) throw new Error()
        this.state.total = report.statistics.total
        if (this.state.status === 'completed' && v.error === 'CATALOG_SAVE_FAILED') this.state.error = 'CATALOG_SAVE_FAILED'
        if (v.status === 'error' && v.error === 'ANALYSIS_INCOMPLETE' && !report.complete) {
          this.state.status = 'error'; this.state.error = 'ANALYSIS_INCOMPLETE'
        }
        try {
          const content: unknown = JSON.parse(await readFile(path.join(this.directory, 'content.json'), 'utf8'))
          if (isContentResult(content, report)) this.state.warnings = { ...content.warning_pairs, limited: content.files.limit ?? 0 }
        } catch { /* Keep valid exact-match statistics if the optional content file is unavailable. */ }
      } catch { if (this.state.status === 'completed') this.state.status = 'interrupted' }
      this.state.disks.forEach(d => {
        if (analysisFinished(this.state)) { d.overall_percent = 100; d.percent = 100 }
        else {
          d.overall_percent ??= overallProgress(d, this.state.content)
          if (d.phase !== 'error') d.phase = 'stopped'
        }
      })
      this.publish(true)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { this.state.error = 'JOB_RESTORE_FAILED'; this.publish(false) }
    }
  }
  private reportPath() { return path.join(this.directory, 'reports', `${this.state.id}.json`) }
  async report() {
    if (!this.state.id) return null
    try { return loadPreparedReport(this.reportPath()).report } catch { return null }
  }
  private publish(persist = false) {
    this.state.revision++
    if (persist || Date.now() - this.lastSave >= 1000) {
      try { writeLocalJson(this.stateFile, { ...this.state, disks: this.state.disks.map(d => cleanProgress(d, true)) }) }
      catch { throw new Error('JOB_SAVE_FAILED') }
      this.lastSave = Date.now()
    }
    this.emit('snapshot', this.snapshot())
  }
  async start(request: unknown): Promise<AnalysisSnapshot> {
    if (this.catalog.locked) throw Error('CATALOG_BUSY')
    if (!isStartAnalysis(request)) throw new Error('INVALID_ANALYSIS_REQUEST')
    if (this.busy || this.child || activeJob(this.state.status)) throw new Error('ANALYSIS_BUSY')
    this.busy = true
    try {
      const available = await this.enumerate()
      const drives = request.roots.map(root => available.find(d => d.path === root))
      if (drives.some(d => !d)) throw new Error('DRIVE_UNAVAILABLE')
      this.state = { ...emptySnapshot(), revision: this.state.revision, id: randomUUID(), status: 'running',
        mode: request.mode, content: request.content, drives: drives as AnalysisDrive[], disks: request.roots.map(waitingDisk) }
      await this.launch()
      return this.snapshot()
    } finally { this.busy = false }
  }
  async command(action: unknown): Promise<AnalysisSnapshot> {
    if (this.catalog.locked) throw Error('CATALOG_BUSY')
    if (!['pause', 'resume', 'stop'].includes(String(action)) || typeof action !== 'string') throw new Error('INVALID_ANALYSIS_COMMAND')
    if (this.busy) throw new Error('ANALYSIS_BUSY')
    if (action === 'resume' && !this.child && ['stopped', 'interrupted', 'error'].includes(this.state.status) && this.state.id) {
      this.busy = true
      try { this.state.status = 'running'; this.state.error = null; this.state.total = null; this.state.warnings = null
        this.state.disks = this.state.drives.map(d => waitingDisk(d.path)); await this.launch() }
      finally { this.busy = false }
    } else {
      const valid = this.child && (action === 'pause' && this.state.status === 'running'
        || action === 'resume' && this.state.status === 'paused'
        || action === 'stop' && ['running', 'paused'].includes(this.state.status))
      if (!valid) throw new Error('INVALID_ANALYSIS_STATE')
      this.timing.reset()
      this.child!.stdin.write(JSON.stringify({ action, disk: -1 }) + '\n')
      this.state.status = action === 'pause' ? 'paused' : action === 'resume' ? 'running' : 'stopping'
      if (action === 'stop') this.stopTimer = setTimeout(() => this.child?.kill(), 5000)
      this.publish(true)
    }
    return this.snapshot()
  }
  async shutdown(): Promise<void> {
    if (this.catalog.locked) throw Error('CATALOG_BUSY')
    if (this.child && this.state.status !== 'stopping') await this.command('stop')
    await this.completion
  }
  private async launch(): Promise<void> {
    try {
      this.timing.reset()
      await mkdir(path.dirname(this.database), { recursive: true, mode: 0o700 })
      const input = path.join(this.directory, 'input.json')
      writeLocalJson(input, { roots: this.state.drives.map(d => d.path), database: this.database, private_directory: this.directory,
        load: ['low', 'medium', 'high'].indexOf(this.state.mode), content: this.state.content, managed: true })
      this.publish(true) // Durable intent precedes process creation.
      const child = this.launchProcess(this.executable, input)
      this.child = child
      let buffer = '', result: ReturnType<typeof reportFromEvent> | null = null, failed = false
      let prepared: ReturnType<typeof prepareReport> | null = null
      let content: ReturnType<typeof contentFromEvent> | null = null
      const fail = (code: string) => { failed = true; this.state.error = code; child.kill() }
      child.stdin.on('error', () => { /* exit handler settles the job */ })
      child.stderr.resume() // Never log paths or arbitrary analyzer stderr.
      child.on('error', () => fail('ANALYZER_UNAVAILABLE'))
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        if (failed) return
        buffer += chunk
        if (Buffer.byteLength(buffer) > MAX_EVENT_BYTES) { fail('ANALYZER_OUTPUT_LIMIT'); return }
        let end: number
        while ((end = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
          try {
            const event: unknown = JSON.parse(line)
            if (!object(event) || !['progress', 'result', 'error'].includes(String(event.type)) || result) throw new Error()
            if (event.type === 'error') { fail(event.code === 'ANALYSIS_STORAGE_LIMIT' ? event.code : 'ANALYZER_FAILED'); return }
            if (!Array.isArray(event.disks) || event.disks.length !== this.state.drives.length
              || !event.disks.every((d, i) => isDiskProgress(d) && path.normalize(d.path) === path.normalize(this.state.drives[i].path))) throw new Error()
            this.state.disks = event.disks.map((d, i) => ({ ...cleanProgress(d), path: this.state.drives[i].path,
              overall_percent: overallProgress(d, this.state.content, this.state.disks[i]),
              timing: this.timing.observe(d, this.state.content, this.state.status === 'running') }))
            if (event.type === 'result') {
              result = reportFromEvent(event)
              content = contentFromEvent(event)
              if (result.statistics.disks.length !== this.state.drives.length || content.enabled !== this.state.content) throw new Error()
              this.state.total = result.statistics.total
              this.state.warnings = { ...content.warning_pairs, limited: content.files.limit ?? 0 }
              // Capture consent once at creation, but do not persist a report
              // until a clean process exit confirms the final event.
              prepared = prepareReport(result, new ConsentService(this.consentFile))
              // No further commands follow a final result. Release the CLI's
              // input reader so runtime shutdown cannot wait on an open pipe.
              child.stdin.end()
            }
            this.publish()
          } catch { fail('INVALID_ANALYZER_EVENT'); return }
        }
      })
      this.completion = new Promise(resolve => child.once('close', async code => {
        this.busy = true
        if (this.stopTimer) clearTimeout(this.stopTimer)
        this.child = null
        if (!failed && buffer.trim()) { failed = true; this.state.error = 'INVALID_ANALYZER_EVENT' }
        const stopped = this.state.status === 'stopping'
        this.state.status = stopped ? 'stopped' : !failed && code === 0 && result?.complete ? 'completed' : 'error'
        if (!stopped && this.state.status === 'error' && !this.state.error) this.state.error = result && code === 0 ? 'ANALYSIS_INCOMPLETE' : 'ANALYZER_INTERRUPTED'
        if (!stopped && !failed && code === 0 && result) {
          for (const disk of this.state.disks) { disk.overall_percent = 100; disk.percent = 100 }
        }
        try {
          if (!failed && code === 0 && prepared && content) {
            savePreparedReport(this.reportPath(), prepared)
            writeLocalJson(path.join(this.directory, 'content.json'), content)
            try { await this.catalog.capture(this.database, this.state.id!, this.state.drives.map(d => d.path), !!result?.complete) }
            catch { this.state.error = 'CATALOG_SAVE_FAILED' }
          }
          this.publish(true) // Persist result/state before deleting the only working copy.
          await cleanupWorkFile(this.database, this.state.status === 'completed' && this.state.error !== 'CATALOG_SAVE_FAILED')
        } catch { this.state.error = 'JOB_SAVE_FAILED'; this.state.status = 'error'; this.emit('snapshot', this.snapshot()) }
        this.busy = false
        resolve()
      }))
    } catch { this.state.status = 'error'; this.state.error = 'JOB_START_FAILED'; this.emit('snapshot', this.snapshot()); throw new Error('JOB_START_FAILED') }
  }
}
