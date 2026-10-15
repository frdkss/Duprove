import type { AnalysisTiming, DiskProgress, Phase } from '../../contracts/analysis'

type Sample = { at: number; done: number }
type Track = { phase: Phase; operation: string; samples: Sample[]; advanced: number; current: string; read: number; previousDone: number }
// Short rolling samples avoid including pauses or projecting a new phase at the
// preceding phase's speed. Total ETA is explicitly an extrapolation of stage work.
export class AnalysisTimingTracker {
  private tracks = new Map<string, Track>()
  reset() { this.tracks.clear() }
  observe(disk: DiskProgress, content: boolean, running: boolean, now = Date.now()): AnalysisTiming {
    const work = disk.work
    let track = this.tracks.get(disk.path)
    if (!work || !running) {
      this.tracks.delete(disk.path)
      return { updated_at: now, advanced_at: now, rate: null, eta_seconds: null, total_eta_seconds: null }
    }
    if (!track || track.phase !== disk.phase || track.operation !== work.operation) {
      track = { phase: disk.phase, operation: work.operation, samples: [], advanced: now, current: work.current, read: work.read_bytes, previousDone: work.done }
      this.tracks.set(disk.path, track)
    }
    if (track.current !== work.current || track.read !== work.read_bytes || track.previousDone !== work.done) track.advanced = now
    track.current = work.current; track.read = work.read_bytes; track.previousDone = work.done
    track.samples.push({ at: now, done: work.done })
    while (track.samples.length > 2 && track.samples[1].at < now - 15000) track.samples.shift()
    const first = track.samples[0]
    const seconds = (now - first.at) / 1000
    const rate = seconds >= 3 && now - track.advanced < 15000 ? Math.max(0, (work.done - first.done) / seconds) : null
    const eta = rate !== null && rate > 0 && work.total !== null ? Math.max(0, (work.total - work.done) / rate) : null
    const stages = content ? 6 : 4
    const indices: Partial<Record<Phase, number>> = { hashing: 1, comparing: 2, content: 3, content_comparing: 4, validating: stages - 1 }
    const stage = indices[disk.phase]
    // No total ETA while the directory frontier (and future byte volume) is unknown.
    // Later stages are provisionally assumed to cost the same as the current one;
    // this rough estimate is labelled in the UI and revised at each phase change.
    const totalEta = eta !== null && rate !== null && rate > 0 && work.total !== null && stage !== undefined
      ? eta + Math.max(0, stages - stage - 1) * work.total / rate : null
    return { updated_at: now, advanced_at: track.advanced, rate, eta_seconds: eta, total_eta_seconds: totalEta }
  }
}
