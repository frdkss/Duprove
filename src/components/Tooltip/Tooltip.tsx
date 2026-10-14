import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../Icon/Icon'
import './Tooltip.css'

export function Tooltip({ label, text }: { label: string; text: string }) {
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  const show = () => {
    const rect = trigger.current?.getBoundingClientRect()
    if (rect) setPosition({ left: rect.left, top: rect.bottom + 8 })
  }
  useLayoutEffect(() => {
    if (!position || !popup.current || !trigger.current) return
    const rect = popup.current.getBoundingClientRect()
    const anchor = trigger.current.getBoundingClientRect()
    const left = Math.max(8, Math.min(position.left, window.innerWidth - rect.width - 8))
    const top = rect.bottom > window.innerHeight - 8 ? Math.max(8, anchor.top - rect.height - 8) : position.top
    if (left !== position.left || top !== position.top) setPosition({ left, top })
  }, [position])
  useEffect(() => {
    const close = () => setPosition(null)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
    return () => { window.removeEventListener('resize', close); window.removeEventListener('scroll', close, true) }
  }, [])
  return <><button ref={trigger} className="help-trigger" aria-label={label} aria-describedby={position ? id : undefined} onMouseEnter={show} onMouseLeave={() => setPosition(null)} onFocus={show} onBlur={() => setPosition(null)} onKeyDown={event => { if (event.key === 'Escape') setPosition(null) }} onClick={show}><Icon name="help" size={16}/></button>
    {position && createPortal(<div ref={popup} id={id} role="tooltip" className="tooltip" style={position}>{text}</div>, document.body)}</>
}
