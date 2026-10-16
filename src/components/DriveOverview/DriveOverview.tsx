import type { Drive } from '../../../electron/bridge'
import { driveName, gib } from '../DriveItem/DriveItem'
import { Icon } from '../Icon/Icon'
import './DriveOverview.css'
import { useEffect, useState } from 'react'
import { progressText, type DiskProgress, type Phase } from '../../../contracts/analysis'
import { fileTypeColor, fileTypeName } from './file-types'
import { AnalysisActivity, operationLabels } from './AnalysisActivity'
const phaseLabels: Record<Phase, string> = { waiting: 'Ожидание очереди', discovering: 'Обход и метаданные', hashing: 'Проверка SHA-256', comparing: 'Побайтовое сравнение', content: 'Чтение содержимого', content_comparing: 'Сравнение содержимого', validating: 'Проверка актуальности', completed: 'Анализ завершён', stopped: 'Анализ остановлен', error: 'Завершено с ошибками' }
const legendPageSize = 8
export function DriveOverview({ drive, onNext, onPrevious, progress, paused, running, finished, onShowLog }: { drive: Drive; onNext?(): void; onPrevious?(): void; progress?: DiskProgress; paused?: boolean; running?: boolean; finished?: boolean; onShowLog?(): void }) {
  const [hover, setHover] = useState<string | null>(null)
  const [legendPage, setLegendPage] = useState(0)
  useEffect(() => { setLegendPage(0); setHover(null) }, [drive.path])
  const sectors = Object.entries(progress?.types ?? {}).filter(([, count]) => count > 0).sort(([a], [b]) => a.localeCompare(b))
  const pageCount = Math.ceil(sectors.length / legendPageSize)
  const page = Math.min(legendPage, Math.max(0, pageCount - 1))
  const describeType = (type: string, count: number) => `${fileTypeName(type)}: ${count.toLocaleString('ru-RU')} файлов · ${(count / (progress?.files || 1) * 100).toLocaleString('ru-RU', { maximumFractionDigits: 1 })}%`
  const hovered = sectors.find(([type]) => type === hover)
  let offset = 0
  const label = progress ? paused ? 'Пауза' : phaseLabels[progress.phase] : 'Ожидание запуска'
  const percentage = progress && (finished || progress.phase === 'completed') ? 100 : progress?.overall_percent ?? 0
  const caption = !progress ? 'Анализ не начат' : paused ? label : progress.phase === 'discovering'
    ? `${label} · оценка по найденным каталогам` : running && progress.work && (progress.phase !== 'waiting' || ['initializing', 'preparing'].includes(progress.work.operation)) ? operationLabels[progress.work.operation] : label
  return <section className="drive-overview" aria-label={`Обзор: ${driveName(drive)}`}>
    <aside className="extension-panel" aria-label="Расширения файлов">
      <h3>Типы файлов</h3>
      {sectors.length ? <>
        <div className="chart-legend">{sectors.slice(page * legendPageSize, (page + 1) * legendPageSize).map(([type, count]) => <button key={type} className="legend-type" data-type={type} title={describeType(type, count)} aria-label={describeType(type, count)} onMouseEnter={() => setHover(type)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(type)} onBlur={() => setHover(null)}><i style={{ background: fileTypeColor(type) }}/><span>{fileTypeName(type)}<small>{count.toLocaleString('ru-RU')} · {(count / (progress?.files || 1) * 100).toLocaleString('ru-RU', { maximumFractionDigits: 1 })}%</small></span></button>)}</div>
        <div className="legend-pages" role="group" aria-label={`Типы файлов, страница ${page + 1} из ${pageCount}`}>
          <button className="legend-page-button" disabled={page === 0} onClick={() => { setLegendPage(page - 1); setHover(null) }} aria-label="Предыдущие типы файлов">‹</button>
          <span>{page + 1} / {pageCount}</span>
          <button className="legend-page-button" disabled={page === pageCount - 1} onClick={() => { setLegendPage(page + 1); setHover(null) }} aria-label="Следующие типы файлов">›</button>
        </div>
      </> : <p className="scan-details">Появятся после начала обхода</p>}
    </aside>
    <div className="overview-summary">
    <div className="overview-heading"><h2>{driveName(drive)}</h2><span>{gib(drive.capacity)}</span></div>
    <p className="drive-free">Свободно {gib(drive.available)}</p>
    </div>
    <div className="chart-row">
      {onPrevious && <button className="drive-arrow previous-drive" onClick={onPrevious} aria-label="Предыдущий диск" title="Предыдущий диск"><Icon name="arrow" size={30}/></button>}
      <div className="scan-ring" aria-label={progress ? `Типы проанализированных файлов: ${progress.files}` : 'Анализ ещё не запускался'}>
        <svg className="ring-svg" viewBox="0 0 400 400"><circle cx="200" cy="200" r="176" fill="none" stroke="var(--color-ring-border)" strokeWidth="42"/><circle cx="200" cy="200" r="176" fill="none" stroke="var(--color-ring)" strokeWidth="40"/>
          {sectors.map(([type, count]) => {
            const share = count / (progress?.files || 1) * 100
            const position = offset; offset += share
            const text = describeType(type, count)
            return <circle key={type} className="type-sector" data-type={type} cx="200" cy="200" r="176" fill="none" pathLength="100" stroke={fileTypeColor(type)} strokeWidth="40" strokeDasharray={`${share} ${100 - share}`} strokeDashoffset={-position} transform="rotate(-90 200 200)" tabIndex={0} role="img" aria-label={text} onMouseEnter={() => setHover(type)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(type)} onBlur={() => setHover(null)}><title>{text}</title></circle>
          })}
        </svg>
        {hovered && <div className="chart-tooltip" role="tooltip">{describeType(...hovered)}</div>}
        <div className="ring-content">{onShowLog ? <button className="idle-badge analysis-status-link" onClick={onShowLog} title="Открыть журнал анализа"><span/>{label}</button> : <span className="idle-badge"><span/>{label}</span>}{progress ? <>
          <strong className="duplicate-count">{progress.duplicate_members.toLocaleString('ru-RU')}</strong>
          <span className="duplicate-label" title="Все файлы этого диска, входящие в группы точных копий. Лишние копии N − 1 подсчитываются для всего задания.">Файлов-дубликатов</span>
          <span className="empty-count">Пустых файлов: {progress.empty.toLocaleString('ru-RU')}</span>
          <span className="group-count">Групп: {progress.duplicate_groups.toLocaleString('ru-RU')}</span>
        </> : <><p className="ring-title">Диск ещё не<br/>проанализирован</p><div className="ring-stats"><span>Дубликатов <b>—</b></span><span>Пустых файлов <b>—</b></span></div></>}</div>
      </div>
      {onNext && <button className="drive-arrow next-drive" onClick={onNext} aria-label="Следующий диск" title="Следующий диск"><Icon name="arrow" size={30}/></button>}
    </div>
    <div className="overview-progress">
    <div className="scan-percentage" role="progressbar" aria-label="Выполнение анализа по этапам" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percentage} title="Общий прогресс по этапам анализа. При обходе используется оценка по найденным каталогам.">{progressText(percentage)}<span>%</span></div>
    <p className="scan-caption">{onShowLog ? <button className="analysis-status-link" onClick={onShowLog} title="Открыть журнал анализа">{caption} · Журнал</button> : caption}</p>
    {progress && <p className="scan-details">Учтено файлов: {progress.files.toLocaleString('ru-RU')} · Ошибок: {progress.errors.toLocaleString('ru-RU')}</p>}
    {progress && <AnalysisActivity progress={progress} paused={paused} running={running}/>}
    </div>
  </section>
}
