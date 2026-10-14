import { useEffect, useRef } from 'react'
import { Icon } from '../../components/Icon/Icon'
import './HelpDialog.css'
export function HelpDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => { if (open) ref.current?.showModal(); else ref.current?.close() }, [open])
  return <dialog className="help-dialog" ref={ref} onClose={onClose} aria-labelledby="help-title"><button className="dialog-close" onClick={onClose} aria-label="Закрыть помощь"><Icon name="close"/></button>
    <img src="./logo.svg" width="46" height="46" alt=""/><h2 id="help-title">О Duprove</h2><p>Локальный анализ одинаковых и пустых файлов.</p>
    <div className="help-step"><b>01</b><p>Выберите диск, чтобы увидеть его объём. Галочками можно отметить несколько дисков для анализа.</p></div>
    <div className="help-step"><b>02</b><p>В «Режиме работы» выберите желаемую нагрузку. Выбор сохраняется на этом устройстве.</p></div>
    <div className="help-status"><Icon name="info" size={18}/><p>Сканирование пока недоступно. Файлы не изменяются, статистика не отправляется.</p></div>
    <button className="primary-button" onClick={onClose}>Понятно</button>
  </dialog>
}
