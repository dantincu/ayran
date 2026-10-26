import { useEffect, useState } from 'react'
import { File as FileIcon, Folder } from 'lucide-react'
import Modal from '../../components/Modal'
import IconButton from '../../components/IconButton'
import Pagination from '../../components/Pagination'
import { confirm } from '../../lib/dialogs'
import { readOsClipboardImage } from '../../lib/clipboard'
import { getAppState, setAppState } from '../../lib/appState'
import { DEFAULT_PAGE_SIZE, getGlobalPageSize, getPagePageSize, setPagePageSize, PAGE_IDS } from '../../lib/listPageSize'
import type { DirListing, FileSource } from './sources'

/** Where the explorer's own last-browsed folder is persisted, per `persistKey` (asked for directly, item 2 of
 * the todo: "the state of this explorer should be persisted along with the current page") — a plain map in
 * Notes' own app state, the same shape `notes.drafts`' own `draftKey`-keyed map already uses. */
const EXPLORER_STATE_KEY = 'notes.createImageExplorerPath'

const parentOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')
const joinPath = (folder: string, name: string) => (folder ? `${folder}/${name}` : name)

async function savedPath(persistKey: string): Promise<string | undefined> {
  const all = await getAppState<Record<string, string>>(EXPLORER_STATE_KEY).catch(() => undefined)
  return all?.[persistKey]
}

async function savePath(persistKey: string, path: string): Promise<void> {
  const all = (await getAppState<Record<string, string>>(EXPLORER_STATE_KEY).catch(() => undefined)) ?? {}
  await setAppState(EXPLORER_STATE_KEY, { ...all, [persistKey]: path }).catch(() => {})
}

/** **Create image from the clipboard** — one of the two genuinely new actions in the notebook-scoped three-dots
 * menu (`CodeEditor.tsx`'s own `notebookMenu` prop, item 2 of the todo). "we already have the functionality
 * from the file explorer" (`NotesApp.tsx`'s own `pasteClipboardImage`, which reads the OS clipboard's image and
 * writes it as a file in whatever folder is currently shown there) — this is that same read-and-write, but from
 * an *editor*, which has no "folder currently shown" of its own, so it needs its own small, paginated browser to
 * choose where the new file goes, confined to the same `source` the file being edited is already in (an image
 * referenced by a relative markdown path only makes sense within one storage, so this never offers to switch
 * accounts or roots the way `LocationPicker.tsx` does for choosing a notebook's own root). The browser's own
 * current folder is persisted per `persistKey` (the file being edited), so reopening it for the *same* file
 * later starts where it was left — reading it is a plain `getAppState` lookup, cheap enough to do on every
 * mount rather than threading a cached value through from the caller. */
