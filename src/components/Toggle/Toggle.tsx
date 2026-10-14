import './Toggle.css'
export function Toggle({ label, checked, disabled = false, describedBy, onChange }: { label: string; checked: boolean; disabled?: boolean; describedBy?: string; onChange?(checked: boolean): void }) {
  return <button className="toggle" role="switch" aria-label={label} aria-describedby={describedBy} aria-checked={checked} disabled={disabled} onClick={() => onChange?.(!checked)}><span/></button>
}
