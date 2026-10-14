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
