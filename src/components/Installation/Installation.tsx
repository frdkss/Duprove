import useReleases from '../../hooks/useReleases'
import Survey from '../Survey/Survey'
import Downloads from '../Downloads/Downloads'
import './Installation.css'

export default function Installation() {
  const { state, retry } = useReleases()

  return (
    <section id="install" className="installation" aria-labelledby="install-title">
      <h2 id="install-title" className="installation__title">
        Установить сейчас
      </h2>
      <div className="installation__panels grid">
        <Survey />
        <Downloads state={state} retry={retry} />
      </div>
    </section>
  )
}
