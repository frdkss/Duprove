import { ArrowUpRight } from 'lucide-react'
import { repositoryUrl } from '../../config/project'
import './Instructions.css'

export default function Instructions() {
  return (
    <section id="instructions" className="instructions" aria-labelledby="instructions-title">
      <h2 id="instructions-title">Инструкция</h2>
      <p>
        Выберите свою ОС в блоке выше и скачайте подходящий файл релиза. Порядок установки и
        требования к запуску смотрите в описании выбранной версии.
      </p>
      <a
        className="inline-flex items-center gap-1"
        href={`${repositoryUrl}#readme`}
        target="_blank"
        rel="noreferrer"
      >
        Документация проекта <ArrowUpRight size={13} aria-hidden="true" />
      </a>
    </section>
  )
}
