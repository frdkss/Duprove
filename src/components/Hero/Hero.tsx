import AnimatedTitle from '../AnimatedTitle/AnimatedTitle'
import ScreenshotGallery from '../ScreenshotGallery/ScreenshotGallery'
import './Hero.css'

export default function Hero() {
  return (
    <section id="home" className="hero" aria-label="Duprove">
      <AnimatedTitle />
      <p className="hero__tagline">
        Для тех, кто хранит всё.
        <br />
        Даже дважды.
      </p>
      <ScreenshotGallery />
      <p className="hero__description">
        <strong>Duprove</strong> — это программа для поиска и удаления <strong>дубликатов</strong>,
        которая помогает навести порядок в файлах и освободить место на диске. С{' '}
        <strong>Duprove</strong> вы найдёте лишние копии раньше, чем закончится свободное
        пространство, ведь одного файла вполне достаточно. <strong>Duprove</strong> покажет, где скрываются
        повторяющиеся файлы, и поможет быстро решить, что оставить, а что удалить. Освободите место
        без долгого ручного поиска и держите свои файлы под контролем.
      </p>
    </section>
  )
}
