import { AnimatePresence, motion } from 'motion/react'
import { ArrowLeft, ArrowRight, Image, Pause, Play } from 'lucide-react'
import { screenshots } from '../../config/screenshots'
import useSlideshow from '../../hooks/useSlideshow'
import './ScreenshotGallery.css'

export default function ScreenshotGallery() {
  const { activeIndex, setActiveIndex, paused, setPaused, setHovered, setFocused, reducedMotion } =
    useSlideshow(screenshots.length)
  const active = screenshots[activeIndex]

  return (
    <div
      className="gallery"
      role="region"
      aria-label="Скриншоты Duprove"
      aria-roledescription="карусель"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false)
      }}
    >
      {active ? (
        <AnimatePresence initial={false} mode="wait">
          <motion.img
            key={active.src}
            className="gallery__image"
            src={`${import.meta.env.BASE_URL}${active.src}`}
            alt={active.alt}
            initial={{ opacity: reducedMotion ? 1 : 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: reducedMotion ? 1 : 0 }}
            transition={{ duration: 0.25 }}
          />
        </AnimatePresence>
      ) : (
        <div className="gallery__placeholder flex flex-col items-center justify-center">
          <div className="gallery__icon">
            <Image size={30} strokeWidth={1.25} aria-hidden="true" />
          </div>
          <span>Здесь будут скриншоты Duprove</span>
          <span className="gallery__hint">Скриншоты появятся позже</span>
        </div>
      )}
      {screenshots.length > 1 && (
        <div className="gallery__controls flex items-center justify-between">
          <span className="gallery__count">
            {activeIndex + 1} / {screenshots.length}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              aria-label="Предыдущий скриншот"
              onClick={() =>
                setActiveIndex((activeIndex - 1 + screenshots.length) % screenshots.length)
              }
            >
              <ArrowLeft size={16} />
            </button>
            {!reducedMotion && (
              <button
                type="button"
                aria-label={paused ? 'Включить автослайд' : 'Остановить автослайд'}
                aria-pressed={paused}
                onClick={() => setPaused(!paused)}
              >
                {paused ? <Play size={14} /> : <Pause size={14} />}
              </button>
            )}
            <button
              type="button"
              aria-label="Следующий скриншот"
              onClick={() => setActiveIndex((activeIndex + 1) % screenshots.length)}
            >
              <ArrowRight size={16} />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
