import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DesktopBridge } from '../../../electron/bridge'
import type { CatalogInfo, FileGroup, Page } from '../../../contracts/catalog'
import { groupSearch, groupSelection, type GroupFilter } from '../../../contracts/group-filters'
import { MemberGroup } from './MemberGroup'
import { catalogError } from './result-utils'
import { useInfiniteCatalog } from './useInfiniteCatalog'
import './ResultsDialog.css'

export function ResultsDialog({ api, analysisId, onClose }: { api: DesktopBridge; analysisId: string; onClose(): void }) {
  const ref = useRef<HTMLDialogElement>(null), close = useRef<HTMLButtonElement>(null), previousFocus = useRef(document.activeElement as HTMLElement | null)
  const left = useRef<HTMLElement>(null), right = useRef<HTMLElement>(null), locked = useRef(false)
  const [info, setInfo] = useState<CatalogInfo | null>(null), [search, setSearch] = useState(''), [query, setQuery] = useState('')
  const [filters, setFilters] = useState<GroupFilter[]>([]), [revision, refresh] = useState(0), [busy, setBusy] = useState(false), [transferring, setTransferring] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    const dialog = ref.current!; dialog.show(); close.current?.focus()
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); if (!locked.current) dialog.close() } }
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('keydown', escape); dialog.close(); previousFocus.current?.focus() }
  }, [])
  useEffect(() => { const timer = setTimeout(() => setQuery(search), 180); return () => clearTimeout(timer) }, [search])
  useEffect(() => { let current = true; void api.requestCatalog({ action: 'info', analysisId }).then(value => { if (current) setInfo(value as CatalogInfo) }).catch(error => { if (current) setError(catalogError(error)) }); return () => { current = false } }, [api, analysisId])
  useEffect(() => api.onCatalogChanged(change => { if (change.analysisId === analysisId && !locked.current) refresh(value => value + 1) }), [api, analysisId])
  let queryError = ''
  try { groupSearch(query) } catch { queryError = 'Закройте кавычки в поисковом запросе.' }
  const selection = useMemo(() => groupSelection(filters), [filters]), filterKey = JSON.stringify(filters)
  const groups = useInfiniteCatalog<FileGroup>(offset => api.requestCatalog({ action: 'groups', analysisId, kind: 'exact', offset, query, filters }) as Promise<Page<FileGroup>>,
    `${analysisId}:${query}`, `${revision}:${filterKey}`, left, !queryError)
  const chosen = useInfiniteCatalog<FileGroup>(offset => api.requestCatalog({ action: 'groups', analysisId, kind: 'exact', offset, filters, selectedOnly: true }) as Promise<Page<FileGroup>>,
    `${analysisId}:chosen`, `${revision}:${filterKey}`, right, filters.length > 0)
  const perform = useCallback(async (action: () => Promise<void>, transfer = false) => {
    if (locked.current) throw Error('CATALOG_BUSY')
    locked.current = true; setBusy(true); setTransferring(transfer)
    try { await action() } finally { locked.current = false; setBusy(false); setTransferring(false); refresh(value => value + 1) }
  }, [])
  const checkedCount = groups.selectedTotal ?? 0, all = groups.total > 0 && checkedCount === groups.total
  const message = error || (groups.error ? catalogError(groups.error) : chosen.error ? catalogError(chosen.error) : '')
  return <><div className="results-backdrop" aria-hidden="true"/><dialog ref={ref} className="results-dialog" aria-labelledby="results-title" onCancel={event => { if (locked.current) event.preventDefault() }} onClose={onClose}>
    <header><h2 id="results-title">Группы файлов</h2><span className="results-kind">Точные дубликаты{info ? ` (${info.groups.exact.toLocaleString('ru-RU')})` : ''}</span><button ref={close} aria-label="Закрыть группы" disabled={transferring} onClick={onClose}>×</button></header>
    {message && <p className="results-error" role="alert">{message} <button onClick={() => { setError(''); refresh(value => value + 1) }} disabled={busy}>Повторить</button></p>}
    <div className="results-body" aria-busy={busy}>
      <section className="results-groups" ref={left} aria-label="Фильтры групп">
        <div className="results-filter-tools"><label className="results-search-label" htmlFor="group-search">Поиск по фильтрам</label><input id="group-search" type="search" aria-label="Поиск по фильтрам" maxLength={256} placeholder="Имя файла или формат" value={search} onChange={event => setSearch(event.target.value)} aria-invalid={!!queryError}/>
          <p className="results-search-hint">Часть имени, .txt, "имя.txt" или "при"*.tx*</p>
          {queryError && <p className="results-search-error" role="status">{queryError}</p>}
          <label className="results-select-all"><input className="checkbox" type="checkbox" aria-label="Выбрать все фильтры" checked={all} ref={input => { if (input) input.indeterminate = checkedCount > 0 && !all }} disabled={busy || groups.loading || search !== query || !!queryError || !groups.total} onChange={event => { const checked = event.target.checked; setFilters(previous => [...previous, { query, checked }]) }}/><strong>Выбрать всё</strong><small>{checkedCount.toLocaleString('ru-RU')} / {groups.total.toLocaleString('ru-RU')}</small></label>
        </div>
        <div className="results-filter-list">{groups.items.map(group => <label className="result-group" key={group.id} title={group.name} data-checked={selection(group.id, group.name)}>
          <input className="checkbox" type="checkbox" aria-label={`Фильтр ${group.name}`} checked={selection(group.id, group.name)} disabled={busy || search !== query} onChange={event => { const checked = event.target.checked; setFilters(previous => [...previous.filter(rule => !('id' in rule) || rule.id !== group.id), { id: group.id, checked }]) }}/>
          <strong>{group.name}</strong><span className="result-group-meta"><span>{group.count.toLocaleString('ru-RU')} файлов</span><span>{group.bytes.toLocaleString('ru-RU')} байт</span></span></label>)}
          {!groups.loading && !groups.total && !queryError && !groups.error && <p>Группы не найдены.</p>}
          {groups.loading && <p role="status">Загрузка фильтров…</p>}
          <div className="infinite-sentinel" ref={groups.sentinel} aria-hidden="true"/>
        </div>
      </section>
      <section className="results-members" ref={right} aria-label="Участники выбранных групп">
        {!chosen.loading && !chosen.items.length && !chosen.error && <p className="results-empty">Выберите фильтры слева, чтобы увидеть файлы.</p>}
        {chosen.items.filter(group => selection(group.id, group.name)).map(group => <MemberGroup key={group.id} api={api} analysisId={analysisId} group={group} root={right} revision={revision} busy={busy} perform={perform}/>)}
        {chosen.loading && <p role="status">Загрузка групп…</p>}
        <div className="infinite-sentinel" ref={chosen.sentinel} aria-hidden="true"/>
      </section>
    </div>
  </dialog></>
}
