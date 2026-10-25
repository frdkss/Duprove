import { useEffect } from 'react'
import { AnimatePresence, motion, useIsPresent } from 'motion/react'
import { Image } from 'lucide-react'
import { screenshots } from '../../config/screenshots'
import useSlideshow from '../../hooks/useSlideshow'
import type { Screenshot } from '../../types/screenshot'
import './ScreenshotGallery.css'

const fadeDuration = 1.15

function ScreenshotSlide({
  screenshot,
  reducedMotion,
}: {
  screenshot: Screenshot
  reducedMotion: boolean | null
}) {
  const isPresent = useIsPresent()

  return (
    <motion.img
      className="gallery__image"
      src={`${import.meta.env.BASE_URL}${screenshot.src}`}
      alt={screenshot.alt}
      aria-hidden={!isPresent}
      data-active={isPresent}
      decoding="async"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { delay: reducedMotion ? 0 : fadeDuration, duration: 0 } }}
      transition={{ duration: reducedMotion ? 0 : fadeDuration, ease: [0.4, 0, 0.2, 1] }}
    />
  )
}

export default function ScreenshotGallery() {
  const { activeIndex, reducedMotion } = useSlideshow(screenshots.length)
  const active = screenshots[activeIndex]

  useEffect(() => {
    if (screenshots.length < 2) return
    const next = new window.Image()
    next.decoding = 'async'
    next.src = `${import.meta.env.BASE_URL}${screenshots[(activeIndex + 1) % screenshots.length].src}`
  }, [activeIndex])

  return (
    <div
      className="gallery"
      role="region"
      aria-label="Скриншоты Duprove"
      aria-roledescription="карусель"
    >
      {active ? (
        <AnimatePresence initial={false} mode="sync">
          <ScreenshotSlide key={active.src} screenshot={active} reducedMotion={reducedMotion} />
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
    </div>
  )
}
