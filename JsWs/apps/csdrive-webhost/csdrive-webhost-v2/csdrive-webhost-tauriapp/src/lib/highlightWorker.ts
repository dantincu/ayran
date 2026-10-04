/// <reference lib="webworker" />
/** The background re-highlighting Worker `CodeEditor.tsx`'s `useBackgroundHighlighted` runs every keystroke's
 * *real* tokenisation in (see its own doc comment for the full story — this file is the thin Worker-side half of
 * it). `highlight()` (`lib/highlight.ts`) is a pure function of two plain values in, one plain string out — no
 * DOM, no `window`/`document` (confirmed: neither it nor `lib/highlightCode.ts`, which it builds on, touches
 * either) — so it runs completely unchanged here; nothing in this file does anything `highlight()` itself
 * doesn't already do. One message in (`{ text, language }`), one message out (the highlighted html, as a bare
 * string) — no request id needed, because `HighlightScheduler` already guarantees this Worker is never asked for
 * a second thing before it's answered the first.
 *
 * Bundled by Vite's own built-in Worker support (`new Worker(new URL('./highlightWorker.ts', import.meta.url),
 * { type: 'module' })` in `CodeEditor.tsx` — no config needed for either `npm run dev` or the production build),
 * and allowed under the app's own CSP as it already stands: `worker-src 'self' blob:` (`tauri.conf.json`) was
 * already there for the PDF viewer's own vendored PDF.js worker (see CLAUDE.md's "PDF conversion and viewing"),
 * so nothing needed to change there either. */
import { highlight, type Language } from './highlight'

self.onmessage = (e: MessageEvent<{ text: string; language: Language }>) => {
  const html = highlight(e.data.text, e.data.language)
  ;(self as unknown as Worker).postMessage(html)
}
