import { ChevronDown } from 'lucide-react'
import type { OperatingSystem } from '../../types/platform'
import './OperatingSystemSelect.css'

interface OperatingSystemSelectProps {
  value: OperatingSystem
  onChange: (value: OperatingSystem) => void
}

export default function OperatingSystemSelect({ value, onChange }: OperatingSystemSelectProps) {
  return (
    <div className="os-select flex items-center justify-center">
      <label htmlFor="operating-system">Ваша ОС</label>
      <div className="os-select__field">
        <select
          id="operating-system"
          value={value}
          onChange={(event) => onChange(event.target.value as OperatingSystem)}
        >
          <option value="unknown" disabled>
            Выберите ОС
          </option>
          <option value="windows">Windows</option>
          <option value="linux">Linux</option>
          <option value="macos">macOS</option>
        </select>
        <ChevronDown size={16} strokeWidth={1.4} aria-hidden="true" />
      </div>
    </div>
  )
}
