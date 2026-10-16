import type { ReactNode } from 'react'
import './Collapse.css'

export function Collapse({ open, id, children }: { open: boolean; id: string; children: ReactNode }) {
  return <div id={id} className={`collapse${open ? ' is-open' : ''}`} aria-hidden={!open} inert={!open}>
    <div className="collapse-inner">{children}</div>
  </div>
}
