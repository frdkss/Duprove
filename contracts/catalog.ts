import { object } from './analysis'

export const groupKinds = ['exact', 'warn_text', 'warn_image'] as const
export type GroupKind = typeof groupKinds[number]
export const decisions = ['unresolved', 'keep', 'review', 'delete', 'trashed'] as const
export type Decision = typeof decisions[number]
export interface CatalogInfo {
  analysisId: string; createdAt: number; complete: boolean
  groups: Record<GroupKind, number>; files: number; expiresAt: number
}
export interface FileGroup {
  id: string; name: string; kind: GroupKind; count: number; bytes: number; originalId: number | null
}
export interface GroupMember {
  id: number; name: string; path: string; size: number; availability: 'available' | 'missing' | 'changed' | 'unavailable'
  decision: Decision; protected: boolean
  lastOperation?: string | null
}
export interface Page<T> { items: T[]; total: number; offset: number; limit: number }
export interface FilePreview {
  id: number; path: string; status: string; kind: 'text' | 'image' | 'none'
  text?: string; data?: string; truncated?: boolean; width?: number; height?: number
}
export interface PreviewPair { original: FilePreview; candidate: FilePreview }
export interface TrashRequest { analysisId: string; groupId: string; fileIds: number[] }
export interface TrashPlan { token: string; entries: { fileId: number; path: string; originalPath: string; kind: GroupKind }[] }
export interface TrashResult { cancelled: boolean; results: { fileId: number; status: 'trashed' | 'error'; error?: string }[] }
export function isTrashRequest(v: unknown): v is TrashRequest {
  return object(v) && exactKeys(v, ['analysisId', 'groupId', 'fileIds']) && idValid(v.analysisId) && groupValid(v.groupId)
    && Array.isArray(v.fileIds) && v.fileIds.length > 0 && v.fileIds.length <= PAGE_SIZE && v.fileIds.every(fileValid) && new Set(v.fileIds).size === v.fileIds.length
}
export type CatalogRequest =
  | { action: 'info'; analysisId: string }
  | { action: 'groups'; analysisId: string; kind: GroupKind; offset: number }
  | { action: 'members'; analysisId: string; groupId: string; offset: number }
  | { action: 'original'; analysisId: string; groupId: string; fileId: number | null }
  | { action: 'compare'; analysisId: string; groupId: string; fileId: number }
  | { action: 'decision'; analysisId: string; groupId: string; fileId: number; decision: 'unresolved' | 'keep' | 'review' | 'delete'; reviewed: boolean }
export const PAGE_SIZE = 25
export const idValid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v)
export const groupValid = (v: unknown): v is string => typeof v === 'string' && /^(e|t|i):[1-9][0-9]{0,14}$/.test(v)
export const fileValid = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0
export function exactKeys(v: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k))
}
export function isCatalogRequest(v: unknown): v is CatalogRequest {
  if (!object(v) || !idValid(v.analysisId)) return false
  if (v.action === 'info') return exactKeys(v, ['action', 'analysisId'])
  if (v.action === 'original') return exactKeys(v, ['action', 'analysisId', 'groupId', 'fileId']) && groupValid(v.groupId) && (v.fileId === null || fileValid(v.fileId))
  if (v.action === 'compare') return exactKeys(v, ['action', 'analysisId', 'groupId', 'fileId']) && groupValid(v.groupId) && fileValid(v.fileId)
  if (v.action === 'decision') return exactKeys(v, ['action', 'analysisId', 'groupId', 'fileId', 'decision', 'reviewed']) && groupValid(v.groupId) && fileValid(v.fileId)
    && typeof v.decision === 'string' && ['unresolved', 'keep', 'review', 'delete'].includes(v.decision) && typeof v.reviewed === 'boolean'
  if (!Number.isSafeInteger(v.offset) || Number(v.offset) < 0 || Number(v.offset) > 1e9) return false
  if (v.action === 'groups') return exactKeys(v, ['action', 'analysisId', 'kind', 'offset']) && groupKinds.includes(v.kind as GroupKind)
  return v.action === 'members' && exactKeys(v, ['action', 'analysisId', 'groupId', 'offset']) && groupValid(v.groupId)
}
