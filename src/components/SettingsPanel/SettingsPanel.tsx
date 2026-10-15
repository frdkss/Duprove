import { useEffect, useState, type ReactNode } from 'react'
import { Icon, type IconName } from '../Icon/Icon'
import { Toggle } from '../Toggle/Toggle'
import { StatisticsConsent } from '../StatisticsConsent/StatisticsConsent'
import { AppUpdate } from '../AppUpdate/AppUpdate'
import type { DesktopBridge } from '../../../electron/bridge'
import './SettingsPanel.css'
export type Theme = 'light' | 'dark'
function Group({ title, icon, children }: { title: string; icon: IconName; children: ReactNode }) {
  return <section className="settings-group"><h2><Icon name={icon}/>{title}</h2><div>{children}</div></section>
}
function Row({ icon, label, children, unavailable = false }: { icon: IconName; label: string; children: ReactNode; unavailable?: boolean }) {
  return <div className={`setting-row ${unavailable ? 'setting-unavailable' : ''}`} title={unavailable ? 'Пока недоступно' : undefined}><Icon name={icon} size={18}/><span>{label}</span><div className="setting-control">{children}</div></div>
}
export function SettingsPanel({ theme, onTheme, api }: { theme: Theme; onTheme(theme: Theme): void; api?: DesktopBridge }) {
  const [autostart, setAutostart] = useState({ enabled: false, supported: false })
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { let active = true; void api?.getAutostart().then(value => { if (active) setAutostart(value) }).catch(() => { if (active) setError('Не удалось прочитать настройку автозапуска.') }); return () => { active = false } }, [api])
  const changeAutostart = async (enabled: boolean) => {
    if (!api) return
    setPending(true); setError('')
    try { setAutostart(await api.setAutostart(enabled)) } catch { setError('Не удалось изменить настройку автозапуска.') }
    finally { setPending(false) }
  }
  return <div className="settings-panel">
    {error && <p role="alert">{error}</p>}
    <Group title="Общие" icon="settings">
      <Row icon="globe" label="Язык интерфейса"><select aria-label="Язык интерфейса" disabled><option>Русский</option></select></Row>
      <Row icon="sun" label="Тема оформления"><select aria-label="Тема оформления" value={theme} onChange={e => onTheme(e.target.value as Theme)}><option value="light">Светлая</option><option value="dark">Тёмная</option></select></Row>
      <Row icon="power" label="Запускать вместе с системой" unavailable={!autostart.supported}><Toggle label="Запускать вместе с системой" checked={autostart.enabled} onChange={enabled => void changeAutostart(enabled)} disabled={pending || !autostart.supported}/></Row>
      <p className="autostart-note">Анализ начинается и продолжается только по кнопке.{!autostart.supported && ' Автозапуск доступен в установленном приложении.'}</p>
    </Group>
    <Group title="Сканирование" icon="search">
      <Row icon="folder" label="Исключённые папки" unavailable><button className="subtle-button" disabled>Настроить</button></Row>
      <Row icon="file" label="Исключённые типы файлов" unavailable><button className="subtle-button" disabled>Настроить</button></Row>
      <Row icon="file" label="Максимальный размер файла для анализа" unavailable><select aria-label="Максимальный размер файла" disabled><option>Без ограничений</option></select></Row>
      <Row icon="sliders" label="Количество потоков" unavailable><select aria-label="Количество потоков" disabled><option>Авто</option></select></Row>
    </Group>
    <Group title="Хранилище и результаты" icon="database">
      <Row icon="folder" label="Папка для временных файлов" unavailable><span className="path-placeholder">Пока не настроена</span><button className="subtle-button short" disabled>Изменить</button></Row>
      <Row icon="folder" label="Папка для сохранения отчётов" unavailable><span className="path-placeholder">Пока не настроена</span><button className="subtle-button short" disabled>Изменить</button></Row>
      <Row icon="trash" label="Автоматически удалять временные файлы" unavailable><Toggle label="Автоматически удалять временные файлы" checked={false} disabled/></Row>
      <Row icon="clock" label="Хранить результаты последнего сканирования" unavailable><Toggle label="Хранить результаты последнего сканирования" checked={false} disabled/></Row>
    </Group>
    <Group title="Дополнительно" icon="info">
      <AppUpdate api={api} settings/>
      <StatisticsConsent api={api}/>
    </Group>
  </div>
}
