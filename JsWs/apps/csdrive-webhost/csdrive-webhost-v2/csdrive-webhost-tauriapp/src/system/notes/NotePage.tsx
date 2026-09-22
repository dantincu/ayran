import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AppWindow,
  AppWindowMac,
  CheckSquare,
  ChevronRight,
  CircleSlash,
  ClipboardPaste,
  Copy,
  Eye,
  FilePenLine,
  FileText,
  FolderOpen,
  FolderTree,
  Hash,
  House,
  ListOrdered,
  MoreHorizontal,
  Navigation,
  Paperclip,
  Pause,
  Pencil,
  Plus,
  RefreshCw,
  Scissors,
  Search,
  Square,
  Trash2,
  X,
} from 'lucide-react'
import ContextMenu, { contextTrigger, type MenuItem } from '../../components/ContextMenu'
import GoToPathModal from '../../components/GoToPathModal'
import IconButton from '../../components/IconButton'
import RowActions from '../../components/RowActions'
import { kbdItem, useListKeyboard } from '../../lib/keyboard'
import { pathForInput } from '../../lib/pathInput'
import { noteTabAction, noteTabState, openNoteTab, type SyncingTab } from '../../lib/secondaryWindows'
import { isNoteQuery } from '../../lib/textLinks'
import DeleteNotesModal from './DeleteNotesModal'
import IndexesModal from './IndexesModal'
import { setNoteClipboard, useNoteClipboard } from './noteClipboard'
import { indexText, parseIndex } from './noteIndexes'
import { loadNotebooks, type NotebookEntry } from './notebooks'
import { ancestorsOf, changeNoteIndex, createNote, deleteNote, findMarkdown, normalizeChildren, parentOf, readChildren, readNote, renameNote, type NoteRef } from './noteModel'
import PasteNotesModal from './PasteNotesModal'
import SearchPanel from './SearchPanel'
import { NoteSearchResults } from './SearchResults'
import CacheMenu from './CacheMenu'
import { DEFAULT_SORT, isSorted, sortNotes, type SearchCriteria, type SortSpec } from './search'
import { DEFAULT_PAGE_SIZE, getGlobalPageSize } from '../../lib/listPageSize'
import { useNotesSettings } from './settings'
import { reportNotePlace, type Place, type Tab } from './tabs'
import { useNotesSources } from './useSources'
import UserActionButton from './UserActionButton'

// A non-breaking space, never an empty string: a block element with truly no content collapses to zero height
// (no line box at all), so a note with no date next to siblings that have one would sit in a visibly shorter
// row — found live, from real data, right after the CreatedAt-backfill fix shipped (some notes have no
// CreatedAt anywhere to backfill from, `[note].json` included, and that's a legitimate, permanent state, not
// something to keep trying to repair). The blank second line keeps every row the same height either way.
const formatWhen = (stamp: string) => {
  const date = new Date(stamp)
  return Number.isNaN(date.getTime()) ? ' ' : date.toLocaleString()
}

/** The menu of a note: where it opens, and what the tab that follows the note's editor is doing (if there is one). */
interface OpenMenu {
  note: NoteRef
  x: number
  y: number
  markdown: string | null
  syncing: SyncingTab | null
}

/** A title or an index being edited in the list itself. */
interface Editing {
  kind: 'title' | 'index'
  /** The note's index as the list has it now (what names the note). */
  key: string
  value: string
}

/** The page of the notes in a notebook's root folder or in a note's folder — "the children" of one or the other: what to do with
 * each (open it as a web app, edit its markdown, see its children, see its files, show it in the File Manager, rename, delete),
 * a new note, and — under a note — the same for the note itself. It is one page for both: a notebook is the note tree's root.
 *
 * **Clicking a note opens it as a web app in a tab of this window** — the tab that follows the note's editor: a second click brings
 * it back. Each row's *more* button (and a right click, or a long press) opens a menu: the note's index, selecting it, cutting and
 * copying it, a tab that does not follow the editor, and showing, suspending or closing the one that does.
 *
 * **Renaming as in Total Commander**: F2 (or the pencil) turns the title into a box, and the Up and Down arrows submit it *and* go
 * on to the note before / after; Shift+F2 (or a press on the index) does the same for the index. **The indexes of all the notes**
 * are edited together in a dialog of their own (`IndexesModal`): typing, reordering, normalizing, converting. */
