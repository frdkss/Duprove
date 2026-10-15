import { useEffect, useState } from 'react'
import type { DesktopBridge } from '../../../electron/bridge'
import type { UpdateSnapshot } from '../../../contracts/update'
import './AppUpdate.css'

export function AppUpdate({ api, settings = false }: { api?: DesktopBridge; settings?: boolean }) {
  const [state, setState] = useState<UpdateSnapshot | null>(null)
  useEffect(() => {
    if (!api?.onUpdate) return
    let mounted = true
    const receive = (next: UpdateSnapshot) => { if (mounted) setState(previous => !previous || next.revision >= previous.revision ? next : previous) }
    const unsubscribe = api.onUpdate(receive)
    void api.getUpdate().then(receive).catch(() => {})
    return () => { mounted = false; unsubscribe() }
  }, [api])
  if (!state) return null
  const messages: Record<UpdateSnapshot['status'], string> = {
    unavailable: 'Автообновления недоступны для этой установки.',
    idle: `Версия ${state.currentVersion}. Обновления проверяются автоматически.`,
    checking: 'Проверка обновлений…',
    downloading: `Загрузка версии ${state.availableVersion}: ${state.percent ?? 0}%.`,
    waiting: `Версия ${state.availableVersion} загружена. Установка начнётся после завершения или остановки анализа.`,
    scheduled: `Версия ${state.availableVersion} готова. Перезапуск — ${state.restartAt ? new Date(state.restartAt).toLocaleTimeString('ru-RU') : 'через минуту'}. Запуск анализа отложит обновление.`,
    installing: 'Устанавливается обновление. Приложение перезапустится автоматически.',
    error: 'Не удалось обновить приложение. Текущая версия сохранена; проверка повторится позже.',
  }
  if (!settings && ['unavailable', 'idle', 'checking', 'error'].includes(state.status)) return null
  return <div className="app-update" role="status"><p>{messages[state.status]}</p>{settings && <small>Обновления не зависят от отправки статистики.</small>}</div>
}
