import { afterEach, describe, expect, it, vi } from 'vitest'
import fetchReleases from '../src/api/fetchReleases'
import selectReleases from '../src/lib/selectReleases'
import release from './fixtures/release'

afterEach(() => vi.unstubAllGlobals())

describe('Выбор актуального и предыдущего релиза', () => {
  const current = release()
  const previous = release({ id: 1, tag_name: 'v1.0.0', published_at: '2026-09-01T00:00:00Z' })

  it('Пропускает prerelease и черновики, сортирует стабильные версии', () => {
    const preview = release({ id: 3, prerelease: true, published_at: '2026-10-03T00:00:00Z' })
    const draft = release({ id: 4, draft: true, published_at: '2026-10-04T00:00:00Z' })
    expect(selectReleases([previous, preview, draft, current], null)).toEqual([current, previous])
  })

  it('Учитывает пометку latest от GitHub', () => {
    const newer = release({ id: 3, published_at: '2026-10-03T00:00:00Z' })
    expect(selectReleases([newer, current, previous], current)).toEqual([current, previous])
  })

  it('Корректно обрабатывает отсутствие или единственный релиз', () => {
    expect(selectReleases([], null)).toEqual([])
    expect(selectReleases([current], current)).toEqual([current])
  })

  it('Получает реальные адреса файлов без конструирования ссылок', async () => {
    const asset = {
      id: 9,
      name: 'duprove-windows.exe',
      size: 128,
      browser_download_url:
        'https://github.com/example/project/releases/download/v2.0.0/duprove-windows.exe',
    }
    const published = release({ assets: [asset] })
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify([published, previous])))
        .mockResolvedValueOnce(new Response(JSON.stringify(published))),
    )
    const result = await fetchReleases(new AbortController().signal)
    expect(result).toHaveLength(2)
    expect(result[0].assets[0].browser_download_url).toBe(asset.browser_download_url)
  })

  it('Пустой репозиторий и 404 latest не становятся ошибкой', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response('[]'))
        .mockResolvedValueOnce(new Response('{}', { status: 404 })),
    )
    await expect(fetchReleases(new AbortController().signal)).resolves.toEqual([])
  })

  it('Показывает ошибку лимита API', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 403 })))
    await expect(fetchReleases(new AbortController().signal)).rejects.toThrow(
      'GitHub временно ограничил запросы',
    )
  })

  it('Ищет стабильные релизы за страницей предварительных сборок', async () => {
    const previews = Array.from({ length: 100 }, (_, id) =>
      release({ id: 100 + id, prerelease: true }),
    )
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(previews)))
      .mockResolvedValueOnce(new Response(JSON.stringify(current)))
      .mockResolvedValueOnce(new Response(JSON.stringify([current, previous])))
    vi.stubGlobal('fetch', fetchMock)
    await expect(fetchReleases(new AbortController().signal)).resolves.toEqual([current, previous])
    expect(fetchMock.mock.calls[2][0]).toContain('page=2')
  })
})
