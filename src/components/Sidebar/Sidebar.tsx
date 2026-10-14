import type { Drive } from '../../../electron/bridge'
import { DriveList } from '../DriveList/DriveList'
import { Collapse } from '../Collapse/Collapse'
import { Tooltip } from '../Tooltip/Tooltip'
import { Icon } from '../Icon/Icon'
import { Logo } from '../Logo/Logo'
import { Toggle } from '../Toggle/Toggle'
import './Sidebar.css'
export type LoadMode = 'low' | 'medium' | 'high'
export type View = 'disks' | 'settings'
const modes = [
  { id: 'low', label: 'Низкий', icon: 'leaf', description: 'Комфортная работа за компьютером. Анализ займёт больше времени.' },
  { id: 'medium', label: 'Средний', icon: 'medium', description: 'Анализ быстрее, при этом можно продолжать работу.' },
  { id: 'high', label: 'Высокий', icon: 'high', description: 'Приоритет скорости анализа. Возможны замедления работы компьютера.' },
] as const
interface Props {
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
      {modes.map(mode => <button key={mode.id} className={`mode-option ${props.mode === mode.id ? 'selected' : ''}`} aria-pressed={props.mode === mode.id} title={mode.description} onClick={() => props.onMode(mode.id)}><Icon name={mode.icon} size={20}/><span>{mode.label}</span><span className="mode-radio"/></button>)}
      <div className="content-option"><Icon name="fileSearch" size={20}/><span>Проверять содержимое</span><Toggle label="Проверять содержимое" checked={false} disabled/><Tooltip label="О проверке содержимого" text="Экспериментальная функция для более глубокого анализа содержимого. Для поиска точных дубликатов файлы и без неё сравниваются побайтово. Дополнительная проверка пока недоступна."/></div>
    </div></Collapse>
    <button className={`nav-item ${props.view === 'settings' ? 'active' : ''}`} onClick={() => props.onView('settings')} aria-current={props.view === 'settings' ? 'page' : undefined}><Icon name="settings"/><span>Настройки</span><Icon name="chevron" size={16}/></button>
    <button className="nav-item" onClick={props.onHelp}><Icon name="help"/><span>Помощь</span><Icon name="external" size={18}/></button>
  </nav></aside>
}
