import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import gsap from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import createDuplicateTimeline from '../animations/createDuplicateTimeline'

gsap.registerPlugin(ScrollTrigger)

export default function useDuplicateAnimation(
  ref: RefObject<HTMLHeadingElement | null>,
  paused: boolean,
) {
  const pausedRef = useRef(paused)
  const timelineRef = useRef<gsap.core.Timeline | null>(null)

  useEffect(() => {
    const heading = ref.current
    if (!heading) return
    const media = gsap.matchMedia()

    media.add('(prefers-reduced-motion: no-preference)', () => {
      const timeline = createDuplicateTimeline(heading)
      timelineRef.current = timeline
      const trigger = ScrollTrigger.create({
        trigger: heading,
        start: 'top bottom',
        end: 'bottom top',
        onToggle: ({ isActive }) =>
          timeline.paused(!isActive || pausedRef.current || document.hidden),
      })
      const syncPlayback = () =>
        timeline.paused(pausedRef.current || document.hidden || !trigger.isActive)
      syncPlayback()
      document.addEventListener('visibilitychange', syncPlayback)

      return () => {
        document.removeEventListener('visibilitychange', syncPlayback)
        trigger.kill()
        timeline.kill()
        timelineRef.current = null
        heading.querySelector('.animated-title__original')!.textContent = 'Duprove'
        heading.querySelector('.animated-title__copy')!.textContent = ''
        heading.querySelector('.animated-title__duplicate')!.classList.remove('is-selected')
      }
    })

    return () => media.revert()
  }, [ref])

  useEffect(() => {
    pausedRef.current = paused
    timelineRef.current?.paused(
      paused || document.hidden || !ScrollTrigger.isInViewport(ref.current!),
    )
  }, [paused, ref])
}
