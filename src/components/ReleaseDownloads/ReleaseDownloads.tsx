import { Download } from 'lucide-react'
import detectAssetPlatform from '../../lib/detectAssetPlatform'
import isInstallableAsset from '../../lib/isInstallableAsset'
import formatFileSize from '../../lib/formatFileSize'
import type { OperatingSystem } from '../../types/platform'
import type { Release } from '../../types/release'
import './ReleaseDownloads.css'

interface ReleaseDownloadsProps {
  release: Release
  operatingSystem: OperatingSystem
  current: boolean
}

export default function ReleaseDownloads({
  release,
  operatingSystem,
  current,
}: ReleaseDownloadsProps) {
  const assets = release.assets.filter(
    (asset) =>
      isInstallableAsset(asset.name) && detectAssetPlatform(asset.name) === operatingSystem,
  )

  return (
    <div className="release-downloads">
      <div className="release-downloads__heading flex items-center justify-between gap-2">
        <h4>Duprove {release.tag_name}</h4>
        <span>{current ? 'Актуальный' : 'Предыдущий'}</span>
      </div>
      {assets.length > 0 ? (
        <ul className="release-downloads__assets">
          {assets.map((asset) => (
            <li key={asset.id}>
              <a
                href={asset.browser_download_url}
                className="release-downloads__link flex items-start gap-2"
                aria-label={`Скачать ${asset.name}, ${formatFileSize(asset.size)}`}
              >
                <Download size={13} aria-hidden="true" />
                <span>{asset.name}</span>
                <span className="release-downloads__size">{formatFileSize(asset.size)}</span>
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <p className="release-downloads__missing">
          Для этой ОС сборки не опубликованы.{' '}
          <a href={release.html_url} target="_blank" rel="noreferrer">
            Открыть релиз
          </a>
        </p>
      )}
    </div>
  )
}
