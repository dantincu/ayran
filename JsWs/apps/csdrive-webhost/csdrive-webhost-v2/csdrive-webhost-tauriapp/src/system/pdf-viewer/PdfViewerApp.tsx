import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut } from 'lucide-react'
import { mediaUrl, type FileRef } from '../../lib/secondaryWindows'
import { getAppState, setAppState } from '../../lib/appState'

// A small, targeted polyfill — found live on the Android emulator (a real API 34 image, Android System
// WebView 113.0.5672.136): even PDF.js's own "legacy" build (chosen over the "generic" one specifically
// for older-engine compatibility — see `pdfjs/SOURCE.txt` for that first finding) still assumes
// `Promise.withResolvers`, standardized too recently for this WebView version to have it either. This is
// the standard, widely-used few-line polyfill for it (not a library), installed before `loadPdfjs` ever
// runs pdf.js's own code, which uses it internally (worker message correlation). WebView versions vary a
// lot across real Android devices in the field (Play Store updates it independently of the OS), so this
// stays in even though desktop's WebView2 has never needed it.
// Cast to a loosely-typed alias rather than `@ts-expect-error` (which TypeScript wants on the *check*
// below too, not just the assignment) — this TypeScript target doesn't know `withResolvers` yet, despite
// it being real, standard behavior in a WebView new enough to have it.
const PromiseCtor = Promise as unknown as { withResolvers?: <T>() => { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void; reject: (reason?: unknown) => void } }
if (typeof PromiseCtor.withResolvers !== 'function') {
  PromiseCtor.withResolvers = function withResolvers<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void
    let reject!: (reason?: unknown) => void
    const promise = new Promise<T>((res, rej) => {
      resolve = res
      reject = rej
    })
    return { promise, resolve, reject }
  }
}

// pdf.js's own npm package (and its types) is deliberately not a dependency — only the two prebuilt
// runtime files are vendored (`public/system/pdf-viewer/pdfjs/SOURCE.txt`), loaded at runtime with a
// plain dynamic `import()`, so its module is typed here with the small local shape this file actually
// uses rather than pulling in the whole package just for its `.d.ts`.
interface PdfPageProxy {
  getViewport(params: { scale: number }): { width: number; height: number }
  render(params: { canvasContext: CanvasRenderingContext2D; viewport: unknown; canvas: HTMLCanvasElement }): { promise: Promise<void>; cancel: () => void }
}
interface PdfDocumentProxy {
  numPages: number
  getPage(pageNumber: number): Promise<PdfPageProxy>
}
interface PdfjsModule {
  GlobalWorkerOptions: { workerSrc: string }
  getDocument(params: { url: string }): { promise: Promise<PdfDocumentProxy> }
}
let pdfjsPromise: Promise<PdfjsModule> | null = null

/** Loads pdf.js's core library exactly once per page load (not per file — reused across a tab
 * switching to a different PDF) and points its worker at the vendored copy beside it. */
function loadPdfjs(): Promise<PdfjsModule> {
  if (!pdfjsPromise) {
    // @ts-expect-error — a plain vendored file (public/system/pdf-viewer/pdfjs/), not a module TS can resolve at build time.
    pdfjsPromise = (import(/* @vite-ignore */ '/system/pdf-viewer/pdfjs/pdf.mjs') as Promise<PdfjsModule>).then((mod) => {
      // Not the real worker file directly — see `worker-wrapper.mjs`'s own comment: a worker has its own
      // separate global scope, so the polyfill above (installed in the main thread) doesn't reach code
      // running inside it, and pdf.js's own worker code needs it too.
      mod.GlobalWorkerOptions.workerSrc = '/system/pdf-viewer/pdfjs/worker-wrapper.mjs'
      return mod
    })
  }
  return pdfjsPromise
}

/** The pdf-viewer system app has one shared `app_id` (`system:pdf-viewer`) for every window — unlike an
 * ordinary web app, whose app state is already scoped to its own file by the backend — so the file itself
 * has to be folded into the key here, or two different PDFs opened at different times would overwrite each
 * other's remembered page. Deliberately not shared outside this file: nothing else needs a `FileRef`-derived
 * app-state key today. */
function pageStateKey(file: FileRef): string {
  return `pdfViewer.page.${file.storage}:${file.userId ?? ''}:${file.branch ?? ''}:${file.root ?? ''}:${file.path}`
}

/** The pdf-viewer system app's own page — see CLAUDE.md's "PDF conversion and viewing" for the whole
 * feature and why this exists as a bundled PDF.js page rather than rendering pages to images on the
 * Rust side (the person's own choice between the two). Deliberately modest next to `MediaViewer.tsx`:
 * page navigation and zoom, not that component's full set (pinch, drag-to-pan, full screen) — a real,
 * working viewer, not a reimplementation of everything `MediaViewer` already does for pictures. */
