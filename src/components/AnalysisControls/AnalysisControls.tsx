import type { AnalysisCommand, AnalysisSnapshot } from '../../../contracts/analysis'
import { activeJob } from '../../../contracts/analysis'
import { Icon } from '../Icon/Icon'
import './AnalysisControls.css'

export function AnalysisControls({ job, selected, busy, onStart, onCommand }: {
  job: AnalysisSnapshot; selected: number; busy: boolean; onStart(): void; onCommand(command: AnalysisCommand): void
}) {
  const resumable = !!job.id && ['stopped', 'interrupted', 'error'].includes(job.status)
  return <footer className="scan-footer">
    <div className="analysis-buttons">
      {activeJob(job.status) ? <>
        {job.status === 'paused' && <button className="primary-button" disabled={busy} onClick={() => onCommand('resume')}>Продолжить</button>}
        {job.status === 'running' && <button className="subtle-button" disabled={busy} onClick={() => onCommand('pause')}>Пауза</button>}
        <button className="subtle-button" disabled={busy || job.status === 'stopping'} onClick={() => onCommand('stop')}>{job.status === 'stopping' ? 'Сохранение…' : 'Остановить'}</button>
      </> : <>
        {resumable && <button className="primary-button" disabled={busy} onClick={() => onCommand('resume')}>Повторить</button>}
        <button className={resumable ? 'subtle-button' : 'primary-button'} data-action="scan" disabled={busy || selected === 0} onClick={onStart}><Icon name="search" size={17}/>{resumable ? 'Новый анализ' : 'Начать анализ'}</button>
      </>}
    </div>
  </footer>
}
