import { useMemo } from 'react'
import { ArrowUpRight, RefreshCw } from 'lucide-react'
import renderMarkdown from '../../lib/renderMarkdown'
import type { ReleaseState } from '../../types/release'
import './ReleaseNotes.css'

interface ReleaseNotesProps {
  state: ReleaseState
  retry: () => void
}

export default function ReleaseNotes({ state, retry }: ReleaseNotesProps) {
  const current = state.releases[0]
  const body = current?.body?.trim() ?? ''
  const html = useMemo(() => renderMarkdown(body), [body])

  return (
    <section className="release-notes" aria-labelledby="release-notes-title">
      <h3 id="release-notes-title" className="release-notes__title">
        Что нового
      </h3>
      <div
        className="release-notes__body"
        aria-live="polite"
        aria-busy={state.status === 'loading'}
        tabIndex={body ? 0 : undefined}
      >
        {state.status === 'loading' ? (
          <p className="release-notes__message">Загружаем описание релиза…</p>
        ) : state.status === 'error' ? (
          <div className="release-notes__message">
            <p>{state.message}</p>
            <button
              className="release-notes__retry inline-flex items-center gap-2"
              type="button"
              onClick={retry}
            >
              <RefreshCw size={13} aria-hidden="true" />
              Повторить
            </button>
          </div>
        ) : !current ? (
          <p className="release-notes__message">
            Описание появится после публикации первого релиза.
          </p>
        ) : (
          <>
            <a
              className="release-notes__version inline-flex items-center gap-1"
              href={current.html_url}
              target="_blank"
              rel="noreferrer"
            >
              {current.name || `Duprove ${current.tag_name}`}
              <ArrowUpRight size={13} aria-hidden="true" />
            </a>
            {body ? (
              <div className="release-notes__content" dangerouslySetInnerHTML={{ __html: html }} />
            ) : (
              <p className="release-notes__message">У этого релиза пока нет описания.</p>
            )}
          </>
        )}
      </div>
    </section>
  )
}