export default function CreateImageFromClipboardModal({
  source,
  initialPath,
  persistKey,
  onCreated,
  onClose,
}: {
  source: FileSource
  /** Where to start browsing if nothing was persisted yet — the file's own containing folder. */
  initialPath: string
  persistKey: string
  onCreated: (path: string) => void
  onClose: () => void
}) {
  const [stage, setStage] = useState<'checking' | 'none' | 'browsing'>('checking')
  const [image, setImage] = useState<{ blob: Blob; ext: string } | null>(null)
  const [path, setPath] = useState(initialPath)
  const [listing, setListing] = useState<DirListing | null>(null)
  const [name, setName] = useState('')
  const [page, setPage] = useState(0)
  const [pageSize, setPageSizeState] = useState(DEFAULT_PAGE_SIZE)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    getPagePageSize(PAGE_IDS.notesCreateImageFromClipboard, getGlobalPageSize).then(setPageSizeState, () => {})
  }, [])

  // Reads the clipboard once, then where the browser was last left for this same file — in that order, since
  // there is nothing to browse to if the clipboard holds no image at all.
  useEffect(() => {
    let alive = true
    readOsClipboardImage().then(
      async (img) => {
        if (!alive) return
        if (!img) {
          setStage('none')
          return
        }
        setImage(img)
        setName(`clipboard-${Date.now()}.${img.ext}`)
        const last = await savedPath(persistKey).catch(() => undefined)
        if (!alive) return
        setPath(last ?? initialPath)
        setStage('browsing')
      },
      (e) => {
        if (!alive) return
        // A real bug, found live: `stage === 'checking'` renders nothing at all (`return null`), and this
        // branch used to only call `setError` — a rejected clipboard read (the ordinary case in a sandbox
        // with no real OS clipboard, and a real possibility on a genuine machine too — a denied permission,
        // a webview that refuses to read it) left the modal stuck showing a blank nothing forever, with the
        // error message set but never actually displayed. `'none'`'s own branch already shows `error` when
        // it's set (falling back to "There is no image on the clipboard." otherwise), so advancing to it is
        // the fix — not a new branch.
        setError(e instanceof Error ? e.message : String(e))
        setStage('none')
      },
    )
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (stage !== 'browsing') return
    let alive = true
    setListing(null)
    source.list(path).then(
      (result) => {
        if (!alive) return
        setListing(result)
        setPage(0)
      },
      (e) => alive && setError(e instanceof Error ? e.message : String(e)),
    )
    return () => {
      alive = false
    }
  }, [source, path, stage])

  function navigate(next: string) {
    setPath(next)
    setError(null)
    savePath(persistKey, next)
  }

  async function create() {
    const trimmed = name.trim()
    if (!trimmed || trimmed === '.' || trimmed === '..' || /[/\\]/.test(trimmed)) {
      setError('That is not a valid file name.')
      return
    }
    if (!image) return
    const collides = listing?.entries.some((e) => e.name === trimmed) ?? false
    if (collides && !(await confirm(`"${trimmed}" already exists here. Replace it?`))) return
    setSaving(true)
    setError(null)
    try {
      const target = joinPath(path, trimmed)
      const file = new File([image.blob], trimmed, { type: image.blob.type })
      if (source.writeFromFile) await source.writeFromFile(target, file)
      else await source.write(target, new Uint8Array(await file.arrayBuffer()))
      onCreated(target)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  if (stage === 'checking') return null

  if (stage === 'none') {
    return (
      <Modal title="Create image from the clipboard" onClose={onClose}>
        {error ? <div className="error-banner">{error}</div> : <p className="muted">There is no image on the clipboard.</p>}
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </Modal>
    )
  }

  const segments = path ? path.split('/') : []
  const pageCount = Math.max(1, Math.ceil((listing?.entries.length ?? 0) / pageSize))
  const currentPage = Math.min(page, pageCount - 1)
  const shown = listing?.entries.slice(currentPage * pageSize, (currentPage + 1) * pageSize) ?? null
  const trimmedName = name.trim()
  const collides = trimmedName !== '' && (listing?.entries.some((e) => e.name === trimmedName) ?? false)

  return (
    <Modal title="Create image from the clipboard" onClose={onClose} wide>
      {error && <div className="error-banner">{error}</div>}
      <div className="breadcrumbs">
        <button type="button" className="link-button" onClick={() => navigate('')}>
          /
        </button>
        {segments.map((segment, i) => (
          <span key={i}>
            <span className="crumb-sep">/</span>
            <button type="button" className="link-button" onClick={() => navigate(segments.slice(0, i + 1).join('/'))}>
              {segment}
            </button>
          </span>
        ))}
      </div>
      <ul className="picker-list">
        {listing === null && <li className="muted">Loading…</li>}
        {listing?.entries.length === 0 && <li className="muted">This folder is empty.</li>}
        {shown?.map((entry) => (
          <li key={entry.name}>
            {entry.isDirectory ? (
              <button type="button" className="link-button entry-name" onClick={() => navigate(joinPath(path, entry.name))}>
                <Folder size={15} strokeWidth={2} aria-hidden="true" /> {entry.name}
              </button>
            ) : (
              <span className="entry-name muted">
                <FileIcon size={15} strokeWidth={2} aria-hidden="true" /> {entry.name}
              </span>
            )}
          </li>
        ))}
      </ul>
      <Pagination
        page={currentPage}
        pageSize={pageSize}
        totalItems={listing?.entries.length ?? 0}
        onPageChange={setPage}
        onPageSizeChange={(size) => {
          setPageSizeState(size)
          setPagePageSize(PAGE_IDS.notesCreateImageFromClipboard, size).catch(() => {})
        }}
      />
      <form
        onSubmit={(e) => {
          e.preventDefault()
          create()
        }}
      >
        <label className="notes-field notes-field-leading">
          <span>Save the image here as</span>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} aria-label="File name" />
        </label>
        {collides && <p className="error-banner">A file or folder named "{trimmedName}" already exists here.</p>}
        <div className="dialog-actions">
          <IconButton icon={Folder} label="Up a folder" onClick={() => navigate(parentOf(path))} disabled={!path} />
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!trimmedName || saving}>
            {saving ? 'Creating…' : 'Create'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
