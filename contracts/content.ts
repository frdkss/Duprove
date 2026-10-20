import type { Category, Report } from './report'

export const contentStatuses = ['ready', 'empty', 'unsupported', 'invalid', 'protected', 'limit', 'unavailable', 'stopped'] as const
export interface ContentFile {
  id: number
  disk: number
  extension: string
  category: Category
}
export interface ContentResult {
  enabled: boolean
  policy_version: 1
  complete: boolean
  files: Partial<Record<typeof contentStatuses[number], number>>
  warning_pairs: { text: number; image: number }
  warnings: { status: 'warn'; kind: 'text' | 'image'; files: [ContentFile, ContentFile] }[]
}

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const keys = (v: Record<string, unknown>, expected: readonly string[]) =>
  Object.keys(v).length === expected.length && expected.every(k => Object.hasOwn(v, k))
const counter = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
const categories = ['downloads', 'documents', 'videos', 'pictures', 'music', 'desktop', 'custom']
const extensions = { text: ['.txt', '.md', '.markdown', '.docx'], image: ['.png', '.jpg', '.jpeg'] }

// This is a local result contract. It is deliberately not part of Report v1.
export function isContentResult(value: unknown, report: Report): value is ContentResult {
  if (!object(value) || !keys(value, ['enabled', 'policy_version', 'complete', 'files', 'warning_pairs', 'warnings']) ||
    typeof value.enabled !== 'boolean' || value.policy_version !== 1 || typeof value.complete !== 'boolean' ||
    !object(value.files) || !object(value.warning_pairs) || !keys(value.warning_pairs, ['text', 'image']) ||
    !counter(value.warning_pairs.text) || !counter(value.warning_pairs.image) || !Array.isArray(value.warnings)) return false
  if (!value.enabled) return value.complete && keys(value.files, []) && value.warnings.length === 0 &&
    value.warning_pairs.text === 0 && value.warning_pairs.image === 0
  if (!keys(value.files, contentStatuses) || !Object.values(value.files).every(counter)) return false
  const counts = value.files as Record<typeof contentStatuses[number], number>
  if (Object.values(counts).reduce((a, n) => a + BigInt(n), 0n) !== BigInt(report.statistics.total.files) ||
    (value.complete && (!report.complete || counts.unavailable > 0 || counts.stopped > 0 || counts.empty < report.statistics.total.empty))) return false
  const pairs = new Set<string>(), knownFiles = new Map<number, string>()
  const totals = { text: 0, image: 0 }
  for (const warning of value.warnings) {
    if (!object(warning) || !keys(warning, ['status', 'kind', 'files']) || warning.status !== 'warn' ||
      (warning.kind !== 'text' && warning.kind !== 'image') || !Array.isArray(warning.files) || warning.files.length !== 2) return false
    const ids: number[] = []
    for (const file of warning.files) {
      if (!object(file) || !keys(file, ['id', 'disk', 'extension', 'category']) ||
        !counter(file.id) || file.id === 0 || !counter(file.disk) || file.disk >= report.statistics.disks.length ||
        typeof file.extension !== 'string' || !extensions[warning.kind].includes(file.extension) ||
        typeof file.category !== 'string' || !categories.includes(file.category)) return false
      const metadata = JSON.stringify([file.disk, file.extension, file.category])
      if (knownFiles.has(file.id) && knownFiles.get(file.id) !== metadata) return false
      knownFiles.set(file.id, metadata)
      ids.push(file.id)
    }
    if (ids[0] >= ids[1]) return false
    const pair = ids.join(':')
    if (pairs.has(pair)) return false
    pairs.add(pair)
    totals[warning.kind]++
  }
  return knownFiles.size <= counts.ready && totals.text === value.warning_pairs.text && totals.image === value.warning_pairs.image
}
