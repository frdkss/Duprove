import { useEffect, useMemo, useRef, useState } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { ArrowUpRight, ChevronDown, RefreshCw } from 'lucide-react'
import { instructionsUrl } from '../../config/project'
import useInstructions from '../../hooks/useInstructions'
import renderMarkdown from '../../lib/renderMarkdown'
import './Instructions.css'

export default function Instructions() {
  const sectionRef = useRef<HTMLElement>(null)
  const [expanded, setExpanded] = useState(() => window.location.hash === '#instructions')
  const [nearViewport, setNearViewport] = useState(false)
  const reducedMotion = useReducedMotion()
  const { state, retry } = useInstructions(expanded || nearViewport)
  const markdown = state.markdown.trim().replace(/^#\s+Инструкция\s*\r?\n+/u, '')
  const html = useMemo(() => {
    if (expanded) return renderMarkdown(markdown)
    const beginning = markdown.slice(0, 1400)
    const paragraphEnd = beginning.lastIndexOf('\n\n')
    return renderMarkdown(paragraphEnd > 600 ? beginning.slice(0, paragraphEnd) : beginning)
  }, [expanded, markdown])

  useEffect(() => {
    const revealFromHash = () => {
      if (window.location.hash === '#instructions') setExpanded(true)
    }
    window.addEventListener('hashchange', revealFromHash)
    return () => window.removeEventListener('hashchange', revealFromHash)
  }, [])

  useEffect(() => {
    const section = sectionRef.current
    if (!section) return
    if (!('IntersectionObserver' in window)) {
      setNearViewport(true)
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setNearViewport(true)
          observer.disconnect()
        }
      },
      { rootMargin: '300px' },
    )
    observer.observe(section)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (state.status !== 'success' || window.location.hash !== '#instructions') return
    const frame = requestAnimationFrame(() =>
      sectionRef.current?.scrollIntoView({
        block: 'start',
        behavior: reducedMotion ? 'instant' : 'smooth',
      }),
    )
    return () => cancelAnimationFrame(frame)
  }, [state.status, reducedMotion])

  return (
    <section
      ref={sectionRef}
      id="instructions"
      className="instructions"
      aria-labelledby="instructions-title"
    >
      <h2 id="instructions-title">Инструкция</h2>
      <div className="instructions__body" aria-busy={state.status === 'loading'}>
        {state.status === 'idle' || state.status === 'loading' ? (
          <p className="instructions__message" role="status">
            Загружаем инструкцию…
          </p>
        ) : state.status === 'error' ? (
          <div className="instructions__message" role="status">
            <p>{state.message}</p>
            <button
              type="button"
              className="instructions__retry inline-flex items-center gap-2"
              onClick={retry}
            >
              <RefreshCw size={13} aria-hidden="true" />
              Повторить
            </button>
          </div>
        ) : !markdown ? (
          <p className="instructions__message">Инструкция пока не заполнена.</p>
        ) : (
          <div className={`instructions__reader${expanded ? ' is-expanded' : ''}`}>
            <motion.div
              id="instructions-content"
              className="instructions__viewport"
              initial={{ height: 220 }}
              animate={{ height: expanded ? 'auto' : 220 }}
              transition={{ duration: reducedMotion ? 0 : 0.55, ease: [0.22, 1, 0.36, 1] }}
            >
              <div
                className="instructions__content"
                aria-hidden={!expanded}
                inert={!expanded}
                dangerouslySetInnerHTML={{ __html: html }}
              />
            </motion.div>
            {!expanded && (
              <button
                className="instructions__expand"
                type="button"
                aria-expanded={false}
                aria-controls="instructions-content"
                onClick={() => setExpanded(true)}
              >
                <span className="instructions__expand-label inline-flex items-center gap-2">
                  Читать инструкцию полностью
                  <ChevronDown size={16} aria-hidden="true" />
                </span>
              </button>
            )}
          </div>
        )}
        <a
          className="instructions__source inline-flex items-center gap-1"
          href={instructionsUrl}
          target="_blank"
          rel="noreferrer"
        >
          Инструкция на GitHub <ArrowUpRight size={13} aria-hidden="true" />
        </a>
      </div>
    </section>
  )
}
