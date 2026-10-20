import type { Drive } from '../../../electron/bridge'
import { DriveList } from '../DriveList/DriveList'
import { Collapse } from '../Collapse/Collapse'
import { Tooltip } from '../Tooltip/Tooltip'
import { Icon } from '../Icon/Icon'
import { Logo } from '../Logo/Logo'
import { Toggle } from '../Toggle/Toggle'
import './Sidebar.css'
import type { DiskProgress } from '../../../contracts/analysis'
export type LoadMode = 'low' | 'medium' | 'high'
export type View = 'disks' | 'settings'
const modes = [
  { id: 'low', label: 'Низкий', icon: 'leaf', description: 'Фоновый приоритет. CPU: до 60% одного ядра; чтение: до 64 МиБ/с; память анализатора: до 512 МиБ.' },
  { id: 'medium', label: 'Средний', icon: 'medium', description: 'CPU: до 85% одного ядра; чтение: до 256 МиБ/с; память анализатора: до 1 ГиБ.' },
  { id: 'high', label: 'Высокий', icon: 'high', description: 'Максимальная скорость: параллельное хеширование по числу логических процессоров (до 16 потоков), без ограничения скорости чтения и искусственных CPU-пауз. Память анализатора: до 2 ГиБ.' },
] as const
interface Props {
  locked?: boolean; progress?: DiskProgress[]; content: boolean; onContent(value: boolean): void
  drives: Drive[]; activePath: string; selected: string[]; view: View; expanded: 'drives' | 'mode' | null; mode: LoadMode
  onView(view: View): void; onExpand(): void; onMode(mode: LoadMode): void; onSelect(path: string, checked: boolean): void; onSelectAll(checked: boolean): void; onHelp(): void
}
export function Sidebar(props: Props) {
  const drivesOpen = props.expanded === 'drives' && props.view === 'disks'
  const modesOpen = props.expanded === 'mode'
  return <aside className="sidebar"><Logo/><nav className="sidebar-nav" aria-label="Основное меню">
    <button className={`nav-item ${drivesOpen ? 'active' : ''}`} onClick={() => props.onView('disks')} aria-expanded={drivesOpen} aria-controls="sidebar-drives"><Icon name="drive"/><span>Ваши диски</span><Icon name="chevron" size={16} className={drivesOpen ? 'rotate' : ''}/></button>
    <Collapse id="sidebar-drives" open={drivesOpen}><div className="sidebar-drives"><DriveList {...props}/></div></Collapse>
    <button className={`nav-item ${modesOpen && props.view === 'disks' ? 'active' : ''}`} onClick={props.onExpand} aria-expanded={modesOpen} aria-controls="sidebar-modes"><Icon name="settings"/><span>Режим работы</span><Icon name="chevron" size={16} className={modesOpen ? 'rotate' : ''}/></button>
    <Collapse id="sidebar-modes" open={modesOpen}><div className="mode-options" role="group" aria-label="Режим работы">
      {modes.map(mode => <button key={mode.id} disabled={props.locked} className={`mode-option ${props.mode === mode.id ? 'selected' : ''}`} aria-pressed={props.mode === mode.id} title={mode.description} onClick={() => props.onMode(mode.id)}><Icon name={mode.icon} size={20}/><span>{mode.label}</span><span className="mode-radio"/></button>)}
      <div className="content-option"><Icon name="fileSearch" size={20}/><span>Проверять содержимое</span><Toggle label="Проверять содержимое" checked={props.content} onChange={props.onContent} disabled={props.locked}/><Tooltip label="О проверке содержимого" text="TXT, Markdown, DOCX, PNG и JPEG: схожие файлы отмечаются для ручной проверки. Более низкий режим может пропустить больше крупных файлов в дополнительной проверке. Точные дубликаты всегда сравниваются побайтово."/></div>
    </div></Collapse>
    <button className={`nav-item ${props.view === 'settings' ? 'active' : ''}`} onClick={() => props.onView('settings')} aria-current={props.view === 'settings' ? 'page' : undefined}><Icon name="settings"/><span>Настройки</span><Icon name="chevron" size={16}/></button>
    <button className="nav-item" onClick={props.onHelp}><Icon name="help"/><span>Помощь</span><Icon name="external" size={18}/></button>
  </nav></aside>
}
