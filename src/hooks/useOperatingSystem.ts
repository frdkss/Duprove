import { useEffect, useRef, useState } from 'react'
import detectOperatingSystem from '../lib/detectOperatingSystem'
import detectBrowserOperatingSystem from '../lib/detectBrowserOperatingSystem'
import type { OperatingSystem } from '../types/platform'

export default function useOperatingSystem() {
  const [operatingSystem, setOperatingSystem] = useState(() => detectOperatingSystem(navigator))
  const manuallySelected = useRef(false)

  useEffect(() => {
    let active = true
    void detectBrowserOperatingSystem(navigator).then((detected) => {
      if (active && !manuallySelected.current) setOperatingSystem(detected)
    })
    return () => {
      active = false
    }
  }, [])

  const selectOperatingSystem = (value: OperatingSystem) => {
    manuallySelected.current = true
    setOperatingSystem(value)
  }

  return { operatingSystem, selectOperatingSystem }
}
