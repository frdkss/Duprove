import { useEffect, useState } from 'react'
import type { Drive } from '../../../electron/bridge'
import { Sidebar, type LoadMode, type View } from '../../components/Sidebar/Sidebar'
import { TitleBar } from '../../components/TitleBar/TitleBar'
import { DriveOverview } from '../../components/DriveOverview/DriveOverview'
import { SettingsPanel, type Theme } from '../../components/SettingsPanel/SettingsPanel'
import { Icon } from '../../components/Icon/Icon'
import './MainWindow.css'

function preference(key: string, choices: string[], fallback: string) {
  try { const value = localStorage.getItem(key); return value && choices.includes(value) ? value : fallback } catch { return fallback }
}
export function MainWindow() {
  const [drives, setDrives] = useState<Drive[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [activePath, setActivePath] = useState('')
  const [view, setView] = useState<View>('disks')
  const [expanded, setExpanded] = useState<'drives' | 'mode' | null>('drives')
  const [mode, setMode] = useState<LoadMode>(() => preference('duprove.load', ['low', 'medium', 'high'], 'low') as LoadMode)
  const [theme, setTheme] = useState<Theme>(() => preference('duprove.theme', ['light', 'dark'], 'light') as Theme)
  const [helpError, setHelpError] = useState('')
  const [status, setStatus] = useState('Получение списка накопителей…')
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try { localStorage.setItem('duprove.theme', theme); localStorage.setItem('duprove.load', mode) } catch {  }
  }, [theme, mode])
  useEffect(() => {
    let active = true
    if (!window.duprove) { setStatus('Для доступа к накопителям откройте приложение Duprove.'); return }
    window.duprove.listDrives().then(data => {
      if (active) { setDrives(data); setStatus(data.length ? '' : 'Доступных накопителей не найдено.') }
    }).catch(() => { if (active) setStatus('Не удалось получить список накопителей. Проверьте сборку анализатора.') })
    return () => { active = false }
  }, [])
  const activeDrive = drives.find(drive => drive.path === activePath)
  const selectedDrives = drives.filter(drive => selected.includes(drive.path))
  const activeIndex = selectedDrives.findIndex(drive => drive.path === activePath)
  const previousDrive = activeIndex > 0 ? selectedDrives[activeIndex - 1] : undefined
  const nextDrive = activeIndex >= 0 ? selectedDrives[activeIndex + 1] : undefined
  const select = (path: string, checked: boolean) => {
    const next = checked ? [...new Set([...selected, path])] : selected.filter(p => p !== path)
    setSelected(next)
    if (checked) setActivePath(path)
    else if (activePath === path) setActivePath(drives.find(drive => next.includes(drive.path))?.path ?? '')
  }
  const selectAll = (checked: boolean) => {
    setSelected(checked ? drives.map(drive => drive.path) : [])
    setActivePath(checked ? activePath || drives[0]?.path || '' : '')
  }
  const navigate = (next: View) => {
    setView(next)
    if (next === 'disks') setExpanded(view === 'disks' && expanded === 'drives' ? null : 'drives')
  }
  const openHelp = async () => {
    setHelpError('')
    try {
      if (!window.duprove) throw new Error('Desktop bridge unavailable')
      await window.duprove.openHelp()
    } catch { setHelpError('Не удалось открыть справку в браузере.') }
  }
  const driveListProps = { drives, activePath, selected, onSelect: select, onSelectAll: selectAll }
  return <div className="app-shell"><TitleBar/><div className="app-body">
    <Sidebar {...driveListProps} view={view} expanded={expanded} mode={mode} onView={navigate} onExpand={() => setExpanded(previous => previous === 'mode' ? null : 'mode')} onMode={setMode} onHelp={openHelp}/>
    <main className="main-window"><header className="page-heading"><h1>{view === 'disks' ? 'Ваши диски' : 'Настройки'}</h1></header>
      {helpError && <p className="help-error" role="alert">{helpError}</p>}
      {view === 'settings' ? <SettingsPanel theme={theme} onTheme={setTheme} api={window.duprove}/> : <>
        {status ? <div className="drive-empty" role="status"><Icon name="drive" size={44}/><p>{status}</p></div> : <div className="disk-workspace">
          {activeDrive ? <DriveOverview drive={activeDrive} onNext={nextDrive ? () => setActivePath(nextDrive.path) : undefined} onPrevious={previousDrive ? () => setActivePath(previousDrive.path) : undefined}/> : <div className="drive-empty"><Icon name="drive" size={44}/><h2>Выберите диск</h2><p>Отметьте нужные накопители в разделе «Ваши диски» слева.</p></div>}
        </div>}
        <footer className="scan-footer"><button className="primary-button" data-action="scan" disabled><Icon name="search" size={17}/>Начать анализ</button></footer>
      </>}
    </main></div></div>
}
