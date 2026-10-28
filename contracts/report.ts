export type Category = 'downloads' | 'documents' | 'videos' | 'pictures' | 'music' | 'desktop' | 'custom'
export interface Summary {
  files: number
  empty: number
  types: Record<string, number>
  duplicate_members: number
  duplicate_groups: number
  file_bytes?: number
  duplicate_bytes?: number
}
export interface DuplicateGroup {
  copies: number
  duplicates: number
  size_bytes?: number
  extensions: Record<string, number>
  disks: Record<string, number>
  categories: Partial<Record<Category, number>>
}
export interface Report {
  schema_version: 1
  complete: boolean
  statistics: {
    total: Summary & { duplicates: number; reclaimable_bytes?: number } & VolumeBytes
    disks: (Summary & { id: number } & VolumeBytes)[]
    locations: {
      standard: { total: Summary; categories: Record<Exclude<Category, 'custom'>, Summary> }
      custom: Summary
    }
  }
  duplicates: DuplicateGroup[]
  progress?: {
    updated_at: number
    status: import('./analysis').JobStatus
    disks: { id: number; phase: import('./analysis').Phase; percent: number | null
      work?: Omit<import('./analysis').AnalysisWork, 'current'> }[]
  }
}
export interface VolumeBytes { capacity_bytes?: number; available_bytes?: number; used_bytes?: number }
