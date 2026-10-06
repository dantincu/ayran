import { useEffect, useState } from 'react'
import { Clipboard, Copy, Plus, Trash2, X } from 'lucide-react'
import IconButton from './IconButton'
import Modal from './Modal'
import ReorderList from './ReorderList'
import { internalClipboard } from '../lib/clipboard'

interface Entry {
  /** A client-only id (the stack itself is a plain list of strings — nothing of the app's own travels with an
   * entry), so `ReorderList` and React's own list reconciliation have something stable to key on. */
  id: string
  text: string
}

let nextId = 0
const freshId = () => `clip-${Date.now()}-${nextId++}`

interface ClipboardManagerModalProps {
  onClose: () => void
  /** Given when opened from a text field's own clipboard menu (`TextFieldMenu.tsx`): each entry then offers
   * **Use this entry here**, sending it to that field, and — only while `currentSelection` isn't empty —
   * **Replace with the current selection**, overwriting that one entry with whatever the field holds now.
   * Omitted when opened from Settings, where there is no target field for either to act on. */
  onPick?: (text: string) => void
  currentSelection?: string
}

/** **Manage the app's clipboard** (asked for directly: the app's own clipboard should work like a stack, not
 * one slot, with a popup to fully edit it — add, insert, edit, remove some or all, reorder, clear, and pick an
 * entry to use or to overwrite). Backed by `internal_clipboard.rs`'s own stack (`push`/`pop`/`peek`/`list`/
 * `set_all`); this popup's own one write path is `set_all` — adding, editing, removing and reordering are all,
 * from the backend's own point of view, just "here is the whole stack now," computed here first.
 *
 * **"Insert anywhere" is add-at-the-top plus reordering, not a dedicated "insert at position N" control**: a
 * fresh entry always starts on top (where `internal_clipboard_push`'s own "copy" already puts one, so the two
 * ways a new entry can appear behave the same way) and `ReorderList` — the same drag-and-drop-plus-arrows
 * component the window/tab/tab-group lists already use — is how it's moved to wherever it's actually meant to
 * sit, rather than this popup inventing a second, different way to position a new entry. */
export default function ClipboardManagerModal({ onClose, onPick, currentSelection }: ClipboardManagerModalProps) {
  const [entries, setEntries] = useState<Entry[] | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    internalClipboard.list().then(
      (list) => setEntries(list.map((text) => ({ id: freshId(), text }))),
      (e) => setError(String(e)),
    )
  }, [])

  async function save(next: Entry[]) {
    setBusy(true)
    setError(null)
    try {
      await internalClipboard.setAll(next.map((e) => e.text))
      setEntries(next)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  function addBlank() {
    if (entries) void save([{ id: freshId(), text: '' }, ...entries])
  }

  // Edited locally on every keystroke (so typing feels instant, like any other box) — saved to the backend
  // only once the box is left, not per keystroke.
  function updateText(id: string, text: string) {
    if (entries) setEntries(entries.map((e) => (e.id === id ? { ...e, text } : e)))
  }

  function commitEdits() {
    if (entries) void save(entries)
  }

  function removeOne(id: string) {
    if (!entries) return
    void save(entries.filter((e) => e.id !== id))
    setSelected((prev) => {
      if (!prev.has(id)) return prev
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }

  function removeSelected() {
    if (!entries) return
    void save(entries.filter((e) => !selected.has(e.id)))
    setSelected(new Set())
  }

  async function clearAll() {
    setBusy(true)
    setError(null)
    try {
      await internalClipboard.clear()
      setEntries([])
      setSelected(new Set())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  function replaceWithCurrent(id: string) {
    if (entries && currentSelection) void save(entries.map((e) => (e.id === id ? { ...e, text: currentSelection } : e)))
  }

  return (
    <Modal title="Manage the app's clipboard" onClose={onClose} wide>
      <p className="muted">
        A stack of text, shared by every window of the app — the admin-app, Notes and web apps. Copying adds a new entry on top;
        pasting takes the top one without removing it. It is kept in memory only and is gone when the app closes; the system's
        clipboard is never touched.
      </p>
      {error && <div className="error-banner">{error}</div>}
      <div className="toolbar-actions">
        <IconButton icon={Plus} label="Add a new entry at the top" onClick={addBlank} disabled={!entries || busy} />
        <IconButton icon={Trash2} label="Remove the selected entries" onClick={removeSelected} disabled={!entries || selected.size === 0 || busy} />
        <IconButton icon={X} label="Clear the app's clipboard" onClick={clearAll} disabled={!entries || entries.length === 0 || busy} />
      </div>
      {entries === null ? (
        <p className="muted">Reading…</p>
      ) : entries.length === 0 ? (
        <p className="muted">The app's clipboard is empty.</p>
      ) : (
        <ReorderList
          items={entries}
          getId={(e) => e.id}
          selected={selected}
          onSelectedChange={setSelected}
          onChange={(next) => void save(next)}
          renderItem={(entry) => (
            <div className="clipboard-entry">
              <textarea
                className="clipboard-entry-text"
                value={entry.text}
                wrap="off"
                rows={3}
                onChange={(e) => updateText(entry.id, e.target.value)}
                onBlur={commitEdits}
                data-no-text-menu
              />
              <div className="toolbar-actions">
                {onPick && <IconButton icon={Clipboard} label="Use this entry here" onClick={() => onPick(entry.text)} />}
                {onPick && currentSelection && (
                  <IconButton icon={Copy} label="Replace this entry with the current selection" onClick={() => replaceWithCurrent(entry.id)} />
                )}
                <IconButton icon={Trash2} label="Remove this entry" onClick={() => removeOne(entry.id)} />
              </div>
            </div>
          )}
        />
      )}
    </Modal>
  )
}
