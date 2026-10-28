import Ajv from 'ajv'
import schema from './report.schema.json'
import type { Report, Summary } from './report'

const structural = new Ajv({ strict: true }).compile<Report>(schema)
const sum = (values: number[]) => values.reduce((a, b) => a + BigInt(b), 0n)
const count = (values: Record<string, number>) => sum(Object.values(values))
const same = (a: number, b: bigint) => BigInt(a) === b


export function isReport(value: unknown): value is Report {
  if (!structural(value)) return false
  const { statistics: s, duplicates: groups } = value
  const summaries: Summary[] = [s.total, ...s.disks, s.locations.standard.total,
    ...Object.values(s.locations.standard.categories), s.locations.custom]
  const byteReport = summaries.some(x => x.file_bytes !== undefined || x.duplicate_bytes !== undefined)
    || groups.some(g => g.size_bytes !== undefined) || s.total.reclaimable_bytes !== undefined
  if (byteReport) {
    if (summaries.some(x => x.file_bytes === undefined || x.duplicate_bytes === undefined || x.duplicate_bytes > x.file_bytes)
      || groups.some(g => g.size_bytes === undefined) || s.total.reclaimable_bytes === undefined) return false
    const groupBytes = (key: string, field: 'disks' | 'categories') => groups.reduce((n, g) =>
      n + BigInt((g[field] as Record<string, number>)[key] ?? 0) * BigInt(g.size_bytes!), 0n)
    if (!same(s.total.duplicate_bytes!, groups.reduce((n, g) => n + BigInt(g.copies) * BigInt(g.size_bytes!), 0n))
      || !same(s.total.reclaimable_bytes, groups.reduce((n, g) => n + BigInt(g.duplicates) * BigInt(g.size_bytes!), 0n))
      || s.disks.some(d => !same(d.duplicate_bytes!, groupBytes(String(d.id), 'disks')))
      || Object.entries(s.locations.standard.categories).some(([k, x]) => !same(x.duplicate_bytes!, groupBytes(k, 'categories')))
      || !same(s.locations.custom.duplicate_bytes!, groupBytes('custom', 'categories'))) return false
    const bytePartition = (total: Summary, parts: Summary[]) => ['file_bytes', 'duplicate_bytes'].every(k =>
      same(total[k as 'file_bytes']!, sum(parts.map(p => p[k as 'file_bytes']!))))
    if (!bytePartition(s.total, s.disks) || !bytePartition(s.total, [s.locations.standard.total, s.locations.custom])
      || !bytePartition(s.locations.standard.total, Object.values(s.locations.standard.categories))) return false
  }
  const volumes = [s.total, ...s.disks]
  const volumeKeys = ['capacity_bytes', 'available_bytes', 'used_bytes'] as const
  if (volumes.some(x => volumeKeys.some(k => x[k] !== undefined))) {
    if (volumes.some(x => volumeKeys.some(k => x[k] === undefined)
      || BigInt(x.used_bytes!) + BigInt(x.available_bytes!) !== BigInt(x.capacity_bytes!))
      || volumeKeys.some(k => !same(s.total[k]!, sum(s.disks.map(d => d[k]!))))) return false
  }
  if (value.progress && (value.progress.disks.length !== s.disks.length || value.complete && value.progress.status !== 'completed'
    || value.progress.disks.some((d, i) => d.id !== i || d.work && (
      d.work.total !== null && d.work.done > d.work.total
      || (d.work.files_done === undefined) !== (d.work.files_total === undefined)
      || d.work.files_done !== undefined && d.work.files_done > d.work.files_total!
      || d.work.cached_files !== undefined && (d.work.files_done === undefined || d.work.cached_files > d.work.files_done))))) return false
  if (summaries.some(x => !same(x.files, count(x.types)) || x.empty !== (x.types.empty ?? 0) ||
    x.duplicate_members > x.files - x.empty || x.duplicate_groups > x.duplicate_members)) return false
  if (s.disks.some((disk, i) => disk.id !== i)) return false
  if (!same(s.total.duplicates, sum(groups.map(g => g.duplicates))) || s.total.duplicate_groups !== groups.length ||
    !same(s.total.duplicate_members, sum(groups.map(g => g.copies)))) return false
  const membersByType: Record<string, number[]> = Object.create(null)
  for (const g of groups) {
    if (g.duplicates !== g.copies - 1 || !same(g.copies, count(g.extensions)) ||
      !same(g.copies, count(g.disks)) || !same(g.copies, count(g.categories as Record<string, number>)) ||
      Object.keys(g.disks).some(id => Number(id) >= s.disks.length)) return false
    for (const [ext, n] of Object.entries(g.extensions)) (membersByType[ext] ??= []).push(n)
  }
  if (Object.entries(membersByType).some(([ext, ns]) => sum(ns) > BigInt(s.total.types[ext] ?? 0))) return false
  const checkMembers = (x: Summary, key: string, field: 'disks' | 'categories') =>
    same(x.duplicate_members, sum(groups.map(g => (g[field] as Record<string, number>)[key] ?? 0))) &&
    x.duplicate_groups === groups.filter(g => key in g[field]).length
  if (s.disks.some(x => !checkMembers(x, String(x.id), 'disks'))) return false
  if (Object.entries(s.locations.standard.categories).some(([key, x]) => !checkMembers(x, key, 'categories')) ||
    !checkMembers(s.locations.custom, 'custom', 'categories')) return false
  const standardGroups = groups.filter(g => Object.keys(g.categories).some(k => k !== 'custom')).length
  if (s.locations.standard.total.duplicate_groups !== standardGroups) return false
  const partition = (total: Summary, parts: Summary[]) => {
    if (['files', 'empty', 'duplicate_members'].some(k => !same(total[k as 'files'], sum(parts.map(p => p[k as 'files']))))) return false
    const keys = new Set([...Object.keys(total.types), ...parts.flatMap(p => Object.keys(p.types))])
    return [...keys].every(k => same(total.types[k] ?? 0, sum(parts.map(p => p.types[k] ?? 0))))
  }
  return partition(s.total, s.disks) && partition(s.total, [s.locations.standard.total, s.locations.custom]) &&
    partition(s.locations.standard.total, Object.values(s.locations.standard.categories))
}

export function serializeReport(value: unknown): string {
  if (!isReport(value)) throw new Error('INVALID_REPORT')
  return JSON.stringify(value)
}
