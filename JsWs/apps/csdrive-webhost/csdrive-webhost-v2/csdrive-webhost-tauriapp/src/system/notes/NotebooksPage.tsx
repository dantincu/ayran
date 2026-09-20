import { useEffect, useRef, useState } from 'react'
import { confirm } from '@tauri-apps/plugin-dialog'
import { FolderOpen, House, Pencil, Plus, Trash2 } from 'lucide-react'
import IconButton from '../../components/IconButton'
import Modal from '../../components/Modal'
import { kbdItem, useListKeyboard } from '../../lib/keyboard'
import LocationPicker, { type Picked } from './LocationPicker'
import {
  addExistingNotebook,
  checkNotebook,
  createNotebook,
  describeLocation,
  describeNotebookFilesIn,
  loadNotebooks,
  notebookFilesIn,
  retitleNotebook,
  unlistNotebook,
  updateNotebooks,
  type NotebookCheck,
  type NotebookEntry,
} from './notebooks'
import { useNotesSources } from './useSources'

/** Where the person is in adding a notebook. */
type Adding =
  | { step: 'choose' }
  /** Looking for the `[note-book].json` file of a notebook that exists but isn't listed. */
  | { step: 'existing' }
  | { step: 'title' }
  /** Choosing the root folder; `at` is where the picker starts (where the person was, when they come back to it). */
  | { step: 'folder'; title: string; at?: { sourceId: string; path: string } }
  /** The chosen folder already holds notebook file(s): the person is told, and decides. */
  | { step: 'warn'; title: string; picked: Picked; found: { name: string; title: string | null }[] }

/** The page for managing notebooks: the list of the ones this app knows, with what can be done to each — show its folder,
 * give it another title, take it out of the list — and how to add one: an existing notebook (one that is on this device or
 * in a Filen account but isn't listed) or a new one. */
