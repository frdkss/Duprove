import { useEffect, useState } from 'react'
import type { DeliverySnapshot } from '../../../contracts/delivery'
import type { DesktopBridge } from '../../../electron/bridge'
import './ReportDelivery.css'

export function ReportDelivery({ api }: { api?: Pick<DesktopBridge, 'getReportDelivery' | 'onReportDelivery'> }) {
  const [snapshot, setSnapshot] = useState<DeliverySnapshot | null>(null)
  const [error, setError] = useState(false)
  useEffect(() => {
    if (!api) return
    let active = true
    const receive = (next: DeliverySnapshot) => {
      if (active) { setSnapshot(previous => !previous || next.revision >= previous.revision ? next : previous); setError(false) }
    }
    const unsubscribe = api.onReportDelivery(receive)
    void api.getReportDelivery().then(receive).catch(() => { if (active) setError(true) })
    return () => { active = false; unsubscribe() }
  }, [api])
  let text = 'Нет подготовленных отчётов.'
  if (error || snapshot?.error) text = 'Не удалось подготовить отправку. Отчёты сохранены локально.'
  else if (snapshot) {
    if (!snapshot.enabled) text = 'Отключена. Отчёты остаются на компьютере.'
    else if (!snapshot.configured) text = 'Адрес сервера не настроен. Отчёты сохраняются локально.'
    else if (snapshot.sending) text = 'Отправляется отчёт…'
    else if (snapshot.pending) text = `Ожидают отправки: ${snapshot.pending}.${snapshot.nextAttemptAt ? ` Следующая попытка — ${new Date(snapshot.nextAttemptAt).toLocaleString('ru-RU')}.` : ''}`
    else if (snapshot.sent) text = `Доставлено отчётов: ${snapshot.sent}.`
    else if (snapshot.failed) text = 'Отчёты сохранены локально.'
    else if (snapshot.excluded) text = 'Прежние отчёты остаются локально; отправляться будут только новые.'
    if (snapshot.failed) text += ` Не доставлено: ${snapshot.failed}. Автоматические попытки для них завершены.`
  }
  return <div className="report-delivery" role="status"><span className="report-delivery-label">Отправка статистики:</span> {text}</div>
}
