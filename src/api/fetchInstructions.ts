import { instructionsRawUrl } from '../config/project'

export default async function fetchInstructions(signal: AbortSignal) {
  const response = await fetch(instructionsRawUrl, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]),
    cache: 'no-cache',
  })
  if (!response.ok) throw new Error('Не удалось загрузить инструкцию. Попробуйте ещё раз.')
  return response.text()
}
