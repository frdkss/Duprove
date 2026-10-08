import { useEffect, useState } from 'react'
import fetchReleases from '../api/fetchReleases'
import type { ReleaseState } from '../types/release'

export default function useReleases() {
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<ReleaseState>({ status: 'loading', releases: [] })

  useEffect(() => {
    const controller = new AbortController()
    fetchReleases(controller.signal)
      .then((releases) => {
        if (!controller.signal.aborted) setState({ status: 'success', releases })
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        const message =
          error instanceof Error && error.message.startsWith('GitHub')
            ? error.message
            : 'Не удалось загрузить релизы. Проверьте подключение или откройте GitHub.'
        setState({ status: 'error', releases: [], message })
      })
    return () => controller.abort()
  }, [attempt])

  const retry = () => {
    setState({ status: 'loading', releases: [] })
    setAttempt((current) => current + 1)
  }

  return { state, retry }
}
