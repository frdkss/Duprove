import type { AnalysisSnapshot } from '../../contracts/analysis'
import type { Report, Summary } from '../../contracts/report'

const summary = (): Summary => ({ files: 0, empty: 0, types: {}, duplicate_members: 0, duplicate_groups: 0,
  file_bytes: 0, duplicate_bytes: 0 })

export function initialReport(state: AnalysisSnapshot): Report {
  return { schema_version: 1, complete: false, statistics: {
    total: { ...summary(), duplicates: 0, reclaimable_bytes: 0 },
    disks: state.drives.map((_, id) => ({ ...summary(), id })),
    locations: { standard: { total: summary(), categories: { downloads: summary(), documents: summary(),
      videos: summary(), pictures: summary(), music: summary(), desktop: summary() } }, custom: summary() },
  }, duplicates: [] }
}

// Live paths and diagnostics never enter the public report.
export function updateReport(report: Report, state: AnalysisSnapshot): Report {
  const disks = report.statistics.disks.map((disk, id) => {
    const drive = state.drives[id]
    return { ...disk, capacity_bytes: drive.capacity, available_bytes: Math.min(drive.capacity, drive.available),
      used_bytes: drive.capacity - Math.min(drive.capacity, drive.available) }
  })
  const volume = (key: 'capacity_bytes' | 'available_bytes' | 'used_bytes') => disks.reduce((n, disk) => n + disk[key], 0)
  return { ...report, statistics: { ...report.statistics, disks, total: { ...report.statistics.total,
    capacity_bytes: volume('capacity_bytes'), available_bytes: volume('available_bytes'), used_bytes: volume('used_bytes') } },
    progress: { updated_at: Date.now(), status: state.status, disks: state.disks.map((disk, id) => {
      const work = disk.work ? (({ current: _current, ...work }) => work)(disk.work) : undefined
      return { id, phase: disk.phase, percent: disk.percent, ...(work ? { work } : {}) }
    }) } }
}
