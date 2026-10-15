import { useEffect, useState } from 'react'
import { ReportDelivery } from '../../components/ReportDelivery/ReportDelivery'
import type { Drive } from '../../../electron/bridge'
import { Sidebar, type LoadMode, type View } from '../../components/Sidebar/Sidebar'
import { TitleBar } from '../../components/TitleBar/TitleBar'
import { DriveOverview } from '../../components/DriveOverview/DriveOverview'
import { SettingsPanel, type Theme } from '../../components/SettingsPanel/SettingsPanel'
import { Icon } from '../../components/Icon/Icon'
import './MainWindow.css'
import { activeJob, analysisFinished, emptySnapshot, type AnalysisCommand } from '../../../contracts/analysis'
import { AnalysisLogDialog } from '../../modal/AnalysisLogDialog/AnalysisLogDialog'
import { AnalysisControls } from '../../components/AnalysisControls/AnalysisControls'

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
  const [job, setJob] = useState(emptySnapshot)
  const [content, setContent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [analysisError, setAnalysisError] = useState('')
  const [logPath, setLogPath] = useState<string | null>(null)
  const logDisk = job.disks.find(d => d.path === logPath)
  const locked = activeJob(job.status)
  useEffect(() => {
    if (!window.duprove) return
    let mounted = true
    const receive = (next: typeof job) => { if (mounted) setJob(previous => next.revision >= previous.revision ? next : previous) }
    const unsubscribe = window.duprove.onAnalysis(receive)
    void window.duprove.getAnalysis().then(receive).catch(() => { if (mounted) setAnalysisError('Не удалось восстановить состояние анализа.') })
    return () => { mounted = false; unsubscribe() }
  }, [])
  useEffect(() => {
    setLogPath(null)
    if (job.id) {
      setSelected(job.drives.map(d => d.path)); setActivePath(job.drives[0]?.path ?? '')
      setMode(job.mode); setContent(job.content)
      setDrives(previous => [...previous, ...job.drives.filter(d => !previous.some(p => p.path === d.path))])
    }
  }, [job.id])
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try { localStorage.setItem('duprove.theme', theme); localStorage.setItem('duprove.load', mode) } catch {  }
  }, [theme, mode])
  useEffect(() => {
    let active = true
    if (!window.duprove) { setStatus('Для доступа к накопителям откройте приложение Duprove.'); return }
    window.duprove.listDrives().then(data => {
      if (active) { setDrives(previous => [...data, ...previous.filter(d => !data.some(p => p.path === d.path))]); setStatus(data.length ? '' : 'Доступных накопителей не найдено.') }
    }).catch(() => { if (active) setStatus('Не удалось получить список накопителей. Проверьте сборку анализатора.') })
    return () => { active = false }
  }, [])
  const activeDrive = drives.find(drive => drive.path === activePath)
  const selectedDrives = drives.filter(drive => selected.includes(drive.path))
  const activeIndex = selectedDrives.findIndex(drive => drive.path === activePath)
  const previousDrive = activeIndex > 0 ? selectedDrives[activeIndex - 1] : undefined
  const nextDrive = activeIndex >= 0 ? selectedDrives[activeIndex + 1] : undefined
  const select = (path: string, checked: boolean) => {
    if (locked) { if (selected.includes(path)) setActivePath(path); return }
    const next = checked ? [...new Set([...selected, path])] : selected.filter(p => p !== path)
    setSelected(next)
    if (checked) setActivePath(path)
    else if (activePath === path) setActivePath(drives.find(drive => next.includes(drive.path))?.path ?? '')
  }
  const selectAll = (checked: boolean) => {
    if (locked) return
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
  const run = async (command?: AnalysisCommand) => {
    if (!window.duprove) return
    setBusy(true); setAnalysisError('')
    try {
      const next = command ? await window.duprove.controlAnalysis(command) : await window.duprove.startAnalysis({ version: 1, roots: selected, mode, content })
      setJob(previous => next.revision >= previous.revision ? next : previous)
    } catch { setAnalysisError('Не удалось выполнить команду анализа. Проверьте доступность накопителей и повторите.') }
    finally { setBusy(false) }
  }
  const driveListProps = { drives, activePath, selected, locked,
    progress: analysisFinished(job) ? job.disks.map(d => ({ ...d, overall_percent: 100 })) : job.disks,
    onSelect: select, onSelectAll: selectAll }
  return <div className="app-shell"><TitleBar/><div className="app-body">
    <Sidebar {...driveListProps} content={content} onContent={setContent} view={view} expanded={expanded} mode={mode} onView={navigate} onExpand={() => setExpanded(previous => previous === 'mode' ? null : 'mode')} onMode={setMode} onHelp={openHelp}/>
    <main className="main-window"><header className="page-heading"><h1>{view === 'disks' ? 'Ваши диски' : 'Настройки'}</h1></header>
      {helpError && <p className="help-error" role="alert">{helpError}</p>}
      {(analysisError || job.error) && <p className="help-error" role="alert">{analysisError || (job.error === 'ANALYSIS_INCOMPLETE' ? 'Анализ завершён с пропусками или ошибками доступа. Доступен неполный результат.' : 'Анализ прерван или не удалось сохранить данные. Можно повторить попытку.')} {job.error && <small>Код: {job.error}</small>}</p>}
      {view === 'settings' ? <SettingsPanel theme={theme} onTheme={setTheme} api={window.duprove}/> : <>
        {status && !drives.length ? <div className="drive-empty" role="status"><Icon name="drive" size={44}/><p>{status}</p></div> : <div className="disk-workspace">
          {activeDrive ? <DriveOverview drive={activeDrive} progress={job.disks.find(d => d.path === activePath)} paused={job.status === 'paused'} running={job.status === 'running' || job.status === 'stopping'} finished={analysisFinished(job)} onShowLog={!locked && job.disks.some(d => d.path === activePath) ? () => setLogPath(activePath) : undefined} onNext={nextDrive ? () => setActivePath(nextDrive.path) : undefined} onPrevious={previousDrive ? () => setActivePath(previousDrive.path) : undefined}/> : <div className="drive-empty"><Icon name="drive" size={44}/><h2>Выберите диск</h2><p>Отметьте нужные накопители в разделе «Ваши диски» слева.</p></div>}
        </div>}
        <AnalysisControls job={job} selected={selected.length} busy={busy} onStart={() => void run()} onCommand={command => void run(command)}/>
        <ReportDelivery api={window.duprove}/>
      </>}
    </main></div>{logDisk && <AnalysisLogDialog job={job} disk={logDisk} onClose={() => setLogPath(null)}/>}</div>
}
