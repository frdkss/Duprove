import { spawn } from 'node:child_process'

export interface LocalFileResult {
  status: string; kind?: 'text' | 'image' | 'none'; sha256?: string; text?: string; data?: string
  truncated?: boolean; width?: number; height?: number
  otherSha256?: string; equal?: boolean
}
export function inspectLocalFile(executable: string, request: Record<string, unknown>): Promise<LocalFileResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['--local-file'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let output = '', bytes = 0, settled = false
    const done = (error?: Error, value?: LocalFileResult) => {
      if (settled) return
      settled = true; clearTimeout(timer)
      if (error) { child.kill(); reject(error) } else resolve(value!)
    }
    const timer = setTimeout(() => done(Error('FILE_CHECK_TIMEOUT')), ['verify', 'pair', 'trash', 'snapshot'].includes(String(request.action)) ? 120000 : 15000)
    child.on('error', () => done(Error('FILE_HELPER_UNAVAILABLE')))
    child.stderr.resume()
    child.stdin.on('error', () => {})
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk)
      if (bytes > 12 * 1024 * 1024) { done(Error('PREVIEW_OUTPUT_LIMIT')); return }
      output += chunk
    })
    child.on('close', code => {
      if (settled) return
      try {
        if (code !== 0) throw Error()
        const value = JSON.parse(output)
        if (!value || typeof value !== 'object' || typeof value.status !== 'string') throw Error()
        if (value.status === 'ready' && !/^[a-f0-9]{64}$/.test(value.sha256)) throw Error()
        done(undefined, value)
      } catch { done(Error('INVALID_FILE_HELPER_RESULT')) }
    })
    child.stdin.end(JSON.stringify(request))
  })
}
