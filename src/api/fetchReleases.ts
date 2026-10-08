import { releasesApiUrl } from '../config/project'
import selectReleases from '../lib/selectReleases'
import type { Release } from '../types/release'
import requestGitHub from './requestGitHub'

export default async function fetchReleases(signal: AbortSignal) {
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(12000)])
  const [firstPage, latest] = await Promise.all([
    requestGitHub<Release[]>(`${releasesApiUrl}?per_page=100&page=1`, requestSignal),
    requestGitHub<Release>(`${releasesApiUrl}/latest`, requestSignal, true),
  ])
  const releases = firstPage ?? []
  let page = 1
  let pageLength = releases.length

  while (selectReleases(releases, latest).length < 2 && pageLength === 100) {
    page += 1
    const nextPage = await requestGitHub<Release[]>(
      `${releasesApiUrl}?per_page=100&page=${page}`,
      requestSignal,
    )
    pageLength = nextPage?.length ?? 0
    releases.push(...(nextPage ?? []))
  }

  return selectReleases(releases, latest)
}
