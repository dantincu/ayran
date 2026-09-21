import { useCallback, useEffect, useMemo, useState } from 'react'
import { confirm } from '@tauri-apps/plugin-dialog'
import {
  AppWindow,
  AppWindowMac,
  CheckSquare,
  ChevronRight,
  CircleSlash,
  Eye,
  FilePenLine,
  FileText,
  FolderOpen,
  FolderTree,
  Hash,
  House,
  MoreHorizontal,
  Navigation,
  Paperclip,
  Pause,
  Pencil,
  Plus,
  RefreshCw,
  Square,
  Trash2,
  X,
} from 'lucide-react'
import ContextMenu, { contextTrigger, type MenuItem } from '../../components/ContextMenu'
import GoToPathModal from '../../components/GoToPathModal'
import IconButton from '../../components/IconButton'
import { pathForInput } from '../../lib/pathInput'
import { noteTabAction, noteTabState, openNoteTab, type SyncingTab } from '../../lib/secondaryWindows'
import { isNoteQuery } from '../../lib/textLinks'
import { loadNotebooks, type NotebookEntry } from './notebooks'
import { ancestorsOf, changeNoteIndex, createNote, deleteNote, findMarkdown, readChildren, readNote, renameNote, type NoteRef } from './noteModel'
import { useNotesSettings } from './settings'
import { reportNotePlace, type Place, type Tab } from './tabs'
import { useNotesSources } from './useSources'

const formatWhen = (stamp: string) => {
  const date = new Date(stamp)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString()
}

/** The menu of a note: where it opens, and what the tab that follows the note's editor is doing (if there is one). */
interface OpenMenu {
  note: NoteRef
  x: number
  y: number
  markdown: string | null
  syncing: SyncingTab | null
}

/** The page of the notes in a notebook's root folder or in a note's folder — "the children" of one or the other: what to do with
 * each (open it as a web app, edit its markdown, see its children, see its files, show it in the File Manager, rename, delete),
 * a new note, and — under a note — the same for the note itself. It is one page for both: a notebook is the note tree's root.
 *
 * **Clicking a note opens it as a web app in a tab of this window** — the tab that follows the note's editor: a second click brings
 * it back. Each row's *more* button (and a right click, or a long press) opens a menu: the note's index, selecting it, a tab that
 * does not follow the editor, and showing, suspending or closing the one that does. */
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
  const [notebook, setNotebook] = useState<NotebookEntry | null>(null)
  const [note, setNote] = useState<NoteRef | null>(null)
  const [trail, setTrail] = useState<NoteRef[]>([])
  const [children, setChildren] = useState<NoteRef[]>([])
  const [repaired, setRepaired] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [goingTo, setGoingTo] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [menu, setMenu] = useState<OpenMenu | null>(null)

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

  async function rename(n: NoteRef) {
    const next = window.prompt("The note's new title:", n.title)?.trim()
    if (!next || next === n.title || !source) return
    await attempt(async () => {
      await renameNote(source, n, next)
      await load()
    })
  }

  async function editIndex(n: NoteRef) {
    const next = window.prompt(`The index of "${n.title}" (1 to 999; now ${n.index}):`, n.index)?.trim()
    if (!next || next === n.index || !source) return
    await attempt(async () => {
      await changeNoteIndex(source, n, next.padStart(3, '0'))
      await load()
    })
  }

  async function remove(n: NoteRef) {
    if (!source || !(await confirm(`Delete the note "${n.title}", with its child notes and files? This cannot be undone.`))) return
    await attempt(async () => {
      await deleteNote(source, n)
      await load()
    })
  }

  async function removeSelected() {
    const doomed = children.filter((n) => selected.has(n.index))
    if (!source || doomed.length === 0) return
    if (!(await confirm(`Delete ${doomed.length} note${doomed.length === 1 ? '' : 's'}, with their child notes and files? This cannot be undone.`))) return
    await attempt(async () => {
      for (const n of doomed) await deleteNote(source, n)
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
      { label: 'Edit the index…', icon: Hash, onSelect: () => editIndex(m.note) },
      { label: selected.has(m.note.index) ? 'Deselect' : 'Select', icon: selected.has(m.note.index) ? Square : CheckSquare, onSelect: () => toggleSelected(m.note) },
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

  /** "Go to a path" on a notes page: a note's address (\`?note\`) opens that note; the path of a note's folder shows its children;
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
            <IconButton icon={Navigation} label="Go to a path or a note's address…" onClick={() => setGoingTo(true)} />
            <IconButton icon={RefreshCw} label="Refresh" onClick={load} />
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

          {selecting && (
            <div className="notes-panel-row note-selection">
              <strong>{selected.size} selected</strong>
              <button type="button" className="link-button" onClick={() => setSelected(new Set(children.map((n) => n.index)))}>
                Select all
              </button>
              <IconButton icon={Trash2} label="Delete the selected notes" variant="danger" onClick={removeSelected} />
              <IconButton icon={X} label="Clear the selection" onClick={() => setSelected(new Set())} />
            </div>
          )}

          {error && <div className="error-banner">{error}</div>}
          {repaired && children.length > 0 && (
            <div className="status-banner">
              The list of notes here was missing or damaged, so it was rebuilt from the [note].json files of the child notes. It is written again with the next change.
            </div>
          )}
          {loading && <div className="muted">Loading…</div>}
          {!loading && children.length === 0 && !error && <div className="muted notes-empty">{note ? 'This note has no child notes yet.' : 'This notebook has no notes yet.'} Add one with +.</div>}

          {!loading && children.length > 0 && (
            <table className="file-table">
              <thead>
                <tr>
                  <th>{note ? 'Child notes' : 'Notes'}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {children.map((n) => {
                  const isSelected = selected.has(n.index)
                  return (
                    <tr key={n.index} className={isSelected ? 'note-row selected' : 'note-row'} {...contextTrigger((x, y) => openMenu(n, x, y))}>
                      <td>
                        <div className="note-title-line">
                          {selecting && (
                            <input type="checkbox" checked={isSelected} onChange={() => toggleSelected(n)} aria-label={`Select "${n.title}"`} />
                          )}
                          {settings.showIndexes && <span className="note-index">{n.index}</span>}
                          <button className="link-button entry-name" onClick={() => openNote(n)} title="Open it as a web app, in a tab of this window">
                            <FileText size={15} strokeWidth={2} aria-hidden="true" /> {n.title}
                          </button>
                        </div>
                        <div className="muted notebook-where">{formatWhen(n.updatedAt ?? n.createdAt)}</div>
                      </td>
                      <td className="row-actions">
                        <IconButton icon={FilePenLine} label="Edit its markdown" onClick={() => edit(n)} />
                        <IconButton icon={FolderTree} label="Its child notes" onClick={() => showChildren(n)} />
                        <IconButton icon={Paperclip} label="Its files" onClick={() => showFiles(n)} />
                        <IconButton icon={FolderOpen} label="Show its folder in the File Manager" onClick={() => showInFileManager(n.folder)} />
                        <IconButton icon={Pencil} label="Change its title" onClick={() => rename(n)} />
                        <IconButton icon={Trash2} label="Delete it" variant="danger" onClick={() => remove(n)} />
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

      {goingTo && (
        <GoToPathModal
          title="Go to a path or a note"
          current={pathForInput(folder)}
          hint="A folder path — or a note's address: /Notebook/001/002?note"
          onGo={goToPath}
          onClose={() => setGoingTo(false)}
        />
      )}
    </div>
  )
}
