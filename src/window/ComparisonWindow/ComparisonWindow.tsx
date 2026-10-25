import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { comparisonColumns, viewerKind, type ComparisonContext, type ComparisonDocument, type ComparisonFile } from '../../../contracts/comparison'
import { TitleBar } from '../../components/TitleBar/TitleBar'
import { DocumentViewer } from './DocumentViewer'
import './ComparisonWindow.css'

const names = { text: 'Текст', pdf: 'PDF', image: 'Изображение', audio: 'Аудио', video: 'Видео', docx: 'Word', doc: 'Word', rtf: 'RTF', sheet: 'Таблица' }
export function ComparisonWindow() {
  const [context, setContext] = useState<ComparisonContext | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [width, setWidth] = useState(innerWidth), [ready, setReady] = useState<number[]>([])
  const board = useRef<HTMLDivElement>(null)
  useEffect(() => {
    try { document.documentElement.dataset.theme = localStorage.getItem('duprove.theme') === 'dark' ? 'dark' : 'light' } catch { /* use the default theme */ }
    const resized = () => setWidth(innerWidth); addEventListener('resize', resized)
    const api = window.duprove!
    const unsubscribe = api.onComparison(setContext)
    void api.getComparison().then(setContext).catch(() => setError('Не удалось открыть выбранные файлы для сравнения.'))
    return () => { unsubscribe(); removeEventListener('resize', resized) }
  }, [])
  useEffect(() => { setReady([]); setError('') }, [context?.sessionId])
  const fileReady = useCallback((id: number) => setReady(previous => previous.includes(id) ? previous : [...previous, id]), [])
  const action = async (fileId: number, kind: 'original' | 'keep' | 'delete') => {
    if (!context) return
    setBusy(true); setError('')
    try {
      if (kind === 'original') await window.duprove!.requestCatalog({ action: 'original', analysisId: context.analysisId, groupId: context.groupId, fileId })
      else await window.duprove!.requestCatalog({ action: 'decision', analysisId: context.analysisId, groupId: context.groupId, fileId, decision: kind, reviewed: true })
    } catch (error) { setError(String(error).includes('ORIGINAL_PROTECTED') ? 'Сохраняемый оригинал защищён от удаления.' : 'Не удалось сохранить решение. Проверьте, что анализ не запущен и файлы доступны.') }
    finally { setBusy(false) }
  }
  const original = context && context.files.length > 1 ? context.files.find(file => file.id === context.originalId) : undefined
  const files = context?.files.filter(file => file.id !== original?.id) ?? []
  const columns = Math.max(original ? 2 : 1, comparisonColumns(width - 40, context?.files.length ?? 1))
  return <div className="comparison-shell"><TitleBar/><main className="comparison-main">
    <header className="comparison-heading"><div><h1>Сравнение содержимого</h1><p>{context ? `Документов: ${context.files.length} · Одновременно: ${Math.min(columns, context.files.length)}` : 'Подготовка файлов…'}</p></div>
      <div className="comparison-navigation"><button aria-label="Предыдущие документы" onClick={() => board.current?.scrollBy({ left: -(board.current.clientWidth + 16), behavior: 'smooth' })}>←</button><button aria-label="Следующие документы" onClick={() => board.current?.scrollBy({ left: board.current.clientWidth + 16, behavior: 'smooth' })}>→</button></div></header>
    {error && <p role="alert" className="comparison-error">{error}</p>}
    <div className="comparison-layout" style={{ '--comparison-columns': columns, '--comparison-scroll-columns': columns - (original ? 1 : 0) } as CSSProperties}>
      {context && original && <DocumentCard key={`${context.sessionId}:${original.id}`} file={original} context={context} board={board} pinned onReady={fileReady} busy={busy} ready={ready} onAction={kind => void action(original.id, kind)}/>}
      <div className="comparison-board" ref={board}>
        {context && files.map(file => <DocumentCard key={`${context.sessionId}:${file.id}`} file={file} context={context} board={board} onReady={fileReady} busy={busy} ready={ready} onAction={kind => void action(file.id, kind)}/>)}
      </div>
    </div></main></div>
}
function DocumentCard({ file, context, board, pinned = false, onReady, busy, ready, onAction }: { file: ComparisonFile; context: ComparisonContext;
  board: React.RefObject<HTMLDivElement | null>; pinned?: boolean; onReady(id: number): void; busy: boolean; ready: number[]; onAction(kind: 'original' | 'keep' | 'delete'): void }) {
  const card = useRef<HTMLElement>(null), [visible, setVisible] = useState(pinned), [document, setDocument] = useState<ComparisonDocument | null>(null), [error, setError] = useState(''), [retry, setRetry] = useState(0)
  const fileReady = useCallback(() => onReady(file.id), [file.id, onReady])
  useEffect(() => {
    if (pinned) return
    const observer = new IntersectionObserver(entries => setVisible(entries[0].isIntersecting), { root: board.current, rootMargin: '0px 120px' })
    observer.observe(card.current!)
    return () => observer.disconnect()
  }, [pinned])
  useEffect(() => {
    if (!visible || document) return
    let current = true
    void window.duprove!.getComparisonDocument(file.id).then(value => { if (current) setDocument(value) }).catch(() => { if (current) setError('Не удалось прочитать файл. Возможно, он изменился или больше недоступен.') })
    return () => { current = false }
  }, [visible, document, retry])
  const original = context.originalId === file.id
  return <section className="comparison-column" ref={card} data-file-id={file.id} data-original={original} data-pinned={pinned}>
    <header className="comparison-file-heading"><h2 title={file.name}>{file.name}</h2><p title={file.path}>{file.path}</p><span>{names[viewerKind(file.name)]} · {file.size.toLocaleString('ru-RU')} байт{original ? ' · Сохраняемый оригинал' : ''}</span></header>
    <div className="comparison-content">
      {error ? <div role="alert"><p>{error}</p><button onClick={() => { setError(''); setRetry(value => value + 1) }}>Повторить</button></div>
        : !document ? <p role="status">Загрузка содержимого…</p>
          : document.status !== 'ready' ? <p role="alert">{document.status === 'limit' ? 'Файл превышает предел размера просмотрщика или недостаточно места для локальной копии.' : 'Файл изменился, недоступен, повреждён или защищён.'}</p>
            : visible ? <DocumentViewer document={document} onReady={fileReady}/> : <p>Прокрутите к документу, чтобы продолжить просмотр.</p>}
    </div>
    <footer className="comparison-file-actions"><span>{original ? 'Оригинал защищён' : file.decision === 'delete' ? 'Отмечен для удаления' : file.decision === 'trashed' ? 'В корзине' : file.decision === 'keep' ? 'Оставить' : 'Решение не принято'}</span>
      {!original && <button disabled={busy || !ready.includes(file.id) || file.decision === 'trashed'} onClick={() => onAction('original')}>Сохранять как оригинал</button>}
      {!original && <button disabled={busy || file.decision === 'trashed'} onClick={() => onAction('keep')}>Оставить</button>}
      {!original && <button disabled={busy || file.protected || file.decision === 'trashed' || !context.originalId || !ready.includes(file.id) || !ready.includes(context.originalId)} onClick={() => onAction('delete')}>Проверено: отметить для удаления</button>}
    </footer>
  </section>
}
