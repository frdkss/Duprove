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
  id: string; kind: GroupKind; count: number; bytes: number; originalId: number | null
}
export interface GroupMember {
  id: number; path: string; size: number; availability: 'available' | 'missing' | 'changed' | 'unavailable'
  decision: Decision; protected: boolean
}
export interface Page<T> { items: T[]; total: number; offset: number; limit: number }
export type CatalogRequest =
  | { action: 'info'; analysisId: string }
  | { action: 'groups'; analysisId: string; kind: GroupKind; offset: number }
  | { action: 'members'; analysisId: string; groupId: string; offset: number }
  | { action: 'original'; analysisId: string; groupId: string; fileId: number | null }
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
  if (!Number.isSafeInteger(v.offset) || Number(v.offset) < 0 || Number(v.offset) > 1e9) return false
  if (v.action === 'groups') return exactKeys(v, ['action', 'analysisId', 'kind', 'offset']) && groupKinds.includes(v.kind as GroupKind)
  return v.action === 'members' && exactKeys(v, ['action', 'analysisId', 'groupId', 'offset']) && groupValid(v.groupId)
}
