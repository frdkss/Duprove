import { Worker } from 'node:worker_threads'
import { EventEmitter } from 'node:events'
import { activeJob, emptySnapshot, type AnalysisSnapshot } from '../../contracts/analysis'

// Main keeps only a small snapshot. Parsing reports and fsync never block UI IPC.
export class JobClient extends EventEmitter {
  private state = emptySnapshot()
  private serial = 0
  private failed = false
  private disposed = false
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  readonly ready: Promise<void>
  private worker: Worker
  constructor(file: string, options: { executable: string; directory: string; consentFile: string }) {
    super()
    this.worker = new Worker(file, { workerData: options, resourceLimits: { maxOldGenerationSizeMb: 256 } })
    let ready!: () => void
    this.ready = new Promise(resolve => { ready = resolve })
    this.worker.on('message', message => {
      if (message.snapshot) { this.state = message.snapshot; this.emit('snapshot', this.snapshot()) }
      if (message.ready) ready()
      if (message.id) {
        const pending = this.pending.get(message.id)
        if (pending) { this.pending.delete(message.id); if (message.error) pending.reject(new Error(message.error)); else pending.resolve(message.result) }
      }
    })
    const fail = () => {
      if (this.disposed) return
      this.failed = true; ready()
      for (const pending of this.pending.values()) pending.reject(new Error('ANALYSIS_WORKER_FAILED'))
      this.pending.clear()
      if (activeJob(this.state.status)) this.state.status = 'interrupted'
      this.state.error = 'ANALYSIS_WORKER_FAILED'
      this.emit('snapshot', this.snapshot())
    }
    this.worker.on('error', fail)
    this.worker.on('exit', fail)
  }
  snapshot(): AnalysisSnapshot { return structuredClone(this.state) }
  async dispose(): Promise<void> {
    try { if (!this.failed) await this.call('shutdown') }
    finally { this.disposed = true; await this.worker.terminate() }
  }
  async call(method: 'start' | 'command' | 'report' | 'shutdown', value?: unknown): Promise<unknown> {
    await this.ready
    if (this.failed) throw new Error('ANALYSIS_WORKER_FAILED')
    return new Promise((resolve, reject) => {
      const id = ++this.serial
      this.pending.set(id, { resolve, reject })
      this.worker.postMessage({ id, method, value })
    })
  }
}
