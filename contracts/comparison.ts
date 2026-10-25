import { object } from './analysis'
import { exactKeys, fileValid, groupValid, idValid, type Decision, type GroupKind } from './catalog'

export const MAX_COMPARISON_FILES = 32
export interface ComparisonRequest { analysisId: string; groupId: string; fileIds: number[] }
export interface ComparisonFile { id: number; name: string; path: string; size: number; decision: Decision; protected: boolean }
export interface ComparisonContext { sessionId?: string; analysisId: string; groupId: string; kind: GroupKind; originalId: number | null; files: ComparisonFile[] }
export interface ComparisonFileRequest { analysisId: string; groupId: string; fileId: number; sessionId: string }
export type ViewerKind = 'text' | 'pdf' | 'image' | 'audio' | 'video' | 'docx' | 'doc' | 'rtf' | 'sheet'
export interface ComparisonDocument extends ComparisonFile { status: string; kind: ViewerKind; url?: string; text?: string }
// Snapshot paths and hashes stay between the native helper, worker and main process.
export interface ComparisonSnapshot extends ComparisonFile { status: string; snapshot?: string; sha256?: string; text?: string }
export function isComparisonRequest(v: unknown): v is ComparisonRequest {
  return object(v) && exactKeys(v, ['analysisId', 'groupId', 'fileIds']) && idValid(v.analysisId) && groupValid(v.groupId)
    && Array.isArray(v.fileIds) && v.fileIds.length > 0 && v.fileIds.length <= MAX_COMPARISON_FILES
    && v.fileIds.every(fileValid) && new Set(v.fileIds).size === v.fileIds.length
}
export function isComparisonFileRequest(v: unknown): v is ComparisonFileRequest {
  return object(v) && exactKeys(v, ['analysisId', 'groupId', 'fileId', 'sessionId']) && idValid(v.analysisId)
    && groupValid(v.groupId) && fileValid(v.fileId) && idValid(v.sessionId)
}
export function viewerKind(name: string): ViewerKind {
  const ext = name.toLowerCase().split('.').pop() ?? ''
  if (ext === 'pdf') return 'pdf'
  if (['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'avif', 'ico', 'tif', 'tiff'].includes(ext)) return 'image'
  if (['mp3', 'wav', 'wave', 'ogg', 'oga', 'flac', 'aac', 'm4a', 'opus', 'aiff', 'aif', 'weba'].includes(ext)) return 'audio'
  if (['mp4', 'webm', 'ogv', 'mov', 'm4v'].includes(ext)) return 'video'
  if (ext === 'docx') return 'docx'
  if (ext === 'doc') return 'doc'
  if (ext === 'rtf') return 'rtf'
  if (['xlsx', 'xls', 'xlsm', 'xlsb', 'ods', 'csv', 'tsv', 'numbers', 'fods'].includes(ext)) return 'sheet'
  return 'text'
}
export function comparisonColumns(width: number, count: number): number {
  return Math.min(Math.max(1, count), 4, Math.max(1, Math.floor(width / 420)))
}
