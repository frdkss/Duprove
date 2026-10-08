export default async function requestGitHub<T>(
  url: string,
  signal: AbortSignal,
  allowMissing = false,
): Promise<T | null> {
  const response = await fetch(url, {
    signal,
    headers: { Accept: 'application/vnd.github+json' },
  })

  if (allowMissing && response.status === 404) return null
  if (response.status === 403 || response.status === 429)
    throw new Error(
      'GitHub временно ограничил запросы. Попробуйте позже или откройте релизы на GitHub.',
    )
  if (!response.ok)
    throw new Error(
      'Не удалось получить релизы с GitHub. Попробуйте ещё раз или откройте их на GitHub.',
    )
  return (await response.json()) as T
}
