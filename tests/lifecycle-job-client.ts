// Synthetic job events for Electron lifecycle verification. Never scans a drive.
import { EventEmitter } from 'node:events'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { emptySnapshot } from '../contracts/analysis'
export class JobClient extends EventEmitter {
  ready = Promise.resolve()
  state = emptySnapshot()
  constructor(_file: string, private options: { directory: string }) { super() }
  snapshot() { return this.state }
  async call(method: string) {
    if (method === 'start') {
      this.state = { ...this.state, revision: 1, id: 'synthetic-lifecycle', status: 'running' }
      this.emit('snapshot', this.state)
      setTimeout(() => { this.state = { ...this.state, revision: 2, status: 'completed' }; this.emit('snapshot', this.state) }, 800)
    }
    if (method === 'shutdown') {
      mkdirSync(this.options.directory, { recursive: true })
      writeFileSync(path.join(this.options.directory, 'shutdown-verified'), 'yes')
    }
    return this.state
  }
}
