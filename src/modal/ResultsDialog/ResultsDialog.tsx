import { useEffect, useRef, useState } from 'react'
import type { DesktopBridge } from '../../../electron/bridge'
import { PAGE_SIZE, type CatalogInfo, type FileGroup, type GroupKind, type GroupMember, type Page } from '../../../contracts/catalog'
import './ResultsDialog.css'

const labels: Record<GroupKind, string> = { exact: 'Точные дубликаты', warn_text: 'Похожие тексты', warn_image: 'Похожие изображения' }
const availability = { available: 'Доступен', missing: 'Файл отсутствует', changed: 'Файл изменился', unavailable: 'Нет доступа' }
export const decisionLabels = { unresolved: 'Не решено', keep: 'Оставить', review: 'Проверить вручную', delete: 'Отмечен для удаления', trashed: 'В корзине' }
export function catalogError(error: unknown): string {
  const text = String(error)
  const reasons: Record<string, string> = {
    CATALOG_UNAVAILABLE: 'Каталог результатов отсутствует. Закройте это окно и запустите новый анализ.',
    CATALOG_EXPIRED: 'Срок хранения результатов истёк. Запустите новый анализ.',
    ORIGINAL_PROTECTED: 'Этот файл выбран оригиналом в одной из групп. Сначала пересмотрите выбор.',
    FILE_UNAVAILABLE: 'Файл отсутствует, изменился или недоступен. Обновите анализ.',
    ANALYSIS_BUSY: 'Дождитесь окончания анализа.',
  }
  return Object.entries(reasons).find(([code]) => text.includes(code))?.[1] ?? 'Не удалось выполнить действие. Повторите попытку. ' + text.replace(/^Error: /, '')
}
export function Pager({ total, offset, busy, onPage, label }: { total: number; offset: number; busy: boolean; onPage(n: number): void; label: string }) {
  return <nav className="results-pager" aria-label={label}>
    <button disabled={busy || offset === 0} onClick={() => onPage(Math.max(0, offset - PAGE_SIZE))} aria-label={`${label}: назад`}>Назад</button>
    <span>{total ? `${offset + 1}–${Math.min(offset + PAGE_SIZE, total)} из ${total}` : '0'}</span>
    <button disabled={busy || offset + PAGE_SIZE >= total} onClick={() => onPage(offset + PAGE_SIZE)} aria-label={`${label}: далее`}>Далее</button>
  </nav>
}
export function ResultsDialog({ api, analysisId, onClose }: { api: DesktopBridge; analysisId: string; onClose(): void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const previousFocus = useRef(document.activeElement as HTMLElement | null)
  const [info, setInfo] = useState<CatalogInfo | null>(null)
  const [kind, setKind] = useState<GroupKind>('exact')
  const [groups, setGroups] = useState<Page<FileGroup> | null>(null)
  const [group, setGroup] = useState<FileGroup | null>(null)
  const [members, setMembers] = useState<Page<GroupMember> | null>(null)
  const [offset, setOffset] = useState(0)
  const [memberOffset, setMemberOffset] = useState(0)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [revision, refresh] = useState(0)
  useEffect(() => {
    const dialog = ref.current!
    dialog.showModal()
    return () => { dialog.close(); previousFocus.current?.focus() }
  }, [])
  useEffect(() => {
    let current = true
    setBusy(true); setError(''); setGroups(null); setMembers(null)
    void Promise.all([api.requestCatalog({ action: 'info', analysisId }), api.requestCatalog({ action: 'groups', analysisId, kind, offset })])
      .then(([meta, page]) => {
        if (!current) return
        setInfo(meta as CatalogInfo); setGroups(page as Page<FileGroup>)
        setGroup(previous => (page as Page<FileGroup>).items.find(g => g.id === previous?.id) ?? (page as Page<FileGroup>).items[0] ?? null)
      }).catch(e => { if (current) { setError(catalogError(e)); setGroup(null) } }).finally(() => { if (current) setBusy(false) })
    return () => { current = false }
  }, [api, analysisId, kind, offset, revision])
  useEffect(() => { setMemberOffset(0) }, [group?.id])
  useEffect(() => {
    if (!group) { setMembers(null); return }
    let current = true
    setMembers(null)
    void api.requestCatalog({ action: 'members', analysisId, groupId: group.id, offset: memberOffset })
      .then(page => { if (current) setMembers(page as Page<GroupMember>) }).catch(e => { if (current) setError(catalogError(e)) })
    return () => { current = false }
  }, [api, analysisId, group, memberOffset, revision])
  const original = async (fileId: number | null) => {
    if (!group) return
    setBusy(true); setError('')
    try { await api.requestCatalog({ action: 'original', analysisId, groupId: group.id, fileId }); refresh(v => v + 1) }
    catch (e) { setError(catalogError(e)) }
    finally { setBusy(false) }
  }
  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text) } catch { setError('Не удалось скопировать путь. Выделите его и нажмите Ctrl+C.') }
  }
  return <dialog ref={ref} className="results-dialog" aria-labelledby="results-title" onClose={onClose}>
    <header><div><h2 id="results-title">Группы файлов</h2><p>Оригинал — выбранный вами экземпляр для сохранения.</p></div>
      <button autoFocus aria-label="Закрыть группы" onClick={onClose}>×</button></header>
    {error && <p className="results-error" role="alert">{error} <button onClick={() => refresh(v => v + 1)} disabled={busy}>Повторить</button></p>}
    {info && <p className="results-note">{info.complete ? 'Завершённый анализ.' : 'Неполный результат: часть файлов не проверена.'} Статистика показывает исходный анализ. Каталог хранится до {new Date(info.expiresAt).toLocaleDateString('ru-RU')}.</p>}
    <div className="results-tabs" role="group" aria-label="Тип совпадения">{(Object.keys(labels) as GroupKind[]).map(k => <button key={k} aria-pressed={kind === k} disabled={busy} onClick={() => { setKind(k); setOffset(0); setGroup(null) }}>{labels[k]}{info ? ` (${info.groups[k]})` : ''}</button>)}</div>
    <div className="results-body" aria-busy={busy}>
      <section className="results-groups" aria-label="Список групп">
        {groups?.items.map(g => <button className="result-group" key={g.id} aria-pressed={group?.id === g.id} onClick={() => setGroup(g)}><strong>{g.id}</strong><span>{g.count.toLocaleString('ru-RU')} файлов · {g.bytes.toLocaleString('ru-RU')} байт</span></button>)}
        {groups && !groups.total && <p>Совпадений этого типа нет.</p>}
        {busy && <p role="status">Загрузка…</p>}
        {groups && <Pager {...groups} busy={busy} label="Страницы групп" onPage={setOffset}/>}
      </section>
      <section className="results-members" aria-label="Участники группы">
        {group && <><h3>{labels[group.kind]} · {group.id}</h3>
          {group.kind !== 'exact' && <p className="results-note">Содержимое может различаться. Сходство не подтверждает точное равенство.</p>}
          <p>Оригинал: {group.originalId === null ? 'не выбран' : `экземпляр №${group.originalId}`}. {group.originalId !== null && <button disabled={busy} onClick={() => void original(null)}>Снять выбор</button>}</p>
          {members?.items.map(member => <article className="result-member" key={member.id}>
            <label className="result-original"><input type="radio" name="original" aria-label={`Сохранять ${member.path}`} checked={group.originalId === member.id} disabled={busy || member.decision === 'trashed' || member.availability !== 'available'} onChange={() => void original(member.id)}/>Сохранять как оригинал{member.protected && <strong> · защищён</strong>}</label>
            <p className="result-path" tabIndex={0}>{member.path}</p>
            <p>{member.size.toLocaleString('ru-RU')} байт · {availability[member.availability]} · {decisionLabels[member.decision]}</p>
            <button onClick={() => void copy(member.path)}>Копировать путь</button>
          </article>)}
          {!members && <p role="status">Загрузка участников…</p>}
          {members && <Pager {...members} busy={busy} label="Страницы участников" onPage={setMemberOffset}/>}</>}
      </section>
    </div>
    <footer><button onClick={onClose}>Закрыть</button></footer>
  </dialog>
}
