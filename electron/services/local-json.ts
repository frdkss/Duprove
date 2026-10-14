import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

// Small local records only: replace a complete file, never expose a partial JSON.
export function writeLocalJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    const fd = openSync(temporary, 'wx', 0o600)
    try { writeFileSync(fd, JSON.stringify(value), 'utf8'); fsyncSync(fd) }
    finally { closeSync(fd) }
    renameSync(temporary, file)
  } finally { rmSync(temporary, { force: true }) }
}
