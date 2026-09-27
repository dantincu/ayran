import { useEffect, useState } from 'react'
import { Check, X } from 'lucide-react'
import IconButton from '../../components/IconButton'
import Modal from '../../components/Modal'
import { indexText, intervalLabel, MAX_INDEX, NOTE_INTERVALS, parseIndex, problems } from './noteIndexes'
import type { NoteClipboard } from './noteClipboard'
import { indexesForPaste, indexesForPasteKeepingIntervals, placeNotes, type PasteIndexes } from './noteTransfer'
import type { FileSource } from './sources'

/** **Pastes the cut or copied notes** under a parent (a notebook's root, or a note): by default each note **keeps its own
 * interval** (the section it was already in, or the note items' interval for one with none) and gets the **next available
 * index** there (after the largest, as a new note does), or the **first free one — filling the gaps** of the parent, or an
 * index of the person's own, one box each. **Convert all to one interval** turns every note — whatever interval it came
 * from — into the same chosen one instead, the same choice `NewNoteModal` offers for a brand new note. A cut can also
 * **normalize the indexes of what stays behind** in the old parent. */
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
  // `null`: each note keeps its own interval (the default). Otherwise, every note is converted to this one.
  const [convertTo, setConvertTo] = useState<string | null>(null)
  const [normalizeOld, setNormalizeOld] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const convertInterval = convertTo === null ? null : (NOTE_INTERVALS.find((i) => i.key === convertTo) ?? null)

  useEffect(() => {
    let cancelled = false
    const compute = (how: 'next' | 'gaps') =>
      convertInterval ? indexesForPaste(source, parent, notes.length, how, convertInterval) : indexesForPasteKeepingIntervals(source, parent, notes, how)
    Promise.all([compute('next'), compute('gaps')])
      .then(([next, gaps]) => {
        if (cancelled) return
        setRoom({ next, gaps })
        setTexts((next ?? gaps ?? notes.map(() => 0)).map((n) => (n ? indexText(n) : '')))
      })
      .catch((e) => !cancelled && setError(String(e)))
    return () => {
      cancelled = true
    }
  }, [source, parent, notes, convertInterval])

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
        {how !== 'custom' && (
          <>
            <label className="pair-check">
              <input type="checkbox" checked={convertTo !== null} onChange={(e) => setConvertTo(e.target.checked ? NOTE_INTERVALS[0].key : null)} /> Convert all to one interval{' '}
              <span className="muted">(otherwise each note keeps the interval it already had)</span>
            </label>
            {convertTo !== null && (
              <fieldset className="notes-field">
                <legend>Index interval</legend>
                {NOTE_INTERVALS.map((i) => (
                  <label key={i.key}>
                    <input type="radio" name="paste-convert-interval" checked={convertTo === i.key} onChange={() => setConvertTo(i.key)} /> {i.label}{' '}
                    <span className="muted">
                      ({i.from}–{i.to})
                    </span>
                  </label>
                ))}
              </fieldset>
            )}
          </>
        )}
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
                ? `There is no room for all of them in ${convertInterval ? 'that interval' : 'one of their intervals'} — choose the gaps, your own indexes, or normalize the notes there first.`
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
