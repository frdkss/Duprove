import { useEffect, useRef } from 'react'
import type { Drive } from '../../../electron/bridge'
import { DriveItem } from '../DriveItem/DriveItem'
import './DriveList.css'
import type { DiskProgress } from '../../../contracts/analysis'

interface Props {
  locked?: boolean; progress?: DiskProgress[]
  drives: Drive[]; selected: string[]; activePath: string
  onSelect(path: string, checked: boolean): void; onSelectAll(checked: boolean): void
}
export function DriveList({ drives, selected, activePath, onSelect, onSelectAll, locked, progress }: Props) {
  const all = useRef<HTMLInputElement>(null)
  useEffect(() => { if (all.current) all.current.indeterminate = selected.length > 0 && selected.length < drives.length }, [selected.length, drives.length])
  return <div className="drive-list" aria-label="Накопители">
    <label className="select-all"><input ref={all} className="checkbox" type="checkbox" checked={drives.length > 0 && selected.length === drives.length} disabled={!drives.length || locked} onChange={event => onSelectAll(event.target.checked)}/><span>Выбрать всё</span><span className="selection-count">{selected.length}/{drives.length}</span></label>
    {drives.map(drive => <DriveItem key={drive.path} drive={drive} progress={progress?.find(d => d.path === drive.path)} disabled={locked && !selected.includes(drive.path)} active={activePath === drive.path} selected={selected.includes(drive.path)} onChange={checked => onSelect(drive.path, checked)}/>)}
  </div>
}
