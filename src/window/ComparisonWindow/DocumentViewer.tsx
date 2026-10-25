import { useEffect, useRef, useState } from 'react'
import type { ComparisonDocument } from '../../../contracts/comparison'
import type { WorkBook } from 'xlsx'
import { checkArchiveBudget, decodeEditorText, documentBytes, viewerError } from './viewer-utils'
import { PdfViewer } from './PdfViewer'

type Props = { document: ComparisonDocument; onReady(): void }
export function DocumentViewer({ document, onReady }: Props) {
  const url = document.url!
  if (document.kind === 'pdf') return <PdfViewer url={url} onReady={onReady}/>
  if (document.kind === 'audio' || document.kind === 'video') return <MediaViewer document={document} onReady={onReady}/>
  if (document.kind === 'image') return <ImageViewer document={document} onReady={onReady}/>
  if (document.kind === 'sheet') return <SheetViewer document={document} onReady={onReady}/>
  if (['docx', 'doc', 'rtf'].includes(document.kind)) return <WordViewer document={document} onReady={onReady}/>
  return <TextEditor document={document} onReady={onReady}/>
}
function TextEditor({ document, onReady }: Props) {
  const [value, setValue] = useState({ text: '', encoding: '' }), [error, setError] = useState(''), [wrap, setWrap] = useState(false), [size, setSize] = useState(14)
  useEffect(() => {
    const controller = new AbortController()
    void documentBytes(document.url!, document.size, controller.signal).then(bytes => { if (!controller.signal.aborted) { setValue(decodeEditorText(bytes)); onReady() } }).catch(error => { if (!controller.signal.aborted) setError(viewerError(error)) })
    return () => controller.abort()
  }, [document.url])
  return <div className="document-viewer text-editor"><div className="viewer-toolbar"><span>Текстовый редактор · {value.encoding || '…'}</span><label><input type="checkbox" checked={wrap} onChange={event => setWrap(event.target.checked)}/> Перенос строк</label><select aria-label="Размер текста" value={size} onChange={event => setSize(Number(event.target.value))}>{[12, 14, 16, 18, 22].map(n => <option key={n} value={n}>{n}</option>)}</select></div>
    {error ? <p role="alert">{error}</p> : <textarea aria-label={`Содержимое ${document.name}`} readOnly spellCheck={false} wrap={wrap ? 'soft' : 'off'} value={value.text} style={{ fontSize: size }}/>}</div>
}
function MediaViewer({ document, onReady }: Props) {
  const [error, setError] = useState(false)
  return <div className="document-viewer media-viewer"><div className="media-symbol" aria-hidden="true">{document.kind === 'audio' ? '♫' : '▶'}</div><h3>{document.name}</h3>
    {document.kind === 'audio' ? <audio controls preload="metadata" src={document.url} onLoadedMetadata={onReady} onError={() => setError(true)}/> : <video controls preload="metadata" src={document.url} onLoadedMetadata={onReady} onError={() => setError(true)}/>}
    {error && <p role="alert">Не удалось воспроизвести файл. Кодек может не поддерживаться или файл повреждён.</p>}</div>
}
function ImageViewer({ document, onReady }: Props) {
  const [src, setSrc] = useState(/\.tiff?$/i.test(document.name) ? undefined : document.url), [error, setError] = useState(''), [zoom, setZoom] = useState(1)
  useEffect(() => {
    if (!/\.tiff?$/i.test(document.name)) return
    let stopped = false
    void Promise.all([documentBytes(document.url!, document.size), import('utif')]).then(([bytes, module]) => {
      if (stopped) return
      const buffer = bytes.slice().buffer, tiff = module.default, pages = tiff.decode(buffer), page = pages[0]
      const width = Number(page?.t256?.[0]), height = Number(page?.t257?.[0])
      if (!page || !width || !height || width * height > 16 * 1024 ** 2) throw Error('DOCUMENT_LIMIT')
      tiff.decodeImage(buffer, page)
      const canvas = window.document.createElement('canvas'); canvas.width = page.width; canvas.height = page.height
      canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(tiff.toRGBA8(page)), page.width, page.height), 0, 0)
      setSrc(canvas.toDataURL('image/png'))
    }).catch(error => { if (!stopped) setError(viewerError(error)) })
    return () => { stopped = true }
  }, [document.url])
  return <div className="document-viewer image-viewer"><div className="viewer-toolbar"><span>Изображение</span><select aria-label="Масштаб изображения" value={zoom} onChange={event => setZoom(Number(event.target.value))}>{[.5, 1, 1.5, 2, 3].map(n => <option key={n} value={n}>{n * 100}%</option>)}</select></div>
    {error ? <p role="alert">{error}</p> : <div className="image-stage">{src ? <img src={src} alt={document.name} style={{ width: `${zoom * 100}%` }} onLoad={onReady} onError={() => setError('Не удалось прочитать изображение.')}/> : <p role="status">Загрузка изображения…</p>}</div>}</div>
}
function WordViewer({ document, onReady }: Props) {
  const host = useRef<HTMLDivElement>(null), [error, setError] = useState(''), [ready, setReady] = useState(false)
  useEffect(() => {
    let stopped = false
    const controller = new AbortController(), shadow = host.current!.shadowRoot ?? host.current!.attachShadow({ mode: 'open' })
    shadow.replaceChildren()
    const styles = window.document.createElement('style')
    styles.textContent = ':host{display:block;color:#171717} .paper{background:white;padding:24px;font:16px/1.55 Georgia,serif;white-space:pre-wrap} .docx-wrapper{background:transparent!important;padding:0!important} section.docx{margin:0 auto 16px!important;box-shadow:none!important} a{color:inherit;pointer-events:none}'
    const body = window.document.createElement('div'); shadow.append(styles, body)
    const fit = () => { const page = body.querySelector<HTMLElement>('section.docx'); if (page) body.style.zoom = String(Math.min(1, (host.current?.clientWidth ?? page.offsetWidth) / page.offsetWidth)) }
    const observer = new ResizeObserver(fit); observer.observe(host.current!)
    void (async () => {
      if (document.kind === 'doc') { body.className = 'paper'; body.textContent = document.text ?? ''; return }
      const bytes = await documentBytes(document.url!, document.size, controller.signal)
      checkArchiveBudget(bytes)
      if (stopped) return
      if (document.kind === 'docx') {
        const { renderAsync } = await import('docx-preview')
        await renderAsync(bytes, body, body, { useBase64URL: true, renderAltChunks: false, ignoreLastRenderedPageBreak: false })
      } else {
        const { RTFJS, WMFJS, EMFJS } = await import('rtf.js')
        RTFJS.loggingEnabled(false); WMFJS.loggingEnabled(false); EMFJS.loggingEnabled(false)
        const rtf = new RTFJS.Document(bytes.slice().buffer, {})
        body.className = 'paper'; body.append(...await rtf.render())
      }
      for (const element of body.querySelectorAll('script,iframe,object,embed,form,link,meta')) element.remove()
      for (const element of body.querySelectorAll('*')) for (const attribute of [...element.attributes]) {
        if (/^on/i.test(attribute.name) || attribute.name === 'href' || attribute.name === 'src' && !/^(data:|blob:)/.test(attribute.value)) element.removeAttribute(attribute.name)
      }
      fit()
    })().then(() => { if (!stopped) { setReady(true); onReady() } }).catch(error => { if (!stopped) setError(viewerError(error)) })
    return () => { stopped = true; controller.abort(); observer.disconnect(); shadow.replaceChildren() }
  }, [document.url, document.text])
  return <div className="document-viewer word-viewer"><div className="viewer-toolbar">{document.kind === 'rtf' ? 'RTF' : document.kind === 'doc' ? 'Word 97–2003 · текст документа' : 'Word'}{!ready && !error && ' · загрузка…'}</div>{error && <p role="alert">{error}</p>}<div className="word-stage"><div ref={host} className="word-document"/></div></div>
}
function SheetViewer({ document, onReady }: Props) {
  const [book, setBook] = useState<WorkBook | null>(null), [sheet, setSheet] = useState(''), [rows, setRows] = useState<string[][]>([]), [error, setError] = useState('')
  const [row, setRow] = useState(0), [column, setColumn] = useState(0), [bounds, setBounds] = useState({ rows: 0, columns: 0 })
  useEffect(() => {
    const controller = new AbortController()
    void Promise.all([documentBytes(document.url!, document.size, controller.signal), import('xlsx')]).then(([bytes, xlsx]) => {
      if (controller.signal.aborted) return
      const workbook = xlsx.read(bytes, { type: 'array', cellFormula: false, cellHTML: false, cellStyles: false })
      setBook(workbook); setSheet(workbook.SheetNames[0] ?? ''); onReady()
    }).catch(error => { if (!controller.signal.aborted) setError(viewerError(error)) })
    return () => controller.abort()
  }, [document.url])
  useEffect(() => {
    if (!book || !sheet) return
    void import('xlsx').then(xlsx => {
      const data = book.Sheets[sheet], range = xlsx.utils.decode_range(data['!ref'] ?? 'A1')
      setBounds({ rows: range.e.r + 1, columns: range.e.c + 1 })
      const grid: string[][] = []
      for (let r = row; r <= Math.min(range.e.r, row + 99); r++) {
        const cells: string[] = []
        for (let c = column; c <= Math.min(range.e.c, column + 49); c++) { const cell = data[xlsx.utils.encode_cell({ r, c })]; cells.push(cell ? xlsx.utils.format_cell(cell) : '') }
        grid.push(cells)
      }
      setRows(grid)
    })
  }, [book, sheet, row, column])
  const label = (n: number) => { let text = ''; for (n++; n > 0; n = Math.floor((n - 1) / 26)) text = String.fromCharCode(65 + (n - 1) % 26) + text; return text }
  return <div className="document-viewer sheet-viewer"><div className="viewer-toolbar"><select aria-label="Лист таблицы" value={sheet} onChange={event => { setSheet(event.target.value); setRow(0); setColumn(0) }}>{book?.SheetNames.map(name => <option key={name}>{name}</option>)}</select>
    <button disabled={row === 0} onClick={() => setRow(Math.max(0, row - 100))}>↑</button><span>{row + 1}–{Math.min(row + 100, bounds.rows)} / {bounds.rows}</span><button disabled={row + 100 >= bounds.rows} onClick={() => setRow(row + 100)}>↓</button>
    <button disabled={column === 0} onClick={() => setColumn(Math.max(0, column - 50))}>←</button><button disabled={column + 50 >= bounds.columns} onClick={() => setColumn(column + 50)}>→</button></div>
    {error ? <p role="alert">{error}</p> : <div className="sheet-stage"><table><thead><tr><th></th>{rows[0]?.map((_, i) => <th key={i}>{label(column + i)}</th>)}</tr></thead><tbody>{rows.map((cells, r) => <tr key={r}><th>{row + r + 1}</th>{cells.map((value, c) => <td key={c}>{value}</td>)}</tr>)}</tbody></table></div>}</div>
}
