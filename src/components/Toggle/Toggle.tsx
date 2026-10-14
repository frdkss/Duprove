import './Toggle.css'
export function Toggle({ label, checked, disabled = false, onChange }: { label: string; checked: boolean; disabled?: boolean; onChange?(checked: boolean): void }) {
  return <button className="toggle" role="switch" aria-label={label} aria-checked={checked} disabled={disabled} onClick={() => onChange?.(!checked)}><span/></button>
}
