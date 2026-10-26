import { useRef, useState } from 'react'
import { FilePlus2, X } from 'lucide-react'
import IconButton from '../../components/IconButton'
import Modal from '../../components/Modal'
import { NOTE_INTERVALS, nextIndexIn, type NoteInterval } from './noteIndexes'
import { usedIndexes } from './noteModel'
import InsertCustomTextButton from './InsertCustomTextButton'
import type { FileSource } from './sources'

/** **New note…** — the title, and which interval its index comes from (`docs/strategies/notes-strategy.md`, `noteIndexes.ts`): the
 * note items' interval by default, or one of the section intervals when the person means the new note to be a section rather than an
 * ordinary note (a note is only ever *converted* between intervals afterwards through the indexes dialog — this is the one place a new
 * note picks one up front). `names` are the entries already in the parent, so a full interval is shown as such (its radio disabled)
 * rather than only failing once *Create* is pressed.
 *
 * `source`/`sourceId`/`folder` are only for the title field's own "Insert custom text" button (item 1 of the todo) — nothing else
 * here needs them; the button itself renders nothing when the folder isn't inside a listed notebook. */
export default function NewNoteModal({
  names,
  source,
  sourceId,
  folder,
  onCreate,
  onClose,
}: {
  names: string[]
  source: FileSource
  sourceId: string
  folder: string
  onCreate: (title: string, interval: NoteInterval) => Promise<void>
  onClose: () => void
}) {
  const [title, setTitle] = useState('')
  const titleRef = useRef<HTMLInputElement>(null)
  const [intervalKey, setIntervalKey] = useState(NOTE_INTERVALS[0].key)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const used = usedIndexes(names)
  const rooms = NOTE_INTERVALS.map((interval) => ({ interval, room: nextIndexIn(interval, used) !== null }))
  const interval = rooms.find((r) => r.interval.key === intervalKey)?.interval ?? NOTE_INTERVALS[0]
  const problem = title.trim() === '' ? 'Give the note a title.' : rooms.find((r) => r.interval.key === intervalKey)?.room === false ? `${interval.label} has no room (it goes from ${interval.from} to ${interval.to}): normalize the indexes to make room.` : null

  async function create() {
    if (problem || busy) return
    setBusy(true)
    setError(null)
    try {
      await onCreate(title.trim(), interval)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <Modal title="New note…" onClose={onClose}>
      <div className="pair-modal">
        <label className="notes-field notes-field-leading">
          <span>Title</span>
          <input
            ref={titleRef}
            autoFocus
            data-ua-field="notes.newNote.title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && create()}
          />
          <InsertCustomTextButton source={source} sourceId={sourceId} folder={folder} inputRef={titleRef} value={title} onChange={setTitle} />
        </label>
        <fieldset className="notes-field">
          <legend>Index interval</legend>
          {rooms.map(({ interval: i, room }) => (
            <label key={i.key} className="pair-check">
              <input type="radio" name="new-note-interval" checked={intervalKey === i.key} disabled={!room} onChange={() => setIntervalKey(i.key)} />
              {i.label} ({i.from}–{i.to}){!room && ' — no room'}
            </label>
          ))}
        </fieldset>
        {(error ?? (title.trim() !== '' ? problem : null)) && <div className="error-banner">{error ?? problem}</div>}
        <div className="toolbar-actions" style={{ justifyContent: 'flex-end' }}>
          <IconButton icon={FilePlus2} label="Create the note" onClick={create} disabled={problem !== null || busy} />
          <IconButton icon={X} label="Cancel" onClick={onClose} />
        </div>
      </div>
    </Modal>
  )
}
