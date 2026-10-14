import type { Drive } from '../../../electron/bridge'
import { driveName, gib } from '../DriveItem/DriveItem'
import { Icon } from '../Icon/Icon'
import './DriveOverview.css'
export function DriveOverview({ drive, onNext, onPrevious }: { drive: Drive; onNext?(): void; onPrevious?(): void }) {
  return <section className="drive-overview" aria-label={`Обзор: ${driveName(drive)}`}>
    <div className="overview-heading"><h2>{driveName(drive)}</h2><span>{gib(drive.capacity)}</span></div>
    <p className="drive-free">Свободно {gib(drive.available)}</p>
    <div className="chart-row">
      {onPrevious && <button className="drive-arrow previous-drive" onClick={onPrevious} aria-label="Предыдущий диск" title="Предыдущий диск"><Icon name="arrow" size={30}/></button>}
      <div className="scan-ring" aria-label="Анализ ещё не запускался">
        <svg className="ring-svg" viewBox="0 0 400 400" aria-hidden="true"><circle cx="200" cy="200" r="176" fill="none" stroke="var(--color-ring-border)" strokeWidth="42"/><circle cx="200" cy="200" r="176" fill="none" stroke="var(--color-ring)" strokeWidth="40"/></svg>
        <div className="ring-content"><span className="idle-badge"><span/>Ожидание запуска</span><p className="ring-title">Диск ещё не<br/>проанализирован</p><div className="ring-stats"><span>Дубликатов <b>—</b></span><span>Пустых файлов <b>—</b></span></div></div>
      </div>
      {onNext && <button className="drive-arrow next-drive" onClick={onNext} aria-label="Следующий диск" title="Следующий диск"><Icon name="arrow" size={30}/></button>}
    </div>
    <div className="scan-percentage">0<span>%</span></div>
    <p className="scan-caption">Анализ не начат</p>
  </section>
}
