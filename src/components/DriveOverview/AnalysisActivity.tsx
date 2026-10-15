import { useEffect, useState } from 'react'
import type { DiskProgress, AnalysisWork } from '../../../contracts/analysis'

export const operationLabels: Record<AnalysisWork['operation'], string> = {
  initializing: 'Открытие рабочей базы', discovering: 'Обход и метаданные', preparing: 'Подбор файлов одинакового размера',
  hashing: 'Чтение файлов и проверка SHA-256', comparing: 'Побайтовое сравнение', content: 'Чтение содержимого',
  content_comparing: 'Сравнение содержимого', validating: 'Проверка актуальности файлов', saving: 'Подготовка результата',
}
const number = (n: number) => n.toLocaleString('ru-RU', { maximumFractionDigits: 1 })
const bytes = (n: number) => n >= 1024 ** 3 ? `${number(n / 1024 ** 3)} ГиБ` : n >= 1024 ** 2 ? `${number(n / 1024 ** 2)} МиБ` : `${number(n / 1024)} КиБ`
const duration = (n: number) => n < 60 ? 'менее минуты' : n < 3600 ? `${Math.ceil(n / 60)} мин` : `${Math.floor(n / 3600)} ч ${Math.ceil(n % 3600 / 60)} мин`

export function AnalysisActivity({ progress, running, paused }: { progress: DiskProgress; running?: boolean; paused?: boolean }) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!running) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [running])
  const { work, timing } = progress
  if (!running && !paused) return null
  if (!work) return <p className="scan-details">Ожидание состояния анализатора…</p>
  if (progress.phase === 'waiting' && !['initializing', 'preparing'].includes(work.operation)) return <p className="scan-details">Ожидание обработки остальных дисков</p>
  const silence = timing ? Math.max(0, Math.floor((now - timing.updated_at) / 1000)) : 0
  const idle = timing ? Math.max(0, Math.floor((now - timing.advanced_at) / 1000)) : 0
  const warning = !paused && (silence >= 15 ? `Нет ответа анализатора ${silence} с. Можно остановить анализ.`
    : idle >= 30 ? `Нет продвижения ${idle} с · ${operationLabels[work.operation].toLowerCase()}` : '')
  const format = work.unit === 'bytes' ? bytes : number
  const unit = work.unit === 'directories' ? ' каталогов' : work.unit === 'files' ? ' файлов' : ''
  const rate = !paused && timing?.rate ? ` · ${work.unit === 'bytes' ? 'Обработка: ' : ''}${format(timing.rate)}${unit}/с` : ''
  const eta = paused ? 'Расчёт времени приостановлен' : warning ? 'Оценка времени недоступна до возобновления работы'
    : timing?.eta_seconds != null ? `До конца этапа ≈ ${duration(timing.eta_seconds)}` : 'Время: измеряется скорость…'
  return <div className="analysis-activity">
    <p className="current-operation" title={work.current}>{work.current || operationLabels[work.operation]}</p>
    <p className="work-amount">{work.files_total != null && `Файлы: ${number(work.files_done ?? 0)} / ${number(work.files_total)} · `}{format(work.done)}{work.total === null ? '' : ` / ${format(work.total)}`}{unit}{rate}</p>
    {work.cached_files != null && <p className="cache-details">Из кэша: {number(work.cached_files)} файлов · Прочитано: {bytes(work.read_bytes)}</p>}
    <p className="scan-eta">{eta}{!paused && !warning && timing?.total_eta_seconds != null
      ? <span title="Предварительный прогноз по скорости текущего этапа. Длительность следующих этапов пока считается такой же; прогноз пересчитывается при их смене."> · Весь анализ диска ≈ {duration(timing.total_eta_seconds)} (грубая оценка)</span>
      : !paused && work.operation === 'discovering' ? ' · Общий срок — после обхода' : ''}</p>
    {warning && <p className="activity-warning" role="status">{warning}</p>}
  </div>
}
