import { useRef } from 'react'
import useDuplicateAnimation from '../../hooks/useDuplicateAnimation'
import './AnimatedTitle.css'

export default function AnimatedTitle() {
  const titleRef = useRef<HTMLHeadingElement>(null)
  useDuplicateAnimation(titleRef, false)

  return (
    <div className="animated-title">
      <h1 ref={titleRef} className="animated-title__text" aria-label="Duprove">
        <span className="animated-title__original" aria-hidden="true">
          Duprove
        </span>
        <span className="animated-title__duplicate" aria-hidden="true">
          <span className="animated-title__copy" />
          <span className="animated-title__tooltip">найден дубликат</span>
        </span>
        <span className="animated-title__cursor" aria-hidden="true" />
      </h1>
    </div>
  )
}
