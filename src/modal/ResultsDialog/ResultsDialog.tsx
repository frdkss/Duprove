import { useEffect, useRef, useState } from 'react'
import type { DesktopBridge } from '../../../electron/bridge'
import { PAGE_SIZE, type CatalogInfo, type FileGroup, type GroupKind, type GroupMember, type Page, type TrashResult } from '../../../contracts/catalog'
import './ResultsDialog.css'

const labels: Record<GroupKind, string> = { exact: 'Точные дубликаты', warn_text: 'Похожие тексты', warn_image: 'Похожие изображения' }
const availability = { available: 'Найден', missing: 'Файл отсутствует', changed: 'Файл изменился', unavailable: 'Нет доступа' }
export const decisionLabels = { unresolved: 'Не решено', keep: 'Оставить', review: 'Проверить вручную', delete: 'Отмечен для удаления', trashed: 'В корзине' }
const canSelectMember = (member: GroupMember) => member.decision !== 'trashed' && member.availability === 'available' && member.lastOperation !== 'pending'
export function catalogError(error: unknown): string {
  const text = String(error)
  const reasons: Record<string, string> = {
    CATALOG_UNAVAILABLE: 'Каталог результатов отсутствует. Закройте это окно и запустите новый анализ.',
    CATALOG_EXPIRED: 'Срок хранения результатов истёк. Запустите новый анализ.',
    ORIGINAL_PROTECTED: 'Этот файл выбран оригиналом в одной из групп. Сначала пересмотрите выбор.',
    FILE_UNAVAILABLE: 'Файл отсутствует, изменился или недоступен. Обновите анализ.',
    ANALYSIS_BUSY: 'Дождитесь окончания анализа.',
    ORIGINAL_REQUIRED: 'Сначала выберите сохраняемый оригинал и другой экземпляр для сравнения.',
    MANUAL_REVIEW_REQUIRED: 'Для похожих файлов откройте оба предпросмотра и подтвердите ручную проверку.',
    CATALOG_BUSY: 'Дождитесь завершения текущей операции с файлами.',
    TRASH_RESULT_UNCERTAIN: 'Перенос был начат, но результат не записан. Проверьте файл и корзину вручную; затем выполните новый анализ.',
    CONFIRMATION_TOO_LARGE: 'Подтверждение содержит слишком длинные пути. Выберите меньше файлов.',
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
  const closeRef = useRef<HTMLButtonElement>(null)
  const previousFocus = useRef(document.activeElement as HTMLElement | null)
  const [info, setInfo] = useState<CatalogInfo | null>(null)
  const [kind, setKind] = useState<GroupKind>('exact')
  const [groups, setGroups] = useState<Page<FileGroup> | null>(null)
  const [group, setGroup] = useState<FileGroup | null>(null)
  const [members, setMembers] = useState<Page<GroupMember> | null>(null)
  const [offset, setOffset] = useState(0)
  const [memberOffset, setMemberOffset] = useState(0)
  const [error, setError] = useState('')
  const [loading, setBusy] = useState(false)
  const [revision, refresh] = useState(0)
  const [trashResult, setTrashResult] = useState<TrashResult | null>(null)
  const [transferring, setTransferring] = useState(false)
  const busy = loading || transferring
  const [selectedIds, setSelectedIds] = useState<number[]>([])
  const busyRef = useRef(false)
  busyRef.current = transferring
  useEffect(() => {
    const dialog = ref.current!
    dialog.show()
    closeRef.current?.focus()
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        if (!busyRef.current) dialog.close()
      }
    }
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('keydown', escape); dialog.close(); previousFocus.current?.focus() }
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
  useEffect(() => { setMemberOffset(0); setTrashResult(null) }, [group?.id])
  useEffect(() => api.onCatalogChanged(change => { if (change.analysisId === analysisId && !busyRef.current) refresh(value => value + 1) }), [api, analysisId])
  useEffect(() => { setSelectedIds([]) }, [group?.id, memberOffset])
  useEffect(() => {
    if (members) setSelectedIds(previous => previous.filter(id => members.items.some(member => member.id === id && canSelectMember(member))))
  }, [members])
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
  const compare = async (fileIds: number[]) => {
    if (!group) return
    setBusy(true); setError('')
    try { await api.openComparison({ analysisId, groupId: group.id, fileIds }) }
    catch (e) { setError(catalogError(e)) }
    finally { setBusy(false) }
  }
  const decide = async (fileId: number, decision: 'unresolved' | 'keep' | 'review' | 'delete', reviewed = false) => {
    if (!group) return
    setBusy(true); setError('')
    try { await api.requestCatalog({ action: 'decision', analysisId, groupId: group.id, fileId, decision, reviewed }); refresh(v => v + 1) }
    catch (e) { setError(catalogError(e)) }
    finally { setBusy(false) }
  }
  const trash = async (fileIds: number[]) => {
    if (!group || !fileIds.length) return
    setBusy(true); setTransferring(true); setError(''); setTrashResult(null)
    busyRef.current = true
    try {
      for (const fileId of fileIds) {
        const member = members?.items.find(value => value.id === fileId)
        if (!member || member.protected || member.id === group.originalId) throw Error('ORIGINAL_PROTECTED')
        if (member.decision !== 'delete') await api.requestCatalog({ action: 'decision', analysisId, groupId: group.id, fileId, decision: 'delete', reviewed: false })
      }
      setTrashResult(await api.trashCatalog({ analysisId, groupId: group.id, fileIds })); refresh(v => v + 1)
    }
    catch (e) { setError(catalogError(e)) }
    finally { setBusy(false); setTransferring(false) }
  }
  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text) } catch { setError('Не удалось скопировать путь. Выделите его и нажмите Ctrl+C.') }
  }
  const selectMember = (id: number, checked: boolean) => setSelectedIds(previous => checked ? [...previous, id] : previous.filter(value => value !== id))
  const selectedMembers = members?.items.filter(member => selectedIds.includes(member.id)) ?? []
  const canTrashSelected = !!group?.originalId && selectedMembers.length > 0
    && selectedMembers.every(member => canSelectMember(member) && !member.protected && member.id !== group.originalId && (group.kind === 'exact' || member.decision === 'delete'))
  return <><div className="results-backdrop" aria-hidden="true"/><dialog ref={ref} className="results-dialog" aria-labelledby="results-title" onCancel={event => { if (busyRef.current) event.preventDefault() }} onClose={onClose}>
    <header><h2 id="results-title">Группы файлов</h2>
      <div className="results-tabs" role="group" aria-label="Тип совпадения">{(Object.keys(labels) as GroupKind[]).map(k => <button key={k} aria-pressed={kind === k} disabled={busy} onClick={() => { setKind(k); setOffset(0); setGroup(null) }}>{labels[k]}{info ? ` (${info.groups[k]})` : ''}</button>)}</div>
      <button ref={closeRef} aria-label="Закрыть группы" disabled={transferring} onClick={onClose}>×</button></header>
    {error && <p className="results-error" role="alert">{error} <button onClick={() => refresh(v => v + 1)} disabled={busy}>Повторить</button></p>}
    {trashResult && <p className="results-note" role="status">{trashResult.cancelled ? 'Перенос отменён. Файлы не изменены.' : `В корзине: ${trashResult.results.filter(r => r.status === 'trashed').length}. Ошибок: ${trashResult.results.filter(r => r.status === 'error').length}.`}
      {trashResult.results.some(r => r.status === 'error') && ' Для части операций успех не подтверждён. Проверьте файлы и корзину; при неопределённом результате повтор блокируется до нового анализа.'}</p>}
    <div className="results-body" aria-busy={busy}>
      <section className="results-groups" aria-label="Список групп">
        {groups?.items.map(g => <button className="result-group" key={g.id} disabled={busy} aria-pressed={group?.id === g.id} title={g.name} onClick={() => setGroup(g)}><strong>{g.name}</strong><span className="result-group-meta"><span>{g.count.toLocaleString('ru-RU')} файлов</span><span>{g.bytes.toLocaleString('ru-RU')} байт</span></span></button>)}
        {groups && !groups.total && <p>Совпадений этого типа нет.</p>}
        {busy && <p role="status">{transferring ? 'Проверка файлов и перенос в корзину…' : 'Загрузка…'}</p>}
        {groups && <Pager {...groups} busy={busy} label="Страницы групп" onPage={setOffset}/>}
      </section>
      <section className="results-members" aria-label="Участники группы">
        {group && <><div className="results-group-heading"><h3>{labels[group.kind]} · {group.name}</h3>
          {group.kind !== 'exact' && <p className="results-note">Содержимое может различаться. Сходство не подтверждает точное равенство.</p>}
          <div className="results-group-toolbar"><p>Оригинал: {group.originalId === null ? 'не выбран' : `экземпляр №${group.originalId}`}. {group.originalId !== null && <button disabled={busy} onClick={() => void original(null)}>Снять выбор</button>}</p>
          <div className="result-actions"><button disabled={busy || selectedMembers.length < 2} onClick={() => void compare(selectedMembers.map(member => member.id))}>Сравнить выделенные ({selectedMembers.length})</button>
          <button disabled={busy || !canTrashSelected} onClick={() => void trash(selectedMembers.map(member => member.id))}>Перенести отмеченные на странице в корзину</button></div>
          </div></div>
          {members?.items.map(member => <article className="result-member" key={member.id}>
            <input className="checkbox result-member-selection" type="checkbox" aria-label={`Выделить ${member.path}`} checked={selectedIds.includes(member.id) && canSelectMember(member)} disabled={busy || !canSelectMember(member)} onChange={event => selectMember(member.id, event.target.checked)}/>
            <div className="result-member-info">
              <h4 className="result-member-name" title={member.name}>{member.name}</h4>
              <p className="result-path" title={member.path} tabIndex={0}>{member.path}</p>
              <p>{member.size.toLocaleString('ru-RU')} байт</p>
              {member.availability !== 'available' && member.decision !== 'trashed' && <p className="result-member-status">{availability[member.availability]}</p>}
              {member.lastOperation === 'pending' && <p role="alert">Результат переноса не подтверждён. Проверьте файл вручную и выполните новый анализ.</p>}
              {member.lastOperation === 'failed' && <p>Последняя попытка переноса не выполнена.</p>}
            </div>
            <div className="result-member-controls">
              {member.decision !== 'trashed' && <button disabled={busy || member.availability !== 'available'} onClick={() => void compare([member.id])}>Открыть</button>}
              {member.decision !== 'trashed' && group.originalId !== member.id && <button className="result-compare" disabled={busy || !group.originalId || member.availability !== 'available'} onClick={() => void compare([group.originalId!, member.id])}>Сравнить с оригиналом</button>}
              <button onClick={() => void copy(member.path)}>Копировать путь</button>
              {member.decision !== 'trashed' ? <select aria-label={`Решение для ${member.path}`} value={member.decision} disabled={busy} onChange={e => void decide(member.id, e.target.value as 'unresolved' | 'keep' | 'review' | 'delete')}>
                <option value="unresolved">Не решено</option><option value="keep">Оставить</option><option value="review">Проверить вручную</option>
                <option value="delete" disabled={member.protected || !group.originalId || group.kind !== 'exact'}>Отметить для удаления</option>
              </select> : <span className="result-member-status">{decisionLabels.trashed}</span>}
              {member.decision === 'delete' && <button disabled={busy || member.protected || member.lastOperation === 'pending'} onClick={() => void trash([member.id])}>В корзину</button>}
            </div>
            <label className="result-original"><input type="radio" name="original" aria-label={`Сохранять ${member.path}`} checked={group.originalId === member.id} disabled={busy || member.decision === 'trashed' || member.availability !== 'available'} onChange={() => void original(member.id)}/>Сохранять как оригинал{member.protected && <strong> · защищён</strong>}</label>
          </article>)}
          {!members && <p role="status">Загрузка участников…</p>}
          {members && <Pager {...members} busy={busy} label="Страницы участников" onPage={setMemberOffset}/>}</>}
      </section>
    </div>
  </dialog></>
}
