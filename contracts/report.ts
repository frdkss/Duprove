export type Category = 'downloads' | 'documents' | 'videos' | 'pictures' | 'music' | 'desktop' | 'custom'
export interface Summary {
  files: number
  empty: number
  types: Record<string, number>
  duplicate_members: number
  duplicate_groups: number
}
export interface DuplicateGroup {
  copies: number
  duplicates: number
  extensions: Record<string, number>
  disks: Record<string, number>
  categories: Partial<Record<Category, number>>
}
export interface Report {
  schema_version: 1
  complete: boolean
  statistics: {
    total: Summary & { duplicates: number }
    disks: (Summary & { id: number })[]
    locations: {
      standard: { total: Summary; categories: Record<Exclude<Category, 'custom'>, Summary> }
      custom: Summary
    }
  }
  duplicates: DuplicateGroup[]
}
