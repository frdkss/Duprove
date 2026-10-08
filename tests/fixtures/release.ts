import type { Release } from '../../src/types/release'

export default function release(overrides: Partial<Release> = {}): Release {
  return {
    id: 2,
    name: 'Duprove 2',
    tag_name: 'v2.0.0',
    body: 'Release notes',
    html_url: 'https://github.com/example/project/releases/tag/v2.0.0',
    published_at: '2026-10-02T12:00:00Z',
    draft: false,
    prerelease: false,
    assets: [],
    ...overrides,
  }
}