export default function PdfViewerApp({ file }: { file: FileRef | null }) {
  const [error, setError] = useState<string | null>(null)
  const [doc, setDoc] = useState<PdfDocumentProxy | null>(null)
  const [pageNum, setPageNum] = useState(1)
  const [scale, setScale] = useState(1.2)
  const [pageInput, setPageInput] = useState('')
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const renderTaskRef = useRef<{ cancel: () => void } | null>(null)
  // The document just loaded, about to set its own remembered page — the save effect below skips this one
  // restoring write, so opening a file doesn't immediately re-save the page it was just given.
  const restoringRef = useRef(false)

  // Loads the document once the file is known, then restores its own remembered page (see `pageStateKey`) —
  // clamped to the real page count, which is only known once the document itself has loaded.
  useEffect(() => {
    if (!file) return
    let cancelled = false
    setError(null)
    setDoc(null)
    Promise.all([mediaUrl(file).then((url) => loadPdfjs().then((pdfjs) => pdfjs.getDocument({ url }).promise)), getAppState<number>(pageStateKey(file)).catch(() => undefined)])
      .then(([d, saved]) => {
        if (cancelled) return
        restoringRef.current = true
        setDoc(d)
        setPageNum(saved && saved >= 1 && saved <= d.numPages ? saved : 1)
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      cancelled = true
    }
  }, [file])

  // Persists the current page whenever it changes — not the restoring write right after a document loads,
  // which would just write back the value it was itself given.
  useEffect(() => {
    if (!doc || !file) return
    if (restoringRef.current) {
      restoringRef.current = false
      return
    }
    setAppState(pageStateKey(file), pageNum).catch(() => {})
  }, [doc, file, pageNum])

  // The "go to page" box shows the current page until the person types their own; it never fights a page
  // flip made some other way (the prev/next buttons, a restored page) because it's resynced every time.
  useEffect(() => {
    setPageInput(String(pageNum))
  }, [pageNum])

  // Renders the current page whenever the document, page number or zoom changes.
  useEffect(() => {
    if (!doc || !canvasRef.current) return
    let cancelled = false
    renderTaskRef.current?.cancel()
    doc
      .getPage(pageNum)
      .then((page) => {
        if (cancelled) return
        const viewport = page.getViewport({ scale })
        const canvas = canvasRef.current!
        canvas.width = viewport.width
        canvas.height = viewport.height
        const ctx = canvas.getContext('2d')!
        const task = page.render({ canvasContext: ctx, viewport, canvas })
        renderTaskRef.current = task
        return task.promise
      })
      .catch((e) => {
        // A cancelled render throws its own (harmless) rejection — only a real error is shown.
        if (!cancelled && e?.name !== 'RenderingCancelledException') setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [doc, pageNum, scale])

  if (!file) return <div className="pdf-viewer-status muted">Loading…</div>
  if (error) return <div className="pdf-viewer-status error-banner">{error}</div>

  const pageCount = doc?.numPages ?? 0

  /** Parses the box's own text and goes there if it names a real page; otherwise snaps back to the page
   * actually shown (the `[pageNum]` effect above does the snapping, since it already resyncs the box on
   * any page change). */
  function goToTypedPage() {
    const n = Math.trunc(Number(pageInput))
    if (Number.isFinite(n) && n >= 1 && n <= pageCount) setPageNum(n)
    else setPageInput(String(pageNum))
  }

  return (
    <div className="pdf-viewer">
      <div className="pdf-viewer-toolbar toolbar-actions">
        <button type="button" className="icon-button" aria-label="Previous page" disabled={pageNum <= 1} onClick={() => setPageNum((n) => n - 1)}>
          <ChevronLeft size={18} aria-hidden="true" />
        </button>
        {doc ? (
          <span className="pdf-viewer-page-indicator">
            <input
              type="text"
              inputMode="numeric"
              className="pdf-viewer-page-input"
              aria-label="Go to page"
              value={pageInput}
              onChange={(e) => setPageInput(e.target.value)}
              onBlur={goToTypedPage}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  goToTypedPage()
                } else if (e.key === 'Escape') {
                  setPageInput(String(pageNum))
                }
              }}
            />
            <span className="muted"> / {pageCount}</span>
          </span>
        ) : (
          <span className="pdf-viewer-page-indicator muted">Loading…</span>
        )}
        <button type="button" className="icon-button" aria-label="Next page" disabled={pageNum >= pageCount} onClick={() => setPageNum((n) => n + 1)}>
          <ChevronRight size={18} aria-hidden="true" />
        </button>
        <button type="button" className="icon-button" aria-label="Zoom out" onClick={() => setScale((s) => Math.max(0.25, s - 0.2))}>
          <ZoomOut size={18} aria-hidden="true" />
        </button>
        <button type="button" className="icon-button" aria-label="Zoom in" onClick={() => setScale((s) => Math.min(4, s + 0.2))}>
          <ZoomIn size={18} aria-hidden="true" />
        </button>
      </div>
      <div className="pdf-viewer-page">
        <canvas ref={canvasRef} />
      </div>
    </div>
  )
}