export default function NotebooksPage({ onHome, onShowFolder }: { onHome: () => void; onShowFolder: (entry: NotebookEntry) => void }) {
  const { roots, accounts, ready, addRoot, sourceOf } = useNotesSources()
  const [notebooks, setNotebooks] = useState<NotebookEntry[] | null>(null)
  const [checks, setChecks] = useState<Record<string, NotebookCheck>>({})
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [adding, setAdding] = useState<Adding | null>(null)
  const [editing, setEditing] = useState<NotebookEntry | null>(null)
  const [busy, setBusy] = useState(false)
  const [kbdFocus, setKbdFocus] = useState(-1)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    loadNotebooks().then((list) => mounted.current && setNotebooks(list))
    return () => {
      mounted.current = false
    }
  }, [])

  // Look at each listed notebook's file (once): is it reachable, still a notebook, and with which title? The file is the
  // truth — a title changed outside the app is taken into the list.
  useEffect(() => {
    if (!ready || !notebooks) return
    for (const entry of notebooks) {
      if (checks[entry.guid]) continue
      setChecks((all) => ({ ...all, [entry.guid]: { state: 'checking' } }))
      checkNotebook(entry, roots, accounts).then((result) => {
        if (!mounted.current) return
        setChecks((all) => ({ ...all, [entry.guid]: result }))
        if (result.state === 'ok' && result.title !== entry.title) {
          updateNotebooks((list) => list.map((n) => (n.guid === entry.guid ? { ...n, title: result.title } : n))).then((list) => mounted.current && setNotebooks(list))
        }
      })
    }
  }, [ready, notebooks, roots, accounts, checks])

  const list = notebooks ?? []

  useListKeyboard({
    count: list.length,
    focused: kbdFocus,
    setFocused: setKbdFocus,
    onOpen: (index) => list[index] && onShowFolder(list[index]),
    onParent: onHome,
    enabled: !adding && !editing,
  })

  async function guarded(work: () => Promise<void>) {
    setError(null)
    setNotice(null)
    setBusy(true)
    try {
      await work()
    } catch (e) {
      if (mounted.current) setError(String(e))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  const refresh = async () => setNotebooks(await loadNotebooks())

  // ── Changing a listed notebook ──

  function saveTitle(entry: NotebookEntry, title: string) {
    setEditing(null)
    guarded(async () => {
      const source = sourceOf(entry.sourceId)
      if (!source) throw new Error(`Can't reach where "${entry.title}" is kept, so its title can't be changed.`)
      await retitleNotebook(entry, source, title)
      setChecks((all) => {
        const { [entry.guid]: _gone, ...rest } = all
        return rest
      })
      await refresh()
      setNotice(`The notebook is now called "${title.trim()}".`)
    })
  }

  async function remove(entry: NotebookEntry) {
    const yes = await confirm(`Take "${entry.title}" out of the list?\n\nNothing is deleted: its files stay where they are, and you can add it again later.`)
    if (!yes) return
    guarded(async () => {
      setNotebooks(await unlistNotebook(entry.guid))
      setNotice(`"${entry.title}" is no longer in the list.`)
    })
  }

  // ── Adding ──

  /** Lists a notebook that exists: its file is read, and it is added unless the list has it already. */
  function addFound(picked: Picked) {
    setAdding(null)
    guarded(async () => {
      const result = await addExistingNotebook(picked.source, picked.folder, picked.fileName ?? '')
      if (result.status === 'not-a-notebook') throw new Error(`"${picked.fileName}" isn't a notebook file: ${result.reason}`)
      await refresh()
      setNotice(
        result.status === 'added'
          ? `Added "${result.entry.title}" to the list.`
          : `"${result.entry.title}" is already in your list — it is the notebook found at ${describeLocation(result.entry, roots, accounts)}.`,
      )
    })
  }

  function create(title: string, picked: Picked) {
    setAdding(null)
    guarded(async () => {
      const entry = await createNotebook(picked.source, picked.folder, title)
      await refresh()
      setNotice(`Created "${entry.title}" — its file is ${entry.fileName}, in ${describeLocation(entry, roots, accounts).split(' · ').slice(0, 2).join(' · ')}.`)
    })
  }

  /** A folder was chosen for a new notebook: if it already holds a notebook file, say so first. */
  async function folderChosen(title: string, picked: Picked) {
    setBusy(true)
    try {
      const { entries } = await picked.source.list(picked.folder)
      const names = notebookFilesIn(entries)
      if (names.length === 0) {
        setBusy(false)
        create(title, picked)
        return
      }
      const found = await describeNotebookFilesIn(picked.source, picked.folder, names)
      setBusy(false)
      setAdding({ step: 'warn', title, picked, found })
    } catch (e) {
      setBusy(false)
      setAdding(null)
      setError(String(e))
    }
  }

  const where = (picked: Picked) => `${picked.source.label} · /${picked.folder}`

  return (
    <div className="app-shell">
      <main className="tab-content">
        <div className="tab-panel notes-page">
          <div className="notes-page-header">
            <IconButton icon={House} label="Notes home" onClick={onHome} />
            <h2>Notebooks</h2>
            <button type="button" onClick={() => setAdding({ step: 'choose' })} disabled={!ready || busy}>
              <Plus size={14} strokeWidth={2} aria-hidden="true" /> Add a notebook…
            </button>
          </div>

          {error && <div className="error-banner">{error}</div>}
          {notice && <div className="status-banner">{notice}</div>}

          {notebooks === null || !ready ? (
            <div className="muted">Loading…</div>
          ) : list.length === 0 ? (
            <div className="muted notes-empty">No notebooks yet. Add one that already exists, or create a new one.</div>
          ) : (
            <table className="file-table">
              <thead>
                <tr>
                  <th>Notebook</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {list.map((entry, i) => {
                  const check = checks[entry.guid]
                  return (
                    <tr key={entry.guid} {...kbdItem(kbdFocus, i, setKbdFocus)}>
                      <td>
                        <div className="notebook-title">
                          <strong>{entry.title}</strong>
                          {check?.state === 'problem' && (
                            <span className="notes-badge notes-badge-delete" title={check.reason}>
                              can't be opened
                            </span>
                          )}
                        </div>
                        <div className="muted notebook-where">{describeLocation(entry, roots, accounts)}</div>
                        {check?.state === 'problem' && <div className="notebook-problem">{check.reason}</div>}
                      </td>
                      <td className="row-actions">
                        <IconButton icon={FolderOpen} label="Show its folder in the file manager" onClick={() => onShowFolder(entry)} />
                        <IconButton icon={Pencil} label="Change its title" onClick={() => setEditing(entry)} disabled={busy} />
                        <IconButton icon={Trash2} label="Take it out of the list (its files stay where they are)" variant="danger" onClick={() => remove(entry)} disabled={busy} />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      </main>

      {adding?.step === 'choose' && (
        <Modal title="Add a notebook" onClose={() => setAdding(null)}>
          <p className="muted">
            The notebooks this app knows are listed on this page. Here you add one that isn't listed — either because it already exists somewhere, or because it is new.
          </p>
          <div className="notes-choices">
            <button type="button" className="notes-choice" onClick={() => setAdding({ step: 'existing' })}>
              <strong>Add an existing notebook</strong>
              <span className="muted">
                It exists on this device or in a Filen account, but this app doesn't list it yet. You choose its <code>[note-book].json</code> file.
              </span>
            </button>
            <button type="button" className="notes-choice" onClick={() => setAdding({ step: 'title' })}>
              <strong>Create a new notebook</strong>
              <span className="muted">You give it a title, then choose the folder that will be its root.</span>
            </button>
          </div>
        </Modal>
      )}

      {adding?.step === 'existing' && (
        <LocationPicker
          mode="notebook"
          title="Choose the notebook's file"
          roots={roots}
          accounts={accounts}
          onAddRoot={addRoot}
          listed={list}
          onPick={addFound}
          onCancel={() => setAdding({ step: 'choose' })}
        />
      )}

      {adding?.step === 'title' && (
        <TitleDialog
          heading="New notebook"
          question="What is the notebook's title?"
          confirmLabel="Next: choose the folder"
          onSubmit={(title) => setAdding({ step: 'folder', title })}
          onCancel={() => setAdding({ step: 'choose' })}
        />
      )}

      {adding?.step === 'folder' && (
        <LocationPicker
          mode="folder"
          title={`Where should "${adding.title}" live? Choose its root folder`}
          roots={roots}
          accounts={accounts}
          onAddRoot={addRoot}
          listed={list}
          initial={adding.at}
          onPick={(picked) => folderChosen(adding.title, picked)}
          onCancel={() => setAdding({ step: 'title' })}
        />
      )}

      {adding?.step === 'warn' && (
        <Modal title="This folder already has a notebook" onClose={() => setAdding(null)}>
          <p>
            <strong>{where(adding.picked)}</strong> already contains {adding.found.length === 1 ? 'a notebook file' : 'notebook files'}:
          </p>
          <ul className="notes-changes">
            {adding.found.map((f) => (
              <li key={f.name}>
                <code>{f.name}</code> {f.title ? <>— <em>{f.title}</em></> : <span className="muted">— not a valid notebook file</span>}
              </li>
            ))}
          </ul>
          <p>
            A notebook's notes are kept in its root folder, so a second notebook created here would share that folder — and everything in it — with the existing one. The new
            notebook's file gets a name of its own; nothing is overwritten.
          </p>
          <div className="dialog-actions">
            <button type="button" onClick={() => setAdding({ step: 'folder', title: adding.title, at: { sourceId: adding.picked.source.id, path: adding.picked.folder } })}>
              Choose another folder
            </button>
            <button type="button" onClick={() => setAdding(null)}>
              Cancel
            </button>
            <button type="button" className="dialog-danger" onClick={() => create(adding.title, adding.picked)}>
              Create it here anyway
            </button>
          </div>
        </Modal>
      )}

      {editing && (
        <TitleDialog
          heading="Change the title"
          question={`New title for "${editing.title}":`}
          initial={editing.title}
          confirmLabel="Save"
          onSubmit={(title) => saveTitle(editing, title)}
          onCancel={() => setEditing(null)}
        />
      )}
    </div>
  )
}

/** Asks for a title. Enter or the button confirms; a title of nothing but spaces can't be. */
function TitleDialog({
  heading,
  question,
  initial = '',
  confirmLabel,
  onSubmit,
  onCancel,
}: {
  heading: string
  question: string
  initial?: string
  confirmLabel: string
  onSubmit: (title: string) => void
  onCancel: () => void
}) {
  const [title, setTitle] = useState(initial)
  const valid = title.trim() !== ''
  return (
    <Modal title={heading} onClose={onCancel}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (valid) onSubmit(title.trim())
        }}
      >
        <label className="notes-field notes-title-field">
          <span>{question}</span>
          <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Title" />
        </label>
        <div className="dialog-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!valid}>
            {confirmLabel}
          </button>
        </div>
      </form>
    </Modal>
  )
}
