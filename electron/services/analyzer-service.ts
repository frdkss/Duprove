import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { isReport } from '../../contracts/validate'
import type { Report } from '../../contracts/report'
import { isContentResult, type ContentResult } from '../../contracts/content'
import type { Drive } from '../bridge'

const execute = promisify(execFile)
export async function listDrives(executable: string): Promise<Drive[]> {
  try {
    const { stdout } = await execute(executable, ['--drives'], { encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024, windowsHide: true })
    const data: unknown = JSON.parse(stdout)
    if (!Array.isArray(data) || !data.every(x => x && typeof x.path === 'string' && typeof x.name === 'string' &&
      Number.isSafeInteger(x.capacity) && x.capacity >= 0 && Number.isSafeInteger(x.available) && x.available >= 0)) throw new Error()
    return data.map(x => ({ path: x.path, name: x.name, capacity: x.capacity, available: x.available }))
  } catch { throw new Error('ANALYZER_UNAVAILABLE') }
}


export function reportFromEvent(event: unknown): Report {
  if (!event || typeof event !== 'object' || !('type' in event) || event.type !== 'result' ||
    !('report' in event) || !isReport(event.report)) throw new Error('INVALID_REPORT')
  return event.report
}

export function contentFromEvent(event: unknown): ContentResult {
  const report = reportFromEvent(event)
  if (!event || typeof event !== 'object' || !('content' in event) || !isContentResult(event.content, report))
    throw new Error('INVALID_CONTENT_RESULT')
  return event.content
}
