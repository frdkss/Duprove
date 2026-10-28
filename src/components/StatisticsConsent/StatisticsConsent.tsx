import { useEffect, useRef, useState } from 'react'
import { STATISTICS_NOTICE_VERSION, type ConsentSnapshot } from '../../../contracts/consent'
import type { DesktopBridge } from '../../../electron/bridge'
import { Toggle } from '../Toggle/Toggle'
import { Icon } from '../Icon/Icon'
import './StatisticsConsent.css'
import { ReportDelivery } from '../ReportDelivery/ReportDelivery'

type ConsentApi = Pick<DesktopBridge, 'getStatisticsConsent' | 'setStatisticsConsent' | 'getReportDelivery' | 'onReportDelivery'>
export function StatisticsConsent({ api }: { api?: ConsentApi }) {
  const [consent, setConsent] = useState<ConsentSnapshot | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const changing = useRef(false)
  useEffect(() => {
    let active = true
    api?.getStatisticsConsent().then(value => { if (active) setConsent(value) })
      .catch(() => { if (active) setError('Не удалось прочитать настройку отправки.') })
    return () => { active = false }
  }, [api])
  const change = async (enabled: boolean) => {
    if (!api || changing.current) return
    changing.current = true
    setBusy(true)
    setError('')
    try {
      setConsent(await api.setStatisticsConsent({ enabled, noticeVersion: STATISTICS_NOTICE_VERSION }))
    } catch {
      setError('Не удалось изменить настройку отправки. Попробуйте ещё раз.')
      // A lost response must not leave a stale ON switch after an actual revocation.
      try { setConsent(await api.getStatisticsConsent()) } catch { setConsent(null) }
    } finally { changing.current = false; setBusy(false) }
  }
  return <div className="statistics-consent">
    <div className="setting-row">
      <Icon name="medium" size={18}/><span>Отправлять анонимную статистику</span>
      <Toggle label="Отправлять анонимную статистику" describedBy="statistics-purpose" checked={consent?.decision === 'granted' || consent?.decision === 'default-enabled'} disabled={!consent || busy} onChange={change}/>
    </div>
    <div className="statistics-description">
      <p id="statistics-purpose">Анонимная статистика для <strong>школьного проекта</strong>: данные о типах файлов для диаграмм и о дубликатах. Отправка включена по умолчанию; её можно отключить. Без неё программа работает локально.</p>
      <details><summary>Какие данные используются</summary>
        <p>Локально анализируются выбранные накопители: имена, пути, размеры, даты изменения, хеши и байты файлов для сравнения. Рабочий файл с путями и хешами остаётся на компьютере.</p>
        <p>В отчёт входят расширения, количества файлов и пустых файлов, экземпляров и лишних копий, группы дубликатов и размер каждого их участника в байтах, суммарные размеры файлов и дубликатов, ёмкость и занятое место дисков в байтах, прогресс анализа, обезличенные данные диаграмм, номера дисков внутри отчёта и обобщённые категории расположения: документы, загрузки, рабочий стол, изображения, музыка, видео и общий итог остальных папок. Промежуточные отчёты сохраняются и отправляются во время работы.</p>
        <p>Содержимое и имена файлов, полные пути, хеши, названия и структура нестандартных каталогов не отправляются.</p>
        <p>Отправку можно отключить этим переключателем. Ранее сохранённый отказ сохраняется при обновлении. Ожидающие отчёты останутся локально; после повторного включения отправляются только новые. Уже переданные данные отозвать из приложения нельзя.</p>
        <p>Каждый отчёт получает случайный номер для защиты от повторного учёта. Этот номер не обозначает пользователя или устройство. Результат отправки показывается отдельно от анализа.</p>
      </details>
      <ReportDelivery api={api}/>
      {consent?.persistenceError && <p className="statistics-error" role="alert">Не удалось сохранить выбор. Отправка отключена в текущем сеансе; после перезапуска проверьте настройку.</p>}
      {error && <p className="statistics-error" role="alert">{error}</p>}
    </div>
  </div>
}
