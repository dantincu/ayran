import { useState } from 'react'
import { FileCode, X } from 'lucide-react'
import IconButton from './IconButton'
import Modal from './Modal'
import { invoke } from '@tauri-apps/api/core'

/** **Convert to HTML…** on a `.pdf` file (the Files tab): a heuristic conversion — see CLAUDE.md's "PDF
 * conversion and viewing" for what it can and can't do — with the feature's own two options: one
 * combined html file, or one per page; and whether to embed the page's own images (bigger files, skip
 * it for a text-only conversion). Retries once with `overwrite: true` on an "already exists" refusal,
 * after asking. */
export default function PdfConvertModal({
  rootId,
  path,
  name,
  onDone,
  onClose,
}: {
  rootId: string
  path: string
  name: string
  onDone: (filesWritten: string[]) => void
  onClose: () => void
}) {
  const [perPage, setPerPage] = useState(false)
  const [embedImages, setEmbedImages] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function convert(overwrite = false) {
    setBusy(true)
    setError(null)
    try {
      const result = await invoke<{ filesWritten: string[] }>('pdf_convert_to_html', {
        root: rootId,
        path,
        perPage,
        embedImages,
        overwrite,
      })
      onDone(result.filesWritten)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      // `window.confirm` is replaced by the app's own dialog plugin here — an *async* function
      // returning a Promise (`plugin:dialog|confirm`), not the native synchronous one, so this must be
      // awaited: an un-awaited call is always truthy (a Promise object), which would overwrite on every
      // conflict regardless of what the person actually chose — found live, checking `window.confirm`'s
      // own source in the running admin window.
      if (!overwrite && message.includes('already exists') && (await window.confirm(`${message}\n\nOverwrite?`))) {
        await convert(true)
        return
      }
      setError(message)
      setBusy(false)
    }
  }

  return (
    <Modal title={`Convert "${name}" to html`} onClose={onClose}>
      <div className="pair-modal">
        <label className="pair-check">
          <input type="checkbox" checked={perPage} onChange={(e) => setPerPage(e.target.checked)} /> One html file per page (in a new folder named after the PDF), instead of one combined file
        </label>
        <label className="pair-check">
          <input type="checkbox" checked={embedImages} onChange={(e) => setEmbedImages(e.target.checked)} /> Embed the pages' own images
        </label>
        <p className="muted">
          A heuristic conversion — paragraphs, headings and bold/italic text are detected from the PDF's own layout, not reproduced
          pixel for pixel. A two-column page or a table may not read in the right order.
        </p>
        {error && <div className="error-banner">{error}</div>}
        <div className="toolbar-actions" style={{ justifyContent: 'flex-end' }}>
          <IconButton icon={FileCode} label="Convert" onClick={() => convert()} disabled={busy} />
          <IconButton icon={X} label="Cancel" onClick={onClose} />
        </div>
      </div>
    </Modal>
  )
}
