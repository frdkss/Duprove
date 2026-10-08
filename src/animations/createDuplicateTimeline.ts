import gsap from 'gsap'
import { titleAnimation } from '../config/animation'

export default function createDuplicateTimeline(heading: HTMLHeadingElement) {
  const original = heading.querySelector<HTMLElement>('.animated-title__original')!
  const duplicate = heading.querySelector<HTMLElement>('.animated-title__duplicate')!
  const copy = heading.querySelector<HTMLElement>('.animated-title__copy')!
  const tooltip = heading.querySelector<HTMLElement>('.animated-title__tooltip')!
  const cursor = heading.querySelector<HTMLElement>('.animated-title__cursor')!
  const word = 'Duprove'
  const timeline = gsap.timeline()
  const cycle = gsap.timeline({ repeat: -1, repeatDelay: titleAnimation.repeatPause })
  const selectionTime = titleAnimation.duplicateTyping + titleAnimation.detectionPause
  const fadeTime = selectionTime + titleAnimation.selectionHold
  const deletionTime = fadeTime + titleAnimation.fadeDuration

  original.textContent = ''
  copy.textContent = ''
  duplicate.classList.remove('is-selected')
  gsap.set(tooltip, { visibility: 'hidden' })
  gsap.set(cursor, { visibility: 'visible' })
  gsap.set(duplicate, { opacity: 1 })
  cycle.set(duplicate, { opacity: 1 }, 0)

  for (let index = 1; index <= word.length; index += 1) {
    timeline.set(
      original,
      { textContent: word.slice(0, index) },
      (index * titleAnimation.originalTyping) / word.length,
    )
    cycle.set(
      copy,
      { textContent: word.slice(0, index) },
      (index * titleAnimation.duplicateTyping) / word.length,
    )
  }

  cycle.call(() => duplicate.classList.add('is-selected'), [], selectionTime)
  cycle.set(tooltip, { visibility: 'visible' }, selectionTime)
  cycle.set(cursor, { visibility: 'hidden' }, selectionTime)
  cycle.to(
    duplicate,
    { opacity: 0, duration: titleAnimation.fadeDuration, ease: 'power1.out' },
    fadeTime,
  )
  cycle.set(copy, { textContent: '' }, deletionTime)
  cycle.set(tooltip, { visibility: 'hidden' }, deletionTime)
  cycle.call(() => duplicate.classList.remove('is-selected'), [], deletionTime)
  cycle.set(cursor, { visibility: 'visible' }, deletionTime)
  timeline.add(cycle, titleAnimation.originalTyping + titleAnimation.originalPause)

  return timeline
}
