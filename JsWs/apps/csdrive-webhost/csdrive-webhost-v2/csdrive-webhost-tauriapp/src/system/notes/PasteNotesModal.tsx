import { useEffect, useState } from 'react'
import { Check, X } from 'lucide-react'
import IconButton from '../../components/IconButton'
import Modal from '../../components/Modal'
import { indexText, intervalLabel, MAX_INDEX, parseIndex, problems } from './noteIndexes'
import type { NoteClipboard } from './noteClipboard'
import { indexesForPaste, placeNotes, type PasteIndexes } from './noteTransfer'
import type { FileSource } from './sources'

/** **Pastes the cut or copied notes** under a parent (a notebook's root, or a note): by default each gets the **next available index**
 * there (after the largest of the note items' interval, as a new note does); or the **first free ones — filling the gaps** of the
 * parent; or indexes of the person's own, one box each. A cut can also **normalize the indexes of what stays behind** in the old parent. */
export default function PasteNotesModal({
  clipboard,
  source,
  parent,
  onDone,
  onClose,
}: {
  clipboard: NoteClipboard
  source: FileSource
  parent: string
  onDone: () => void
  onClose: () => void
}) {
  const { notes, mode } = clipboard
  const [how, setHow] = useState<PasteIndexes>('next')
  const [texts, setTexts] = useState<string[]>(notes.map(() => ''))
  const [room, setRoom] = useState<Record<'next' | 'gaps', number[] | null> | null>(null)
  const [normalizeOld, setNormalizeOld] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    Promise.all([indexesForPaste(source, parent, notes.length, 'next'), indexesForPaste(source, parent, notes.length, 'gaps')])
      .then(([next, gaps]) => {
        if (cancelled) return
        setRoom({ next, gaps })
        setTexts((next ?? gaps ?? notes.map(() => 0)).map((n) => (n ? indexText(n) : '')))
      })
      .catch((e) => !cancelled && setError(String(e)))
    return () => {
      cancelled = true
    }
  }, [source, parent, notes])

  const chosen: Array<number | null> = how === 'custom' ? texts.map(parseIndex) : (room?.[how] ?? [])
  const shown = how === 'custom' ? texts : chosen.map((n) => (n === null ? '' : indexText(n)))
  const { duplicates, invalid } = problems(chosen.map((index, i) => ({ key: String(i), index: index ?? null })))
  const noRoom = how !== 'custom' && room !== null && room[how] === null
  const ready = room !== null && !noRoom && chosen.length === notes.length && duplicates.size === 0 && invalid.size === 0

  async function paste() {
    if (!ready || busy) return
    setBusy(true)
    setError(null)
    try {
      await placeNotes(clipboard.source, notes, source, parent, chosen as number[], mode, normalizeOld)
      onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <Modal title={mode === 'cut' ? 'Move the notes here' : 'Copy the notes here'} onClose={onClose} wide>
      <div className="pair-modal">
        <div className="paste-choices">
          <label>
            <input type="radio" name="paste-how" checked={how === 'next'} onChange={() => setHow('next')} /> The next available indexes here <span className="muted">(after the largest, as a new note)</span>
          </label>
          <label>
            <input type="radio" name="paste-how" checked={how === 'gaps'} onChange={() => setHow('gaps')} /> Fill the gaps of this parent <span className="muted">(the first free indexes)</span>
          </label>
          <label>
            <input type="radio" name="paste-how" checked={how === 'custom'} onChange={() => setHow('custom')} /> Indexes of my own
          </label>
        </div>
        <ul className="indexes-list">
          {notes.map((n, i) => (
            <li key={n.index} className="indexes-row">
              {how === 'custom' ? (
                <input
                  data-ua-field="notes.pasteNotes.customIndex"
                  className={`indexes-input ${chosen[i] === null || duplicates.has(chosen[i] as number) ? 'invalid' : ''}`}
                  value={texts[i]}
                  inputMode="numeric"
                  aria-label={`The index of "${n.title}"`}
                  onChange={(e) => setTexts((current) => current.map((t, j) => (j === i ? e.target.value : t)))}
                />
              ) : (
                <code className="indexes-input">{shown[i] ?? '—'}</code>
              )}
              <span className="indexes-title" title={n.title}>
                {n.title}
              </span>
              <span className="muted indexes-was">was {n.index}</span>
              {chosen[i] != null && <span className="muted indexes-interval">{intervalLabel(chosen[i] as number)}</span>}
            </li>
          ))}
        </ul>
        {mode === 'cut' && (
          <label className="pair-check">
            <input type="checkbox" checked={normalizeOld} onChange={(e) => setNormalizeOld(e.target.checked)} /> Normalize the indexes of the notes that stay in the old parent afterwards
          </label>
        )}
        {(error || noRoom || duplicates.size > 0 || invalid.size > 0) && (
          <div className="error-banner">
            {error ??
              (noRoom
                ? 'There is no room for all of them in that interval — choose the gaps, your own indexes, or normalize the notes there first.'
                : invalid.size > 0
                  ? `An index is a number from 1 to ${MAX_INDEX}.`
                  : 'An index is used twice.')}
          </div>
        )}
        <div className="toolbar-actions" style={{ justifyContent: 'flex-end' }}>
          <IconButton icon={Check} label={mode === 'cut' ? 'Move them here' : 'Copy them here'} onClick={paste} disabled={!ready || busy} />
          <IconButton icon={X} label="Cancel" onClick={onClose} />
        </div>
      </div>
    </Modal>
  )
}