export default function NotePage({
  tab,
  sourceId,
  folder,
  onPlace,
  onHome,
}: {
  tab: Tab | null
  sourceId: string
  folder: string
  onPlace: (place: Place) => void
  onHome: () => void
}) {
  const { ready, sourceOf } = useNotesSources()
  const source = useMemo(() => sourceOf(sourceId), [sourceOf, sourceId])
  const { settings } = useNotesSettings()
  const clipboard = useNoteClipboard()
  const [notebook, setNotebook] = useState<NotebookEntry | null>(null)
  const [note, setNote] = useState<NoteRef | null>(null)
  const [trail, setTrail] = useState<NoteRef[]>([])
  const [children, setChildren] = useState<NoteRef[]>([])
  const [repaired, setRepaired] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  /** What the cache options say when they are done. */
  const [notice, setNotice] = useState<string | null>(null)
  const [goingTo, setGoingTo] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [menu, setMenu] = useState<OpenMenu | null>(null)
  const [kbdFocus, setKbdFocus] = useState(-1)
  const [editing, setEditing] = useState<Editing | null>(null)
  /** What is being edited *now* (`title:999`) — the handlers that can fire twice for one edit (a step with the arrows, then the blur) read it. */
  const editingRef = useRef<string | null>(null)
  const [indexing, setIndexing] = useState(false)
  const [deleting, setDeleting] = useState<NoteRef[] | null>(null)
  const [pasting, setPasting] = useState(false)
  /** The search and sort panel, how the list is sorted, and what is searched for while results show. */
  const [searchOpen, setSearchOpen] = useState(false)
  const [sort, setSort] = useState<SortSpec>(DEFAULT_SORT)
  const [criteria, setCriteria] = useState<SearchCriteria | null>(null)
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE)
  useEffect(() => {
    getGlobalPageSize().then(setPageSize).catch(() => {})
  }, [])
  useEffect(() => {
    setCriteria(null) // the results belong to the notes that were searched
  }, [sourceId, folder])

  const load = useCallback(async () => {
    if (!source) return
    setLoading(true)
    setError(null)
    try {
      const listed = await loadNotebooks()
      // The notebook this folder belongs to: the listed one whose root is this folder or the closest above it.
      const inside = listed
        .filter((n) => n.sourceId === sourceId && (folder === n.folder || n.folder === '' || folder.startsWith(`${n.folder}/`)))
        .sort((a, b) => b.folder.length - a.folder.length)[0]
      const root = inside?.folder ?? folder
      setNotebook(inside ?? null)
      const here = folder === root ? null : await readNote(source, folder)
      setNote(here)
      setTrail(here ? await ancestorsOf(source, folder, root) : [])
      const kids = await readChildren(source, folder)
      setChildren(kids.notes)
      setRepaired(kids.repaired)
      setSelected((current) => new Set([...current].filter((index) => kids.notes.some((n) => n.index === index))))
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [source, sourceId, folder])

  useEffect(() => {
    if (ready) load()
  }, [ready, load])

  /** The notes as shown — in the order of their indexes, or sorted. While they are sorted or searched, nothing that reorders, renumbers or
   * converts indexes is offered: what is in view is not in the order those operations act on. */
  const list = useMemo(() => (isSorted(sort) ? sortNotes(children, sort) : children), [children, sort])
  const indexOps = criteria === null && !isSorted(sort)

  const title = note?.title ?? notebook?.title ?? 'Notes'
  useEffect(() => {
    if (tab && !loading) reportNotePlace(tab, { view: 'notes', sourceId, folder }, title)
  }, [tab, loading, sourceId, folder, title])

  const root = notebook?.folder ?? folder

  async function attempt(action: () => Promise<void>) {
    setError(null)
    try {
      await action()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  /** A note's markdown as the backend names it. */
  async function markdownOf(n: { folder: string }) {
    if (!source?.fileRef) throw new Error("This kind of place can't open a note as a web app.")
    const markdown = await findMarkdown(source, n.folder)
    if (!markdown) throw new Error('This note has no markdown file.')
    return { markdown, file: source.fileRef(markdown) }
  }

  /** The default action for a note: its markdown as a web app in a tab of this window — the tab that follows the editor. */
  const openNote = (n: { folder: string }) =>
    attempt(async () => {
      const { file } = await markdownOf(n)
      await openNoteTab(file, true)
    })

  /** A tab of its own (it does not follow the editor). */
  const openNoteSeparately = (n: { folder: string }) =>
    attempt(async () => {
      const { file } = await markdownOf(n)
      await openNoteTab(file, false)
    })

  const edit = (n: { folder: string }) => onPlace({ view: 'noteEdit', sourceId, folder: n.folder })
  const showChildren = (n: { folder: string }) => onPlace({ view: 'notes', sourceId, folder: n.folder })
  const showFiles = (n: { folder: string }) => onPlace({ view: 'noteFiles', sourceId, folder: n.folder, path: '' })
  const showInFileManager = (path: string) => onPlace({ view: 'files', location: { sourceId, branch: null, path } })

  async function addNote() {
    const title = window.prompt("The new note's title:")?.trim()
    if (!title || !source) return
    await attempt(async () => {
      const created = await createNote(source, folder, title)
      edit(created)
    })
  }

  // ── Editing a title or an index in the list, as in Total Commander ──

  function startEdit(kind: Editing['kind'], n: NoteRef) {
    if (kind === 'index' && !indexOps) return
    editingRef.current = `${kind}:${n.index}`
    setEditing({ kind, key: n.index, value: kind === 'title' ? n.title : n.index })
  }

  function cancelEdit() {
    editingRef.current = null
    setEditing(null)
  }

  /** Submits what is being edited. `step` is how it ended: Enter, or a press elsewhere (0); or the Down / Up arrow (1 / -1), which
   * submits *and* goes on to edit the same thing of the note after / before it. */
  async function commitEdit(step: -1 | 0 | 1 = 0) {
    const current = editing
    if (!current || editingRef.current !== `${current.kind}:${current.key}` || !source) return // already submitted: the box that closes fires its blur too
    editingRef.current = null
    setEditing(null)
    const at = list.findIndex((n) => n.index === current.key)
    const target = step !== 0 && at >= 0 ? list[at + step] : undefined
    const n = list[at]
    let failed: string | null = null
    if (n) {
      try {
        if (current.kind === 'title') {
          const next = current.value.trim()
          if (next && next !== n.title) await renameNote(source, n, next)
        } else {
          const index = parseIndex(current.value)
          if (index === null) throw new Error('An index is a number from 1 to 999.')
          if (indexText(index) !== n.index) await changeNoteIndex(source, n, indexText(index))
        }
      } catch (e) {
        failed = e instanceof Error ? e.message : String(e)
      }
      await load()
      if (failed) setError(failed) // (after the list was read again, which clears the message of the last action)
    }
    if (target && failed === null) {
      setKbdFocus(at + step)
      startEdit(current.kind, target)
    }
  }

  const editBox = (n: NoteRef, kind: Editing['kind']) => (
    <input
      autoFocus
      data-ua-field={kind === 'index' ? 'notes.notes.renameIndex' : 'notes.notes.renameTitle'}
      className={kind === 'index' ? 'note-index-input' : 'note-title-input'}
      value={editing?.value ?? ''}
      inputMode={kind === 'index' ? 'numeric' : undefined}
      aria-label={kind === 'index' ? `The index of "${n.title}"` : `The title of "${n.title}"`}
      onChange={(e) => setEditing((current) => (current ? { ...current, value: e.target.value } : current))}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={() => commitEdit(0)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commitEdit(0)
        else if (e.key === 'Escape') cancelEdit()
        // Up and Down submit and go on to the note before / after (Total Commander).
        else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault()
          commitEdit(e.key === 'ArrowDown' ? 1 : -1)
        }
      }}
    />
  )

  // ── Deleting, cutting, copying, pasting ──

  async function removeNotes(doomed: NoteRef[], normalize: boolean) {
    if (!source) return
    setDeleting(null)
    await attempt(async () => {
      for (const n of doomed) await deleteNote(source, n)
      if (normalize) await normalizeChildren(source, folder)
      setSelected(new Set())
      await load()
    })
  }

  const toggleSelected = (n: NoteRef) =>
    setSelected((current) => {
      const next = new Set(current)
      if (!next.delete(n.index)) next.add(n.index)
      return next
    })

  /** The notes a cut or copy means: the selected ones, else just `n`. */
  const aim = (n: NoteRef) => (selected.has(n.index) ? children.filter((c) => selected.has(c.index)) : [n])

  function clip(notes: NoteRef[], mode: 'copy' | 'cut') {
    if (!source || notes.length === 0) return
    setNoteClipboard({ source, notes, mode })
    setSelected(new Set())
  }

  /** Opens the menu of a note at (x, y): first asking what its syncing tab is doing, so the menu says what can be done. */
  async function openMenu(n: NoteRef, x: number, y: number) {
    let markdown: string | null = null
    let syncing: SyncingTab | null = null
    try {
      if (source?.fileRef) {
        markdown = await findMarkdown(source, n.folder)
        if (markdown) syncing = await noteTabState(source.fileRef(markdown))
      }
    } catch {
      // the menu is still useful without it
    }
    setMenu({ note: n, x, y, markdown, syncing })
  }

  function menuItems(m: OpenMenu): MenuItem[] {
    const file = m.markdown && source?.fileRef ? source.fileRef(m.markdown) : null
    const act = (action: 'show' | 'suspend' | 'close') => attempt(async () => {
      if (file) await noteTabAction(file, action)
    })
    return [
      { label: 'Rename (F2)', icon: Pencil, onSelect: () => startEdit('title', m.note) },
      { label: 'Edit the index (Shift+F2)', icon: Hash, onSelect: () => startEdit('index', m.note), disabled: !indexOps },
      { label: selected.has(m.note.index) ? 'Deselect' : 'Select', icon: selected.has(m.note.index) ? Square : CheckSquare, onSelect: () => toggleSelected(m.note) },
      { label: 'Cut', icon: Scissors, onSelect: () => clip(aim(m.note), 'cut'), separated: true },
      { label: 'Copy', icon: Copy, onSelect: () => clip(aim(m.note), 'copy') },
      {
        label: 'Open as a web app in a new tab (does not follow the editor)',
        icon: AppWindowMac,
        onSelect: () => openNoteSeparately(m.note),
        disabled: !m.markdown,
        separated: true,
      },
      { label: 'Show the tab that follows the editor', icon: Eye, onSelect: () => act('show'), disabled: !m.syncing || m.syncing.showing, separated: true },
      { label: 'Suspend that tab', icon: Pause, onSelect: () => act('suspend'), disabled: !m.syncing },
      { label: 'Close that tab', icon: CircleSlash, onSelect: () => act('close'), disabled: !m.syncing },
    ]
  }

  /** "Go to a path" on a notes page: a note's address (`?note`) opens that note; the path of a note's folder shows its children;
   * anything else is shown in the File Manager. */
  async function goToPath(segments: string[], query: string | null): Promise<string | null> {
    if (!source) return 'Nothing is open.'
    const path = segments.join('/')
    if (path === '') {
      onPlace({ view: 'notes', sourceId, folder: root })
      return null
    }
    const found = await readNote(source, path)
    if (isNoteQuery(query)) {
      if (!found) return `There is no note at ${pathForInput(path)}.`
      await openNote(found)
      return null
    }
    if (found) showChildren(found)
    else showInFileManager(path)
    return null
  }

  // ── Keyboard ──

  const goUp = () => {
    if (!note) return onPlace({ view: 'notebooks' })
    const above = trail.length >= 2 ? trail[trail.length - 2].folder : root
    onPlace({ view: 'notes', sourceId, folder: above === folder ? parentOf(folder) : above })
  }

  useListKeyboard({
    count: list.length,
    focused: kbdFocus,
    setFocused: setKbdFocus,
    onOpen: (i) => list[i] && showChildren(list[i]),
    onActivate: (i) => list[i] && openNote(list[i]),
    onParent: goUp,
    enabled: editing === null && menu === null && !goingTo && criteria === null,
  })

  // F2 renames the focused note, Shift+F2 edits its index (Total Commander's key).
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'F2' || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
      if (document.querySelector('.modal-overlay, .editor-overlay, .media-viewer')) return
      const n = list[kbdFocus]
      if (!n || criteria !== null) return
      e.preventDefault()
      startEdit(e.shiftKey ? 'index' : 'title', n)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, kbdFocus, indexOps, criteria])

  if (!ready) return null
  if (!source) {
    return (
      <div className="app-shell">
        <main className="tab-content">
          <div className="tab-panel notes-page">
            <div className="error-banner">This notebook's place isn't available (a folder that isn't on the list of folders, or a Filen account that isn't connected).</div>
            <IconButton icon={House} label="Notes home" onClick={onHome} />
          </div>
        </main>
      </div>
    )
  }

  const selecting = selected.size > 0
  const chosen = children.filter((n) => selected.has(n.index))

  return (
    <div className="app-shell">
      <main className="tab-content">
        <div className="tab-panel notes-page">
          <nav className="note-crumbs" aria-label="Where this is">
            <IconButton icon={House} label="Notes home" onClick={onHome} />
            <button className="link-button" onClick={() => onPlace({ view: 'notebooks' })}>
              Notebooks
            </button>
            {notebook && (
              <>
                <ChevronRight size={14} aria-hidden="true" />
                <button className="link-button" onClick={() => onPlace({ view: 'notes', sourceId, folder: root })} disabled={folder === root}>
                  {notebook.title}
                </button>
              </>
            )}
            {trail.map((n) => (
              <span key={n.folder} className="note-crumb">
                <ChevronRight size={14} aria-hidden="true" />
                <button className="link-button" onClick={() => showChildren(n)} disabled={n.folder === folder}>
                  {n.title}
                </button>
              </span>
            ))}
          </nav>

          <div className="notes-page-header">
            <h2>{title}</h2>
            <IconButton icon={Plus} label={note ? 'New child note…' : 'New note…'} onClick={addNote} />
            <IconButton
              icon={ListOrdered}
              label={indexOps ? 'The indexes of these notes — edit, reorder, normalize, convert…' : 'The indexes can be changed only while the notes are in the order of their indexes — clear the search and the sorting'}
              onClick={() => setIndexing(true)}
              disabled={children.length === 0 || !indexOps}
            />
            <IconButton icon={Search} label="Search and sort…" onClick={() => setSearchOpen((open) => !open)} />
            {clipboard && (
              <IconButton
                icon={ClipboardPaste}
                label={`${clipboard.mode === 'cut' ? 'Move' : 'Copy'} ${clipboard.notes.length === 1 ? `"${clipboard.notes[0].title}"` : `${clipboard.notes.length} notes`} here…`}
                onClick={() => setPasting(true)}
              />
            )}
            <IconButton icon={Navigation} label="Go to a path or a note's address…" onClick={() => setGoingTo(true)} />
            <IconButton icon={RefreshCw} label="Refresh" onClick={load} />
            <UserActionButton sourceId={sourceId} folder={folder} />
          </div>

          {note && (
            <div className="notes-panel-row note-self">
              <span className="muted">This note:</span>
              <IconButton icon={AppWindow} label="Open it as a web app (in a tab of this window)" onClick={() => openNote(note)} />
              <IconButton icon={FilePenLine} label="Edit its markdown" onClick={() => edit(note)} />
              <IconButton icon={Paperclip} label="Its files" onClick={() => showFiles(note)} />
              <IconButton icon={FolderOpen} label="Show its folder in the File Manager" onClick={() => showInFileManager(note.folder)} />
            </div>
          )}

          <div hidden={!searchOpen}>
            <SearchPanel
              kind="notes"
              sort={sort}
              onSort={setSort}
              searching={criteria !== null}
              onSearch={setCriteria}
              onClear={() => setCriteria(null)}
            />
          </div>

          {criteria && source && (
            <NoteSearchResults
              onError={setError}
              onNotice={setNotice}
              source={source}
              folder={folder}
              criteria={criteria}
              sort={sort}
              pageSize={pageSize}
              showIndexes={settings.showIndexes}
              onOpen={(hit) => openNote(hit.note)}
              onEdit={(hit) => edit(hit.note)}
              onChildren={(hit) => showChildren(hit.note)}
              onShow={(hit) => onPlace({ view: 'notes', sourceId, folder: parentOf(hit.note.folder) })}
            />
          )}

          {selecting && !criteria && (
            <div className="notes-panel-row note-selection">
              <strong>{selected.size} selected</strong>
              <button type="button" className="link-button" onClick={() => setSelected(new Set(children.map((n) => n.index)))}>
                Select all
              </button>
              <IconButton icon={Scissors} label="Cut the selected notes" onClick={() => clip(chosen, 'cut')} />
              <IconButton icon={Copy} label="Copy the selected notes" onClick={() => clip(chosen, 'copy')} />
              <IconButton icon={Trash2} label="Delete the selected notes" variant="danger" onClick={() => setDeleting(chosen)} />
              <IconButton icon={X} label="Clear the selection" onClick={() => setSelected(new Set())} />
            </div>
          )}

          {error && <div className="error-banner">{error}</div>}
          {notice && <div className="status-banner">{notice}</div>}
          {repaired && children.length > 0 && (
            <div className="status-banner">
              The list of notes here was missing or damaged, so it was rebuilt from the [note].json files of the child notes. It is written again with the next change.
            </div>
          )}
          {loading && <div className="muted">Loading…</div>}
          {!loading && children.length === 0 && !error && <div className="muted notes-empty">{note ? 'This note has no child notes yet.' : 'This notebook has no notes yet.'} Add one with +.</div>}

          {!loading && !criteria && children.length > 0 && (
            <table className="file-table">
              <thead>
                <tr>
                  <th>{note ? 'Child notes' : 'Notes'}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {list.map((n, i) => {
                  const isSelected = selected.has(n.index)
                  const editingTitle = editing?.kind === 'title' && editing.key === n.index
                  const editingIndex = editing?.kind === 'index' && editing.key === n.index
                  return (
                    <tr
                      key={n.index}
                      className={isSelected ? 'note-row selected' : 'note-row'}
                      {...kbdItem(kbdFocus, i, setKbdFocus)}
                      {...contextTrigger((x, y) => openMenu(n, x, y))}
                    >
                      <td>
                        <div className="note-title-line">
                          {selecting && (
                            <input type="checkbox" checked={isSelected} onChange={() => toggleSelected(n)} aria-label={`Select "${n.title}"`} />
                          )}
                          {editingIndex ? (
                            editBox(n, 'index')
                          ) : (
                            settings.showIndexes &&
                            (indexOps ? (
                              <button type="button" className="note-index" onClick={() => startEdit('index', n)} title="Edit the index (Shift+F2)">
                                {n.index}
                              </button>
                            ) : (
                              <span className="note-index" title="Clear the search and the sorting to edit the indexes">
                                {n.index}
                              </span>
                            ))
                          )}
                          {editingTitle ? (
                            editBox(n, 'title')
                          ) : (
                            <button className="link-button entry-name" onClick={() => openNote(n)} title="Open it as a web app, in a tab of this window">
                              <FileText size={15} strokeWidth={2} aria-hidden="true" /> {n.title}
                            </button>
                          )}
                        </div>
                        <div className="muted notebook-where">{formatWhen(n.updatedAt ?? n.createdAt)}</div>
                      </td>
                      <td className="row-actions">
                        <CacheMenu source={source} path={n.folder} isDirectory onDone={() => load()} onError={setError} onNotice={setNotice} />
                        <RowActions
                          actions={[
                            { icon: FilePenLine, label: 'Edit its markdown', onClick: () => edit(n) },
                            { icon: FolderTree, label: 'Its child notes', onClick: () => showChildren(n) },
                            { icon: Paperclip, label: 'Its files', onClick: () => showFiles(n) },
                            { icon: FolderOpen, label: 'Show its folder in the File Manager', onClick: () => showInFileManager(n.folder) },
                            { icon: Pencil, label: 'Change its title (F2)', onClick: () => startEdit('title', n) },
                            { icon: Trash2, label: 'Delete it', danger: true, onClick: () => setDeleting([n]) },
                          ]}
                        />
                        <IconButton
                          icon={MoreHorizontal}
                          label="More…"
                          onClick={(e) => {
                            const box = e.currentTarget.getBoundingClientRect()
                            openMenu(n, box.left, box.bottom + 4)
                          }}
                        />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      </main>

      {menu && <ContextMenu items={menuItems(menu)} x={menu.x} y={menu.y} onClose={() => setMenu(null)} />}

      {indexing && (
        <IndexesModal
          source={source}
          parent={folder}
          notes={children}
          onApplied={() => {
            setIndexing(false)
            load()
          }}
          onClose={() => setIndexing(false)}
        />
      )}

      {deleting && <DeleteNotesModal notes={deleting} canNormalize={indexOps} onConfirm={(normalize) => removeNotes(deleting, normalize)} onClose={() => setDeleting(null)} />}

      {pasting && clipboard && (
        <PasteNotesModal
          clipboard={clipboard}
          source={source}
          parent={folder}
          onDone={() => {
            if (clipboard.mode === 'cut') setNoteClipboard(null)
            setPasting(false)
            load()
          }}
          onClose={() => setPasting(false)}
        />
      )}

      {goingTo && (
        <GoToPathModal
          title="Go to a path or a note"
          current={pathForInput(folder)}
          hint="A folder path — or a note's address: /Notebook/999/998?note"
          onGo={goToPath}
          onClose={() => setGoingTo(false)}
        />
      )}
    </div>
  )
}
