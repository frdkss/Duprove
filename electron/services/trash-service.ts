import { isTrashRequest, type TrashPlan, type TrashResult } from '../../contracts/catalog'
import { fileGuard } from './file-guard'

type Rpc = (method: 'trashPrepare' | 'trashVerify' | 'trashRecord' | 'trashRelease', value: unknown) => Promise<unknown>
export class TrashService {
  busy = false
  constructor(private readonly rpc: Rpc, private readonly confirm: (plan: TrashPlan) => Promise<boolean>,
    private readonly trash: (file: string, lease: { token: string; fileId: number }) => Promise<void>, private readonly blocked: () => boolean) {}
  async run(value: unknown): Promise<TrashResult> {
    if (!isTrashRequest(value)) throw Error('INVALID_TRASH_REQUEST')
    if (this.busy || this.blocked()) throw Error('CATALOG_BUSY')
    this.busy = true
    let plan: TrashPlan | undefined
    try {
      plan = await this.rpc('trashPrepare', value) as TrashPlan
      if (!await this.confirm(plan)) return { cancelled: true, results: [] }
      const results: TrashResult['results'] = []
      for (const entry of plan.entries) {
        let moved = false
        const request = { token: plan.token, fileId: entry.fileId }
        try {
          const verified = await this.rpc('trashVerify', request) as { path: string; originalPath: string; guard: string; originalGuard: string }
          if (verified.path !== entry.path || verified.originalPath !== entry.originalPath
            || await fileGuard(verified.path) !== verified.guard || await fileGuard(verified.originalPath) !== verified.originalGuard) throw Error('FILE_CHANGED')
          await this.trash(verified.path, request)
          moved = true
          await this.rpc('trashRecord', { ...request, success: true })
          results.push({ fileId: entry.fileId, status: 'trashed' })
        } catch (error) {
          const uncertain = error instanceof Error && error.message.includes('TRASH_RESULT_UNCERTAIN')
          if (moved) {
            // Retrying the local acknowledgement never repeats the OS operation.
            try { await this.rpc('trashRecord', { ...request, success: true }); results.push({ fileId: entry.fileId, status: 'trashed' }); continue } catch { /* uncertain durable state */ }
          } else if (!uncertain) {
            try { await this.rpc('trashRecord', { ...request, success: false }) } catch { /* pending intent remains blocked */ }
          }
          results.push({ fileId: entry.fileId, status: 'error', error: moved || uncertain ? 'TRASH_RESULT_UNCERTAIN' : 'TRASH_FAILED_OR_FILE_CHANGED' })
        }
      }
      return { cancelled: false, results }
    } finally {
      try { if (plan) await this.rpc('trashRelease', { token: plan.token }) } finally { this.busy = false }
    }
  }
}
