import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { Page } from '../../../contracts/catalog'

export function useInfiniteCatalog<T extends { id: string | number }>(request: (offset: number) => Promise<Page<T>>, key: string,
  revision: number | string, root: RefObject<HTMLElement | null>, enabled = true) {
  const [page, setPage] = useState<Page<T>>({ items: [], total: 0, offset: 0, limit: 25 })
  const [loading, setLoading] = useState(false), [error, setError] = useState<unknown>(null)
  const sentinel = useRef<HTMLDivElement>(null), generation = useRef(0), pending = useRef(false)
  const current = useRef({ request, page }); current.current = { request, page }
  const load = useCallback(async (offset: number, replace = false) => {
    if (pending.current || !enabled) return
    const token = generation.current; pending.current = true; setLoading(true); setError(null)
    try {
      let next = await current.current.request(offset)
      if (replace) {
        const count = current.current.page.items.length
        for (let at = next.items.length; at < Math.min(count, next.total); at += next.limit) {
          if (token !== generation.current) return
          const extra = await current.current.request(at)
          next = { ...extra, items: [...next.items, ...extra.items], offset: 0 }
        }
      }
      if (token === generation.current) setPage(previous => ({ ...next, offset: 0, items: offset === 0 ? next.items : [...previous.items, ...next.items.filter(item => !previous.items.some(old => old.id === item.id))] }))
    } catch (error) { if (token === generation.current) setError(error) }
    finally { if (token === generation.current) { pending.current = false; setLoading(false) } }
  }, [enabled, key])
  const previousKey = useRef('')
  useEffect(() => {
    const changed = previousKey.current !== key; previousKey.current = key
    generation.current++; pending.current = false; setError(null)
    if (changed || !enabled) setPage({ items: [], total: 0, offset: 0, limit: 25 })
    if (enabled) void load(0, !changed)
    else setLoading(false)
    return () => { generation.current++; pending.current = false }
  }, [key, revision, enabled, load])
  useEffect(() => {
    if (!sentinel.current || loading || error || !enabled || page.items.length >= page.total) return
    const observer = new IntersectionObserver(entries => { if (entries[0].isIntersecting) void load(page.items.length) }, { root: root.current, rootMargin: '300px' })
    observer.observe(sentinel.current)
    return () => observer.disconnect()
  }, [page.items.length, page.total, loading, error, enabled, load, root])
  return { ...page, loading, error, sentinel, retry: () => void load(0, true) }
}
