import type { Summary } from './report'

export type LoadMode = 'low' | 'medium' | 'high'
export type JobStatus = 'idle' | 'running' | 'paused' | 'stopping' | 'stopped' | 'interrupted' | 'completed' | 'error'
export const phases = ['waiting', 'discovering', 'hashing', 'comparing', 'content', 'content_comparing', 'validating', 'completed', 'stopped', 'error'] as const
export type Phase = typeof phases[number]
export interface AnalysisDrive { path: string; name: string; capacity: number; available: number }
export const operations = ['initializing', 'discovering', 'preparing', 'hashing', 'comparing', 'content', 'content_comparing', 'validating', 'saving'] as const
export interface AnalysisWork {
  operation: typeof operations[number]
  current: string
  done: number
  total: number | null
  unit: 'bytes' | 'files' | 'directories'
  read_bytes: number
  files_done?: number
  files_total?: number
  cached_files?: number
}
export interface AnalysisTiming {
  updated_at: number
  advanced_at: number
  rate: number | null
  eta_seconds: number | null
  total_eta_seconds: number | null
}
export interface DiskProgress extends Summary {
  path: string; phase: Phase; errors: number; percent: number | null; overall_percent?: number
  work?: AnalysisWork
  timing?: AnalysisTiming
  issues?: AnalysisIssue[]
}
export const issueCodes = ['root_unavailable', 'directory_unavailable', 'directory_changed', 'enumeration_failed', 'metadata_unavailable', 'file_unavailable_or_changed'] as const
// examples is legacy input only: new diagnostics emit [], and JobService clears
// old values before publishing or persisting them. It never enters a report.
export interface AnalysisIssue { code: typeof issueCodes[number]; operation: AnalysisWork['operation']; count: number; examples: string[] }
export interface StartAnalysis { version: 1; roots: string[]; mode: LoadMode; content: boolean }
export interface AnalysisSnapshot {
  version: 1
  revision: number
  id: string | null
  status: JobStatus
  mode: LoadMode
  content: boolean
  drives: AnalysisDrive[]
  disks: DiskProgress[]
  total: (Summary & { duplicates: number }) | null
  warnings: { text: number; image: number; limited: number } | null
  error: string | null
  exit?: { code: number | null; signal: string | null }
}
export function isAnalysisExit(v: unknown): v is NonNullable<AnalysisSnapshot['exit']> {
  return object(v) && Object.keys(v).length === 2
    && (v.code === null || typeof v.code === 'number' && Number.isInteger(v.code) && v.code >= -2147483648 && v.code <= 4294967295)
    && (v.signal === null || typeof v.signal === 'string' && /^SIG[A-Z0-9]{1,16}$/.test(v.signal))
}
export type AnalysisCommand = 'pause' | 'resume' | 'stop'
export const isMode = (v: unknown): v is LoadMode => v === 'low' || v === 'medium' || v === 'high'
export const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const counter = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
export function isStartAnalysis(v: unknown): v is StartAnalysis {
  return object(v) && Object.keys(v).length === 4 && v.version === 1 && isMode(v.mode) && typeof v.content === 'boolean'
    && Array.isArray(v.roots) && v.roots.length > 0 && v.roots.length <= 64
    && v.roots.every(p => typeof p === 'string' && p.length > 0 && p.length <= 32768 && !p.includes('\0'))
    && new Set(v.roots).size === v.roots.length
}
export function isDiskProgress(v: unknown): v is DiskProgress {
  return object(v) && Object.keys(v).length === 9 + ['overall_percent', 'work', 'timing', 'issues'].filter(k => Object.hasOwn(v, k)).length
    && (!Object.hasOwn(v, 'issues') || Array.isArray(v.issues) && v.issues.length <= 16
      && v.issues.every(i => object(i) && Object.keys(i).length === 4 && issueCodes.includes(i.code as AnalysisIssue['code'])
        && operations.includes(i.operation as AnalysisWork['operation']) && counter(i.count) && i.count > 0
        && Array.isArray(i.examples) && i.examples.length <= 3 && i.examples.every(p => typeof p === 'string' && p.length > 0 && p.length <= 1024 && !p.includes('\0')))
      && v.issues.reduce((sum, i) => sum + i.count, 0) <= Number(v.errors))
    && (!Object.hasOwn(v, 'work') || isWork(v.work))
    && (!Object.hasOwn(v, 'timing') || isTiming(v.timing))
    && (!Object.hasOwn(v, 'overall_percent') || typeof v.overall_percent === 'number' && Number.isFinite(v.overall_percent) && v.overall_percent >= 0 && v.overall_percent <= 100)
    && typeof v.path === 'string' && phases.includes(v.phase as Phase)
    && ['files', 'empty', 'duplicate_members', 'duplicate_groups', 'errors'].every(k => counter(v[k]))
    && (v.percent === null || typeof v.percent === 'number' && Number.isFinite(v.percent) && v.percent >= 0 && v.percent <= 100)
    && object(v.types) && Object.entries(v.types).every(([k, n]) => k.length <= 256 && counter(n))
    && Object.values(v.types).reduce<number>((a, n) => a + (n as number), 0) === v.files
    && (v.empty as number) <= (v.files as number) && (v.duplicate_members as number) <= (v.files as number)
}
function isWork(v: unknown): v is AnalysisWork {
  return object(v) && Object.keys(v).length === (Object.hasOwn(v, 'files_done') ? 8 : 6) + (Object.hasOwn(v, 'cached_files') ? 1 : 0)
    && (!Object.hasOwn(v, 'cached_files') || counter(v.cached_files) && counter(v.files_done) && v.cached_files <= v.files_done)
    && (!Object.hasOwn(v, 'files_done') || counter(v.files_done) && counter(v.files_total) && v.files_done <= v.files_total)
    && operations.includes(v.operation as AnalysisWork['operation'])
    && typeof v.current === 'string' && v.current.length <= 32768 && !v.current.includes('\0')
    && counter(v.done) && (v.total === null || counter(v.total) && v.done <= v.total)
    && ['bytes', 'files', 'directories'].includes(String(v.unit)) && counter(v.read_bytes)
}
function isTiming(v: unknown): v is AnalysisTiming {
  return object(v) && Object.keys(v).length === 5 && counter(v.updated_at) && counter(v.advanced_at)
    && ['rate', 'eta_seconds', 'total_eta_seconds'].every(k => v[k] === null || typeof v[k] === 'number' && Number.isFinite(v[k]) && Number(v[k]) >= 0)
}
export function emptySnapshot(): AnalysisSnapshot {
  return { version: 1, revision: 0, id: null, status: 'idle', mode: 'low', content: false, drives: [], disks: [], total: null, warnings: null, error: null }
}
export function waitingDisk(path: string): DiskProgress {
  return { path, phase: 'waiting', files: 0, empty: 0, duplicate_members: 0, duplicate_groups: 0, errors: 0, percent: null, overall_percent: 0, types: {} }
}
// Equal shares for inventory, hashes, bytes, optional extraction/pairs, validation.
// Inventory is an explicit estimate against the directory frontier seen so far.
export function overallProgress(disk: DiskProgress, content: boolean, previous?: DiskProgress): number {
  if (disk.phase === 'completed') return 100
  const stages = content ? 6 : 4
  const before = previous?.overall_percent ?? 0
  if (disk.phase === 'waiting') {
    const finished = previous?.phase === 'discovering' ? 1 : previous?.phase === 'hashing' ? 2 : 0
    return Math.max(before, finished * 100 / stages)
  }
  if (disk.phase === 'stopped' || disk.phase === 'error') return before
  const stage = { discovering: 0, hashing: 1, comparing: 2, content: 3, content_comparing: 4, validating: stages - 1 }[disk.phase]
  if (stage === undefined) return before
  const fraction = (disk.percent ?? 0) / 100
  return Math.min(99.99, Math.max(before, (stage + fraction) * 100 / stages))
}
export function progressText(percent: number): string {
  return (percent < 100 ? Math.min(99.99, percent) : 100).toLocaleString('ru-RU', { maximumFractionDigits: 2 })
}
export const activeJob = (status: JobStatus) => status === 'running' || status === 'paused' || status === 'stopping'
// A final report with recoverable file errors still represents a finished run.
export const analysisFinished = (job: AnalysisSnapshot) => job.status === 'completed'
  || job.status === 'error' && job.error === 'ANALYSIS_INCOMPLETE' && job.total !== null
