import { useEffect, useState } from 'react'
import fetchInstructions from '../api/fetchInstructions'

type InstructionsState =
  | { status: 'idle' | 'loading'; markdown: string }
  | { status: 'success'; markdown: string }
  | { status: 'error'; markdown: string; message: string }

export default function useInstructions(enabled: boolean) {
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<InstructionsState>({ status: 'idle', markdown: '' })

  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    setState({ status: 'loading', markdown: '' })
    void fetchInstructions(controller.signal)
      .then((markdown) => {
        if (!controller.signal.aborted) setState({ status: 'success', markdown })
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setState({
            status: 'error',
            markdown: '',
            message: 'Не удалось загрузить инструкцию. Попробуйте ещё раз.',
          })
        }
      })
    return () => controller.abort()
  }, [enabled, attempt])

  return { state, retry: () => setAttempt((current) => current + 1) }
}
