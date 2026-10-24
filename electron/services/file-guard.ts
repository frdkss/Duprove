import { lstat } from 'node:fs/promises'
import path from 'node:path'

export async function fileGuard(file: string): Promise<string> {
  if (!path.isAbsolute(file) || file.includes('\0')) throw Error('UNSAFE_PATH')
  const parsed = path.parse(file)
  let current = parsed.root
  const parts = path.relative(parsed.root, file).split(path.sep)
  if (parts.some(part => part === '..' || !part || part === '.')) throw Error('UNSAFE_PATH')
  for (let i = -1; i < parts.length; i++) {
    if (i >= 0) current = path.join(current, parts[i])
    const entry = await lstat(current, { bigint: true })
    if (entry.isSymbolicLink() || (i < parts.length - 1 ? !entry.isDirectory() : !entry.isFile())) throw Error('UNSAFE_PATH')
    if (i === parts.length - 1) return [entry.dev, entry.ino, entry.size, entry.mtimeNs, entry.ctimeNs].join(':')
  }
  throw Error('UNSAFE_PATH')
}
