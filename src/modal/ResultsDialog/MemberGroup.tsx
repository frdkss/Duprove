import { useEffect, useRef, useState, type RefObject } from 'react'
import type { DesktopBridge } from '../../../electron/bridge'
import type { FileGroup, GroupMember, Page, TrashResult } from '../../../contracts/catalog'
import { MAX_COMPARISON_FILES } from '../../../contracts/comparison'
import { availability, canSelectMember, catalogError, decisionLabels } from './result-utils'
import { useInfiniteCatalog } from './useInfiniteCatalog'
export function MemberGroup({ api, analysisId, group, root, revision, busy, perform }: {
  api: DesktopBridge; analysisId: string; group: FileGroup; root: RefObject<HTMLElement | null>; revision: number; busy: boolean
  perform(action: () => Promise<void>, transfer?: boolean): Promise<void>
}) {
  const section = useRef<HTMLElement>(null), [visible, setVisible] = useState(false)
  const [selectedIds, setSelectedIds] = useState<number[]>([]), [error, setError] = useState(''), [trashResult, setTrashResult] = useState<TrashResult | null>(null)
  useEffect(() => {
    const observer = new IntersectionObserver(entries => { if (entries[0].isIntersecting) { setVisible(true); observer.disconnect() } }, { root: root.current, rootMargin: '500px' })
    observer.observe(section.current!); return () => observer.disconnect()
  }, [root])
  const members = useInfiniteCatalog<GroupMember>(offset => api.requestCatalog({ action: 'members', analysisId, groupId: group.id, offset }) as Promise<Page<GroupMember>>,
    `${analysisId}:${group.id}`, revision, root, visible)
  useEffect(() => { setSelectedIds(previous => previous.filter(id => members.items.some(member => member.id === id && canSelectMember(member)))) }, [members.items])
  const run = async (action: () => Promise<void>, transfer = false) => {
    setError('')
    try { await perform(action, transfer) } catch (error) { setError(catalogError(error)) }
  }
  const original = (fileId: number | null) => run(async () => { await api.requestCatalog({ action: 'original', analysisId, groupId: group.id, fileId }) })
  const compare = (fileIds: number[]) => run(() => api.openComparison({ analysisId, groupId: group.id, fileIds }))
  const decide = (fileId: number, decision: 'unresolved' | 'keep' | 'review' | 'delete') => run(async () => { await api.requestCatalog({ action: 'decision', analysisId, groupId: group.id, fileId, decision, reviewed: false }) })
  const trash = (fileIds: number[]) => run(async () => {
    setTrashResult(null)
    for (const fileId of fileIds) {
      const member = members.items.find(member => member.id === fileId)
      if (!member || member.protected || member.id === group.originalId) throw Error('ORIGINAL_PROTECTED')
      if (member.decision !== 'delete') await api.requestCatalog({ action: 'decision', analysisId, groupId: group.id, fileId, decision: 'delete', reviewed: false })
    }
    setTrashResult(await api.trashCatalog({ analysisId, groupId: group.id, fileIds }))
  }, true)
  const copy = async (text: string) => { try { await navigator.clipboard.writeText(text) } catch { setError('Не удалось скопировать путь. Выделите его и нажмите Ctrl+C.') } }
  const selectMember = (id: number, checked: boolean) => setSelectedIds(previous => checked ? [...previous, id] : previous.filter(value => value !== id))
  const selectedMembers = members.items.filter(member => selectedIds.includes(member.id))
  const canTrashSelected = !!group.originalId && selectedMembers.length > 0 && selectedMembers.length <= 1000 && selectedMembers.every(member => canSelectMember(member) && !member.protected && member.id !== group.originalId)
  return <section className="result-member-group" ref={section} data-group-id={group.id} aria-label={`Группа ${group.name}`}>
    <div className="results-group-heading"><h3>Точные дубликаты · {group.name}</h3>
      <div className="results-group-toolbar"><p>Оригинал: {group.originalId === null ? 'не выбран' : `экземпляр №${group.originalId}`}. {group.originalId !== null && <button disabled={busy} onClick={() => void original(null)}>Снять выбор</button>}</p>
        <div className="result-actions"><button disabled={busy || selectedMembers.length < 2 || selectedMembers.length > MAX_COMPARISON_FILES} onClick={() => void compare(selectedMembers.map(member => member.id))}>Сравнить выделенные ({selectedMembers.length})</button>
          <button disabled={busy || !canTrashSelected} onClick={() => void trash(selectedMembers.map(member => member.id))}>Перенести выделенные в корзину</button></div></div>
      {selectedMembers.length > MAX_COMPARISON_FILES && <p className="results-note">Для сравнения можно выделить до {MAX_COMPARISON_FILES} файлов.</p>}
      {selectedMembers.length > 1000 && <p className="results-note">За один перенос можно выбрать до 1 000 файлов.</p>}
    </div>
    {(!!error || !!members.error) && <p className="results-error" role="alert">{error || catalogError(members.error)} {!!members.error && <button onClick={members.retry}>Повторить</button>}</p>}
    {trashResult && <p className="results-note" role="status">{trashResult.cancelled ? 'Перенос отменён. Файлы не изменены.' : `В корзине: ${trashResult.results.filter(file => file.status === 'trashed').length}. Ошибок: ${trashResult.results.filter(file => file.status === 'error').length}.`}
      {trashResult.results.some(file => file.status === 'error') && ' Для части операций успех не подтверждён. Проверьте файлы и корзину; при неопределённом результате повтор блокируется до нового анализа.'}</p>}
          {members.items.map(member => <article className="result-member" key={member.id}>
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
            <label className="result-original"><input type="radio" name={`original-${group.id}`} aria-label={`Сохранять ${member.path}`} checked={group.originalId === member.id} disabled={busy || member.decision === 'trashed' || member.availability !== 'available'} onChange={() => void original(member.id)}/>Сохранять как оригинал{member.protected && <strong> · защищён</strong>}</label>
          </article>)}
    {(!visible || members.loading) && <p role="status">Загрузка участников…</p>}
    <div className="infinite-sentinel" ref={members.sentinel} aria-hidden="true"/>
  </section>
}
