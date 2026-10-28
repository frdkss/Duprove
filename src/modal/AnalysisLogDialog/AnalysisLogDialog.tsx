import { useEffect, useRef } from 'react'
import { activeJob, analysisFinished, progressText, type AnalysisIssue, type AnalysisSnapshot, type AnalysisWork, type DiskProgress } from '../../../contracts/analysis'
import { AnalysisActivity, operationLabels } from '../../components/DriveOverview/AnalysisActivity'
import './AnalysisLogDialog.css'

const reasons: Record<AnalysisIssue['code'], string> = {
  root_unavailable: 'Выбранный диск или папка недоступны либо исключены из анализа.',
  directory_unavailable: 'Не удалось открыть папку. Её содержимое могло остаться непроверенным.',
  directory_changed: 'Папка была заменена или перемещена на другой том во время анализа.',
  enumeration_failed: 'Не удалось получить полный список файлов в папке.',
  metadata_unavailable: 'Не удалось получить сведения о файле или папке. Объект пропущен, анализ продолжен.',
  file_unavailable_or_changed: 'Файл не удалось открыть или он изменился во время проверки. Он пропущен до конца этого запуска и исключён из совпадений; анализ остальных файлов продолжен.',
}
const failures: Record<string, string> = {
  ANALYSIS_STORAGE_LIMIT: 'Анализ остановлен: достигнут предел рабочей базы (512 МиБ), временных таблиц (256 МиБ) или осталось менее 512 МиБ свободного места. Сохранённые контрольные точки оставлены на диске.',
  CATALOG_SAVE_FAILED: 'Анализ завершён, но каталог групп не сохранён. Статистика и рабочая база оставлены на диске. Проверьте свободное место и доступ, затем повторите анализ.',
  ANALYZER_UNAVAILABLE: 'Не удалось запустить анализатор.',
  ANALYZER_FAILED: 'Анализатор сообщил о внутренней ошибке и прекратил работу.',
  ANALYZER_OUTPUT_LIMIT: 'Объём ответа анализатора превысил допустимый размер.',
  INVALID_ANALYZER_EVENT: 'Анализатор вернул некорректные данные. Работа остановлена.',
  ANALYZER_INTERRUPTED: 'Анализатор завершился без итогового результата.',
  ANALYSIS_WORKER_FAILED: 'Процесс управления анализом перестал отвечать.',
  JOB_START_FAILED: 'Не удалось подготовить или запустить задание.',
  JOB_SAVE_FAILED: 'Не удалось сохранить результат или завершить очистку рабочих данных.',
  JOB_RESTORE_FAILED: 'Не удалось восстановить сохранённое состояние задания.',
}
const number = (value: number) => value.toLocaleString('ru-RU')
export function AnalysisLogDialog({ job, disk, onClose }: { job: AnalysisSnapshot; disk: DiskProgress; onClose(): void }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => { const dialog = ref.current!; dialog.showModal(); return () => dialog.close() }, [])
  const finished = analysisFinished(job)
  const active = activeJob(job.status)
  const diskIndex = job.drives.findIndex(d => d.path === disk.path)
  const title = finished ? disk.errors ? 'Завершено с ошибками' : 'Анализ завершён'
    : job.status === 'running' ? 'Анализ выполняется' : job.status === 'paused' ? 'Анализ на паузе'
    : job.status === 'stopping' ? 'Остановка анализа' : job.status === 'stopped' ? 'Анализ остановлен' : 'Анализ прерван'
  const stages: AnalysisWork['operation'][] = ['discovering', 'hashing', 'comparing', ...(job.content ? ['content', 'content_comparing'] as const : []), 'validating', 'saving']
  const operation = disk.work?.operation
  const stage = operation === 'preparing' ? 0 : operation ? stages.indexOf(operation) : -1
  const remaining = stages.slice(stage + 1)
  const explained = disk.issues?.reduce((sum, issue) => sum + issue.count, 0) ?? 0
  return <dialog ref={ref} className="analysis-log-dialog" aria-labelledby="analysis-log-title" onClose={onClose}>
    <header><div><p className="analysis-log-eyebrow">{diskIndex >= 0 ? `Накопитель ${diskIndex + 1}` : 'Накопитель'}</p><h2 id="analysis-log-title">Журнал анализа</h2></div>
      <button autoFocus className="analysis-log-close" aria-label="Закрыть журнал" onClick={onClose}>×</button></header>
    <div className="analysis-log-body">
      <div className="analysis-log-result"><strong>{title}</strong><b>{progressText(finished ? 100 : disk.overall_percent ?? 0)}%</b></div>
      <p>{finished ? disk.errors ? 'Обработка завершена. Часть данных не удалось проверить; ниже указаны зарегистрированные проблемы. 100% означает завершение работы, а не отсутствие ошибок.'
        : 'Обработка завершена. Ошибок проверки на этом диске не зарегистрировано.'
        : active ? job.status === 'paused' ? 'Работа приостановлена. Для возобновления нажмите «Продолжить».' : 'Состояние обновляется во время работы. Итоговые группы файлов будут доступны после завершения анализа.'
        : 'Обработка не завершена. Сохранённые результаты могут быть неполными; анализ можно повторить с сохранённым кэшем.'}</p>
      {job.error && job.error !== 'ANALYSIS_INCOMPLETE' && <p className="analysis-log-problem">{failures[job.error] ?? 'Во время выполнения задания произошла ошибка.'} <small>Код: {job.error}</small></p>}
      {job.exit && <p className="analysis-log-problem">{job.exit.code != null && <>
        Код завершения процесса: 0x{(job.exit.code >>> 0).toString(16).toUpperCase().padStart(8, '0')}.
        {(job.exit.code >>> 0) === 0xC0000005 && ' Нарушение доступа к памяти в анализаторе.'}
      </>}{job.exit.signal && <> Сигнал завершения: {job.exit.signal}.</>}</p>}
      {active && <AnalysisActivity progress={disk} paused={job.status === 'paused'} running={job.status === 'running' || job.status === 'stopping'}/>}
      {!finished && remaining.length > 0 && <p>{active ? 'Далее' : 'Оставшиеся этапы'}: {remaining.map(item => operationLabels[item]).join(' → ')}.</p>}
      <dl className="analysis-log-stats">
        <div><dt>Учтено файлов</dt><dd>{number(disk.files)}</dd></div>
        <div><dt>Файлов в группах дубликатов</dt><dd>{number(disk.duplicate_members)}</dd></div>
        <div><dt>Групп дубликатов на диске</dt><dd>{number(disk.duplicate_groups)}</dd></div>
        <div><dt>Пустых файлов</dt><dd>{number(disk.empty)}</dd></div>
        <div><dt>Ошибок проверки</dt><dd>{number(disk.errors)}</dd></div>
        <div><dt>Режим нагрузки</dt><dd>{{ low: 'Низкий', medium: 'Средний', high: 'Высокий' }[job.mode]}</dd></div>
      </dl>
      {job.total && <p>Во всём задании: {number(job.total.duplicate_groups)} групп, {number(job.total.duplicates)} лишних копий.</p>}
      {job.warnings && job.content && <p>Дополнительная проверка содержимого: {number(job.warnings.text)} текстовых и {number(job.warnings.image)} графических пар требуют внимания; {number(job.warnings.limited)} файлов пропущено из-за ограничений обработки.</p>}
      <h3>События и ошибки</h3>
      {!!disk.issues?.length && <ol className="analysis-log-issues">{disk.issues.map((issue, index) => <li key={index}>
        <strong>{operationLabels[issue.operation]} · {number(issue.count)}</strong><p>{reasons[issue.code]}</p>
      </li>)}</ol>}
      {disk.errors > explained && <p>Для {number(disk.errors - explained)} ошибок подробности не записаны. В старых результатах сохранялось только число ошибок.</p>}
      {disk.errors === 0 && <p>{finished ? 'Проверка этого диска закончена без зарегистрированных ошибок.' : active ? 'Ошибок проверки пока не зарегистрировано.' : 'До остановки ошибок проверки не зарегистрировано.'}</p>}
      {disk.errors > 0 && <p className="analysis-log-note">Число ошибок — число неудачных проверок, а не обязательно число файлов.</p>}
      {!finished && disk.work && <p>{active ? 'Текущая' : 'Последняя'} операция: {operationLabels[disk.work.operation]}.</p>}
      <p className="analysis-log-note">Журнал хранится локально и содержит только причины, этапы и счётчики. Имена и пути файлов в журнал не записываются.</p>
      <p className="analysis-log-note">При новом запуске служебные каталоги .git и .pytest_cache исключаются из анализа. Старый журнал сохраняет ошибки прежнего запуска; для обновления результата нажмите «Повторить».</p>
    </div>
    <footer><button className="primary-button" onClick={onClose}>Закрыть</button></footer>
  </dialog>
}
