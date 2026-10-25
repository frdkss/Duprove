import { useEffect, useState } from 'react'
import { useReducedMotion } from 'motion/react'
import { slideshowInterval } from '../config/screenshots'

export default function useSlideshow(count: number) {
  const [activeIndex, setActiveIndex] = useState(0)
  const reducedMotion = useReducedMotion()

  useEffect(() => {
    if (count < 2 || reducedMotion) return
    const timer = window.setInterval(() => {
      if (!document.hidden) setActiveIndex((current) => (current + 1) % count)
    }, slideshowInterval)
    return () => window.clearInterval(timer)
  }, [count, reducedMotion])

  return { activeIndex, reducedMotion }
}
