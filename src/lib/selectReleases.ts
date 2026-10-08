import type { Release } from '../types/release'

export default function selectReleases(releases: Release[], latest: Release | null): Release[] {
  const stable = releases
    .filter((release) => !release.draft && !release.prerelease)
    .sort((first, second) => Date.parse(second.published_at) - Date.parse(first.published_at))
  const current = latest && !latest.draft && !latest.prerelease ? latest : stable[0]
  if (!current) return []
  const previous = stable.find(
    (release) =>
      release.id !== current.id &&
      Date.parse(release.published_at) <= Date.parse(current.published_at),
  )
  return previous ? [current, previous] : [current]
}
