import { useEffect, useRef, useState } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

export function PdfViewer({ url, onReady }: { url: string; onReady(): void }) {
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null)
  const [page, setPage] = useState(1), [zoom, setZoom] = useState(1), [text, setText] = useState(''), [error, setError] = useState('')
  const canvas = useRef<HTMLCanvasElement>(null), container = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(400)
  useEffect(() => {
    const observer = new ResizeObserver(entries => setWidth(entries[0].contentRect.width))
    observer.observe(container.current!)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    let stopped = false, task: { destroy(): Promise<void> } | undefined
    void import('pdfjs-dist').then(pdf => {
      if (stopped) return
      pdf.GlobalWorkerOptions.workerSrc = pdfWorker
      const assets = new URL('./pdf-assets/', location.href.split('#')[0]).href
      const loading = pdf.getDocument({ url, cMapUrl: assets + 'cmaps/', cMapPacked: true,
        standardFontDataUrl: assets + 'standard_fonts/', wasmUrl: assets + 'wasm/', iccUrl: assets + 'iccs/' })
      task = loading
      void loading.promise.then(value => { if (!stopped) { setDocument(value); setPage(1) } }).catch(() => { if (!stopped) setError('Не удалось открыть PDF. Возможно, файл повреждён или защищён паролем.') })
    }).catch(() => { if (!stopped) setError('Не удалось загрузить просмотрщик PDF.') })
    return () => { stopped = true; void task?.destroy() }
  }, [url])
  useEffect(() => {
    if (!document || !canvas.current) return
    let stopped = false, render: { cancel(): void } | undefined
    void document.getPage(page).then(async value => {
      if (stopped) return
      const scale = Math.max(.1, (width - 24) / value.getViewport({ scale: 1 }).width) * zoom
      const viewport = value.getViewport({ scale }), ratio = Math.min(devicePixelRatio, 2), element = canvas.current!
      element.width = Math.ceil(viewport.width * ratio); element.height = Math.ceil(viewport.height * ratio)
      element.style.width = viewport.width + 'px'; element.style.height = viewport.height + 'px'
      const task = value.render({ canvas: element, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] })
      render = task
      await task.promise
      const content = await value.getTextContent()
      if (!stopped) { setText(content.items.map(item => 'str' in item ? item.str : '').join(' ')); onReady() }
    }).catch(error => { if (!stopped && error?.name !== 'RenderingCancelledException') setError('Не удалось отобразить страницу PDF.') })
    return () => { stopped = true; render?.cancel() }
  }, [document, page, width, zoom])
  return <div className="document-viewer pdf-viewer" ref={container}>
    <div className="viewer-toolbar"><button disabled={!document || page <= 1} onClick={() => setPage(page - 1)}>‹</button><span>Страница {page} / {document?.numPages ?? '…'}</span><button disabled={!document || page >= document.numPages} onClick={() => setPage(page + 1)}>›</button>
      <select aria-label="Масштаб PDF" value={zoom} onChange={event => setZoom(Number(event.target.value))}>{[.75, 1, 1.25, 1.5, 2].map(value => <option key={value} value={value}>{Math.round(value * 100)}%</option>)}</select></div>
    {error ? <p role="alert">{error}</p> : <div className="pdf-pages"><canvas ref={canvas}/><p className="document-sr-only pdf-page-text">{text}</p></div>}
  </div>
}
