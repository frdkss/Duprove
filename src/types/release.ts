export interface ReleaseAsset {
  id: number
  name: string
  browser_download_url: string
  size: number
}

export interface Release {
  id: number
  tag_name: string
  name: string | null
  body: string | null
  html_url: string
  published_at: string
  draft: boolean
  prerelease: boolean
  assets: ReleaseAsset[]
}

export type ReleaseState =
  | { status: 'loading'; releases: Release[] }
  | { status: 'success'; releases: Release[] }
  | { status: 'error'; releases: Release[]; message: string }
