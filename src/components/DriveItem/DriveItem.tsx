import type { Drive } from '../../../electron/bridge'
import { Icon } from '../Icon/Icon'
import './DriveItem.css'
import { progressText, type DiskProgress } from '../../../contracts/analysis'
export const gib = (bytes: number) => `${(bytes / 1024 ** 3).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} ГиБ`
export const driveName = (drive: Drive) => /^[a-z]:\\?$/i.test(drive.name) ? `Диск ${drive.name.slice(0, 2)}` : drive.name
export function DriveItem({ drive, selected, active, onChange, progress, disabled }: { drive: Drive; selected: boolean; active: boolean; onChange(checked: boolean): void; progress?: DiskProgress; disabled?: boolean }) {
  const status = progress && (progress.phase === 'waiting' ? 'Ожидание' : progress.phase === 'completed' ? 'Завершено' : progress.phase === 'error' ? 'Ошибка' : progress.phase === 'stopped' ? 'Остановлено' : 'В процессе')
  return <button disabled={disabled} className={`drive-item${active ? ' drive-item-active' : ''}${selected ? ' drive-item-selected' : ''}`} role="checkbox" aria-checked={selected} aria-label={`Выбрать ${driveName(drive)} для анализа`} onClick={() => onChange(!selected)}>
    <Icon name="drive" size={26}/><span className="drive-info"><strong>{driveName(drive)}</strong><span>{gib(drive.capacity)}</span>{progress && <span>{status} · {progressText(progress.overall_percent ?? (progress.phase === 'completed' ? 100 : 0))}%</span>}</span>
    <span className={`checkbox drive-check${selected ? ' checked' : ''}`} aria-hidden="true"/>
  </button>
}
