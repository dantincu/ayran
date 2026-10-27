import { useEffect, useState } from 'react'
import { File as FileIcon, Folder } from 'lucide-react'
import Modal from '../../components/Modal'
import IconButton from '../../components/IconButton'
import Pagination from '../../components/Pagination'
import { confirm } from '../../lib/dialogs'
import { readOsClipboardImage } from '../../lib/clipboard'
import { getAppState, setAppState } from '../../lib/appState'
import { kbdItem, useModalListKeyboard } from '../../lib/keyboard'
import { DEFAULT_PAGE_SIZE, getGlobalPageSize, getPagePageSize, setPagePageSize, PAGE_IDS } from '../../lib/listPageSize'
import { offsetOfPage, pageOfOffset, validOffset } from '../../lib/pagedPosition'
import type { DirListing, FileSource } from './sources'

/** Where the explorer's own last-browsed folder, and its own page — as the number of records skipped, never
 * a bare page number, `pagedPosition.ts` — is persisted, per `persistKey` (asked for directly, item 2 of the
 * todo: "the state of this explorer should be persisted along with the current page" — the todo's own later
 * follow-up noting this modal specifically never did the second half of that). A plain map in Notes' own app
 * state, the same shape `notes.drafts`' own `draftKey`-keyed map already uses. **A value saved before the
 * offset existed is a bare string** (the path alone) — read back as `{ path: that string, offset: 0 }`,
 * never a reason to lose the remembered folder over. */
const EXPLORER_STATE_KEY = 'notes.createImageExplorerPath'

interface ExplorerState {
  path: string
  offset: number
}

const parentOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')
const joinPath = (folder: string, name: string) => (folder ? `${folder}/${name}` : name)

async function savedState(persistKey: string): Promise<ExplorerState | undefined> {
  const all = await getAppState<Record<string, string | ExplorerState>>(EXPLORER_STATE_KEY).catch(() => undefined)
  const saved = all?.[persistKey]
  if (saved === undefined) return undefined
  return typeof saved === 'string' ? { path: saved, offset: 0 } : saved
}

async function saveState(persistKey: string, state: ExplorerState): Promise<void> {
  const all = (await getAppState<Record<string, string | ExplorerState>>(EXPLORER_STATE_KEY).catch(() => undefined)) ?? {}
  await setAppState(EXPLORER_STATE_KEY, { ...all, [persistKey]: state }).catch(() => {})
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
  // The listing's own position, as the number of records skipped — never a bare page number (`pagedPosition.ts`).
  const [offset, setOffset] = useState(0)
  const [pageSize, setPageSizeState] = useState(DEFAULT_PAGE_SIZE)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  // The keyboard's own focus — a global index into `listing.entries`; navigable the instant the modal opens,
  // the keys heard on the whole window (`useModalListKeyboard`), item 1 of the todo.
  const [kbdFocus, setKbdFocus] = useState(-1)

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
        const last = await savedState(persistKey).catch(() => undefined)
        if (!alive) return
        setPath(last?.path ?? initialPath)
        setOffset(validOffset(last?.offset) ?? 0)
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
      (result) => alive && setListing(result),
      (e) => alive && setError(e instanceof Error ? e.message : String(e)),
    )
    return () => {
      alive = false
    }
  }, [source, path, stage])

  // The one place a *genuine* navigation happens (clicking a folder, Up, or the keyboard's own Left/Right) —
  // resets the position and the keyboard focus right here, at the point of the change, rather than a
  // reactive effect keyed on `path`: that would also fire, and so reset the just-restored offset back to 0,
  // the moment the clipboard-read effect above sets `path` to what was saved. Persisting is a separate,
  // reactive effect below — saving back exactly what was just restored, the one time it runs before any real
  // navigation, is harmless, unlike resetting it would be.
  function navigate(next: string) {
    setPath(next)
    setOffset(0)
    setKbdFocus(-1)
    setError(null)
  }

  useEffect(() => {
    if (stage === 'browsing') saveState(persistKey, { path, offset })
  }, [path, offset, stage, persistKey])

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

  const pageCount = Math.max(1, Math.ceil((listing?.entries.length ?? 0) / pageSize))
  const currentPage = Math.min(pageOfOffset(offset, pageSize), pageCount - 1)
  const shown = listing?.entries.slice(currentPage * pageSize, (currentPage + 1) * pageSize) ?? null

  // The page shown follows the keyboard focus (`FilesTab.tsx`'s identical pattern) — `useModalListKeyboard`
  // below only ever moves `kbdFocus` itself (a global index), never which page is displayed; that stays this
  // component's own job.
  useEffect(() => {
    if (kbdFocus >= 0) setOffset(Math.floor(kbdFocus / pageSize) * pageSize)
  }, [kbdFocus, pageSize])

  // Navigable with the keyboard the instant the modal opens (item 1 of the todo): the same Up/Down/Home/End/
  // Page Up/Page Down/fast-nav as every other keyboard-navigable list, Left up a folder, Right (or Enter,
  // which falls back to `onOpen`) into the focused folder — a focused *file* has no "open"/"apply" of its
  // own here (unlike "Insert custom text", this modal doesn't let a listed file be picked; the save target
  // comes from the name box below), so `onOpen` simply does nothing for one, same as every other local-fs
  // folder browser in this app already does. No search box in this modal, so no Ctrl+S/Ctrl+Enter to wire.
  // Called unconditionally, before the early returns below, with a safe fallback while nothing's loaded yet.
  useModalListKeyboard({
    count: listing?.entries.length ?? 0,
    focused: kbdFocus,
    setFocused: setKbdFocus,
    pageSize,
    page: currentPage,
    enabled: stage === 'browsing' && !saving,
    onParent: path ? () => navigate(parentOf(path)) : undefined,
    onOpen: (i) => {
      const entry = listing?.entries[i]
      if (entry?.isDirectory) navigate(joinPath(path, entry.name))
    },
  })

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
        {shown?.map((entry, i) => (
          <li key={entry.name} {...kbdItem(kbdFocus, currentPage * pageSize + i, setKbdFocus)}>
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
        onPageChange={(p) => setOffset(offsetOfPage(p, pageSize))}
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
