import { useEffect, useState } from 'react'
import { useReducedMotion } from 'motion/react'
import { slideshowInterval } from '../config/screenshots'

export default function useSlideshow(count: number) {
  const [activeIndex, setActiveIndex] = useState(0)
  const [paused, setPaused] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const reducedMotion = useReducedMotion()

  useEffect(() => {
    if (count < 2 || paused || hovered || focused || reducedMotion) return
    const timer = window.setInterval(() => {
      if (!document.hidden) setActiveIndex((current) => (current + 1) % count)
    }, slideshowInterval)
    return () => window.clearInterval(timer)
  }, [count, paused, hovered, focused, reducedMotion, activeIndex])

  return { activeIndex, setActiveIndex, paused, setPaused, setHovered, setFocused, reducedMotion }
}
