import { useEffect, useRef, useState } from 'react'
import { BookOpen, File as FileIcon, Files, Folder, Paperclip } from 'lucide-react'
import Modal from '../../components/Modal'
import IconButton from '../../components/IconButton'
import FileExplorerModal, { joinPath } from '../../components/FileExplorerModal'
import { NOTE_FILES_INDEX, findMarkdown, readChildren, type NoteRef } from './noteModel'
import { loadNotebooks, type NotebookEntry } from './notebooks'
import type { FileSource } from './sources'

interface Props {
  source: FileSource
  /** Notebooks are listed only within this source — a link can't lead out of the storage its page is in anyway
   * (see CLAUDE.md's "Links between pages of web apps"), so a notebook of a different account or folder is never
   * a meaningful pick here. */
  sourceId: string
  /** Where the generic "Files" browse starts (the file being edited's own folder). */
  initialPath: string
  onPick: (path: string) => void
  onClose: () => void
}

type Browse = { view: 'notebooks' } | { view: 'notes'; folder: string; title: string }

/** Notes' own "Insert a path…" browser: the generic file explorer (`FileExplorerModal`) for "directly all files
 * from the storage root", plus a second, notes-aware way in — notebooks → a note → (its own child notes, or its
 * files) — for picking a *different note* without first knowing its folder's raw name. Switching between the two
 * is a plain button, not a fixed tab bar, so it reads as "here's another way in" rather than two permanently
 * separate halves. */
export default function InsertPathModal({ source, sourceId, initialPath, onPick, onClose }: Props) {
  const [mode, setMode] = useState<'files' | 'notes'>('files')
  const [browse, setBrowse] = useState<Browse>({ view: 'notebooks' })
  const [notebooks, setNotebooks] = useState<NotebookEntry[] | null>(null)
  const [notes, setNotes] = useState<NoteRef[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Where the generic explorer starts when switched to from here — its own path (initialPath, or a note's own
  // files folder when "Its files…" opened it) — kept in a ref (not state) plus a key that bumps to force a fresh
  // mount of FileExplorerModal, which otherwise keeps browsing from wherever it was left.
  const filesStart = useRef(initialPath)
  const [filesKey, setFilesKey] = useState(0)

  useEffect(() => {
    if (mode !== 'notes' || browse.view !== 'notebooks') return
    let alive = true
    loadNotebooks().then(
      (all) => alive && setNotebooks(all.filter((n) => n.sourceId === sourceId)),
      (e) => alive && setError(String(e)),
    )
    return () => {
      alive = false
    }
  }, [mode, browse, sourceId])

  useEffect(() => {
    if (mode !== 'notes' || browse.view !== 'notes') return
    let alive = true
    setNotes(null)
    readChildren(source, browse.folder).then(
      (r) => alive && setNotes(r.notes),
      (e) => alive && setError(String(e)),
    )
    return () => {
      alive = false
    }
  }, [mode, browse, source])

  /** The note's own markdown, found (not guessed) — a title alone doesn't say the exact file name (it's sanitized
   * from the title, `namePartFromTitle`, which `findMarkdown` already knows how to read past). */
  async function pickNote(note: NoteRef) {
    try {
      const markdown = await findMarkdown(source, note.folder)
      if (!markdown) throw new Error(`"${note.title}" has no markdown file.`)
      onPick(markdown)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  /** Its own files (`01`), if it has that folder: switches to the generic explorer there. A note that has none
   * yet says so, rather than opening an explorer on a folder that doesn't exist. */
  async function openNoteFiles(note: NoteRef) {
    const files = joinPath(note.folder, NOTE_FILES_INDEX)
    try {
      await source.list(files)
      filesStart.current = files
      setFilesKey((k) => k + 1)
      setMode('files')
    } catch {
      setError(`"${note.title}" has no files of its own yet.`)
    }
  }

  if (mode === 'files') {
    return (
      <FileExplorerModal
        key={filesKey}
        title="Insert a path…"
        list={(p) => source.list(p).then((r) => r.entries)}
        initialPath={filesStart.current}
        onPick={onPick}
        onClose={onClose}
        actions={<IconButton icon={BookOpen} label="Browse notes instead…" onClick={() => setMode('notes')} />}
      />
    )
  }

  return (
    <Modal
      title="Insert a path…"
      actions={<IconButton icon={Files} label="Browse files instead…" onClick={() => setMode('files')} />}
      onClose={onClose}
    >
      {browse.view === 'notes' && (
        <div className="breadcrumbs">
          <button className="link-button" onClick={() => setBrowse({ view: 'notebooks' })}>
            Notebooks
          </button>
          <span className="crumb-sep">/</span>
          <strong>{browse.title}</strong>
        </div>
      )}
      {error && <div className="error-banner">{error}</div>}
      {browse.view === 'notebooks' && (
        <ul className="picker-list">
          {notebooks === null && !error && <li className="muted">Loading…</li>}
          {notebooks?.length === 0 && <li className="muted">No notebooks are listed for this source.</li>}
          {notebooks?.map((n) => (
            <li key={n.guid}>
              <button className="link-button entry-name" onClick={() => setBrowse({ view: 'notes', folder: n.folder, title: n.title })}>
                <Folder size={15} strokeWidth={2} aria-hidden="true" /> {n.title}
              </button>
            </li>
          ))}
        </ul>
      )}
      {browse.view === 'notes' && (
        <ul className="picker-list">
          {notes === null && !error && <li className="muted">Loading…</li>}
          {notes?.length === 0 && <li className="muted">No notes here.</li>}
          {notes?.map((note) => (
            <li key={note.folder} className="window-item">
              <button className="link-button entry-name" onClick={() => setBrowse({ view: 'notes', folder: note.folder, title: note.title })}>
                <Folder size={15} strokeWidth={2} aria-hidden="true" /> {note.title}
              </button>
              <span className="row-actions">
                <IconButton icon={FileIcon} label="Pick this note" onClick={() => pickNote(note)} />
                <IconButton icon={Paperclip} label="Its files…" onClick={() => openNoteFiles(note)} />
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="dialog-actions">
        <button type="button" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Modal>
  )
}
