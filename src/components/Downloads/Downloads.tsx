import { useState } from 'react'
import { ArrowUpRight, RefreshCw } from 'lucide-react'
import detectOperatingSystem from '../../lib/detectOperatingSystem'
import { releasesUrl } from '../../config/project'
import type { ReleaseState } from '../../types/release'
import OperatingSystemSelect from '../OperatingSystemSelect/OperatingSystemSelect'
import ReleaseDownloads from '../ReleaseDownloads/ReleaseDownloads'
import './Downloads.css'

interface DownloadsProps {
  state: ReleaseState
  retry: () => void
}

export default function Downloads({ state, retry }: DownloadsProps) {
  const [operatingSystem, setOperatingSystem] = useState(() => detectOperatingSystem(navigator))

  return (
    <div className="downloads">
      <OperatingSystemSelect value={operatingSystem} onChange={setOperatingSystem} />
      <div
        className="downloads__body"
        aria-live="polite"
        aria-busy={operatingSystem !== 'macos' && state.status === 'loading'}
      >
        {operatingSystem === 'macos' ? (
          <p className="downloads__message">
            На данный момент Duprove не разработан для macOS. Версия для macOS не планируется.
          </p>
        ) : operatingSystem === 'unknown' ? (
          <p className="downloads__message">
            Не удалось определить поддерживаемую ОС. Выберите Windows или Linux, чтобы увидеть
            доступные сборки.
          </p>
        ) : state.status === 'loading' ? (
          <p className="downloads__message">Проверяем актуальные релизы…</p>
        ) : state.status === 'error' ? (
          <div className="downloads__message">
            <p>{state.message}</p>
            <button
              className="downloads__retry flex items-center gap-2"
              type="button"
              onClick={retry}
            >
              <RefreshCw size={13} aria-hidden="true" />
              Повторить
            </button>
          </div>
        ) : state.releases.length === 0 ? (
          <div className="downloads__message">
            <p className="downloads__empty-title">Первый релиз ещё впереди</p>
            <p>
              Опубликованных версий пока нет. Ссылки на скачивание появятся здесь после их выхода на
              GitHub.
            </p>
          </div>
        ) : (
          <div className="downloads__releases">
            {state.releases.map((release, index) => (
              <ReleaseDownloads
                key={release.id}
                release={release}
                operatingSystem={operatingSystem}
                current={index === 0}
              />
            ))}
            {state.releases.length === 1 && (
              <p className="downloads__previous">Предыдущего стабильного релиза пока нет.</p>
            )}
          </div>
        )}
      </div>
      <a
        className="downloads__github inline-flex items-center gap-1"
        href={releasesUrl}
        target="_blank"
        rel="noreferrer"
      >
        Все релизы на GitHub <ArrowUpRight size={13} aria-hidden="true" />
      </a>
    </div>
  )
}
