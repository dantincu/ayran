import { useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, GripVertical, ListRestart, Wand2, Check, X, ArrowRightLeft } from 'lucide-react'
import IconButton from '../../components/IconButton'
import Modal from '../../components/Modal'
import { convert, indexText, intervalLabel, intervalOf, keysInInterval, NOTE_INTERVALS, normalize, parseIndex, problems, reorder, type Assignment } from './noteIndexes'
import { reassignIndexes, type NoteRef } from './noteModel'
import type { FileSource } from './sources'

interface Row {
  note: NoteRef
  /** What the index box holds now (text: a person is typing in it). */
  text: string
}


/** **The indexes of the child notes of one parent, all in one dialog**: every index can be typed over; the rows can be reordered by
 * dragging them or with the arrow buttons at their top (the *same* indexes are handed out again in the new order); **Normalize** closes
 * the gaps of every interval, keeping the order and each note in its own interval; **Convert** moves the notes of one interval into
 * another (a note of the first versions of the app, numbered outside every interval, into the note items…). Nothing is written until
 * **Apply**, which renames all the changed pairs in one go (two phases through the temporary prefix — see `reassignIndexes`). */
export default function IndexesModal({
  source,
  parent,
  notes,
  onApplied,
  onClose,
}: {
  source: FileSource
  /** The folder the notes are children of (a notebook's root or a note's short folder). */
  parent: string
  notes: NoteRef[]
  onApplied: () => void
  onClose: () => void
}) {
  const initial = useMemo<Row[]>(() => [...notes].sort((a, b) => Number(a.index) - Number(b.index)).map((note) => ({ note, text: note.index })), [notes])
  const [rows, setRows] = useState<Row[]>(initial)
  const [dragging, setDragging] = useState<number | null>(null)
  const [over, setOver] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** The rows ticked for **Convert** (by the note's original index). */
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [to, setTo] = useState<string>(NOTE_INTERVALS[0].key)

  const values = rows.map((row) => ({ key: row.note.index, index: parseIndex(row.text) }))
  const { duplicates, invalid } = problems(values)
  const changed = rows.filter((row) => parseIndex(row.text) !== Number(row.note.index)).length
  const canWork = duplicates.size === 0 && invalid.size === 0

  const assignments = (): Assignment[] => values.map((v) => ({ key: v.key, index: v.index as number }))
  const show = (next: Assignment[]) => {
    const byKey = new Map(next.map((a) => [a.key, a.index]))
    setRows((current) => current.map((row) => ({ ...row, text: indexText(byKey.get(row.note.index) ?? Number(row.note.index)) })))
  }

  /** Puts the rows in the order of their indexes again (after an index was typed, normalized or converted). */
  const sorted = (next: Row[]) => [...next].sort((a, b) => (parseIndex(a.text) ?? 1e9) - (parseIndex(b.text) ?? 1e9))

  function work(action: () => Assignment[]) {
    setError(null)
    if (!canWork) return setError('Fix the indexes that are not a number from 1 to 999, or are used twice, first.')
    try {
      show(action())
      setRows((current) => sorted(current))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  function move(fromAt: number, toAt: number) {
    setError(null)
    if (!canWork) return setError('Fix the indexes that are not a number from 1 to 999, or are used twice, first.')
    const next = reorder(assignments(), fromAt, toAt)
    const order = [...rows]
    const [row] = order.splice(fromAt, 1)
    order.splice(toAt, 0, row)
    const byKey = new Map(next.map((a) => [a.key, a.index]))
    setRows(order.map((r) => ({ ...r, text: indexText(byKey.get(r.note.index)!) })))
  }

  /** The whole interval at once: every note in it, or — when all of them are ticked already — none of them. */
  function toggleInterval(keys: string[]) {
    setSelected((current) => {
      const next = new Set(current)
      const all = keys.every((key) => next.has(key))
      for (const key of keys) {
        if (all) next.delete(key)
        else next.add(key)
      }
      return next
    })
  }

  /** The intervals that hold at least one of the notes now (by what is typed), with the keys of those notes — the buttons that select them. */
  const groups = (() => {
    const current: Assignment[] = values.filter((v) => v.index !== null).map((v) => ({ key: v.key, index: v.index as number }))
    return [null, ...NOTE_INTERVALS]
      .map((interval) => ({ interval, keys: keysInInterval(current, interval) }))
      .filter((group) => group.keys.length > 0)
  })()

  const toInterval = NOTE_INTERVALS.find((i) => i.key === to) ?? NOTE_INTERVALS[0]

  async function apply() {
    if (!canWork || changed === 0 || busy) return
    setBusy(true)
    setError(null)
    try {
      await reassignIndexes(
        source,
        parent,
        rows.map((row) => ({ note: row.note, to: parseIndex(row.text) as number })),
      )
      onApplied()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <Modal title="Indexes of these notes" onClose={onClose} wide>
      <div className="indexes-modal">
        <div className="muted">
          Type over an index, drag a note (or use its arrows) to give it another one's place, normalize, or convert — then apply everything at once. Note items are numbered{' '}
          {NOTE_INTERVALS[0].from}→{NOTE_INTERVALS[0].to}; the sections have their own intervals.
        </div>

        <div className="toolbar-actions indexes-tools">
          <button type="button" onClick={() => work(() => normalize(assignments()))} title="Close the gaps of every interval, keeping the order and each note in its own interval">
            <Wand2 size={14} aria-hidden="true" /> Normalize
          </button>
          <IconButton icon={ListRestart} label="Undo everything typed here" onClick={() => setRows(initial)} disabled={rows === initial} />
        </div>

        <div className="toolbar-actions indexes-select">
          <span className="muted">Select:</span>
          <button type="button" onClick={() => setSelected(new Set(rows.map((r) => r.note.index)))}>
            All
          </button>
          <button type="button" onClick={() => setSelected(new Set())} disabled={selected.size === 0}>
            None
          </button>
          {groups.map(({ interval, keys }) => {
            const all = keys.every((key) => selected.has(key))
            return (
              <button
                key={interval?.key ?? 'outside'}
                type="button"
                className={all ? 'selected' : ''}
                title={all ? 'Unselect the whole interval' : 'Select the whole interval'}
                onClick={() => toggleInterval(keys)}
              >
                {interval ? interval.label : 'Outside the intervals'} ({keys.length})
              </button>
            )
          })}
        </div>
        <div className="toolbar-actions indexes-convert">
          <ArrowRightLeft size={14} aria-hidden="true" /> Convert the {selected.size} selected to
          <select value={to} onChange={(e) => setTo(e.target.value)} aria-label="Convert the selected notes into this interval">
            {NOTE_INTERVALS.map((i) => (
              <option key={i.key} value={i.key}>
                {i.label} ({i.from}→{i.to})
              </option>
            ))}
          </select>
          <button type="button" disabled={selected.size === 0} onClick={() => work(() => convert(assignments(), selected, toInterval))}>
            Convert
          </button>
        </div>

        <ul className="indexes-list">
          {rows.map((row, at) => {
            const n = parseIndex(row.text)
            const bad = n === null || duplicates.has(n)
            return (
              <li
                key={row.note.index}
                className={`indexes-row ${over === at && dragging !== null && dragging !== at ? 'drop-target' : ''} ${n !== null && n !== Number(row.note.index) ? 'changed' : ''}`}
                onDragOver={(e) => {
                  if (dragging === null) return
                  e.preventDefault()
                  setOver(at)
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  if (dragging !== null) move(dragging, at)
                  setDragging(null)
                  setOver(null)
                }}
              >
                <input
                  type="checkbox"
                  checked={selected.has(row.note.index)}
                  onChange={() => toggleInterval([row.note.index])}
                  aria-label={`Select "${row.note.title}" for converting`}
                />
                <span
                  className="indexes-grip"
                  draggable
                  title="Drag to give this note another one's place"
                  onDragStart={(e) => {
                    setDragging(at)
                    e.dataTransfer.effectAllowed = 'move'
                    e.dataTransfer.setData('text/plain', row.note.index)
                    const li = e.currentTarget.closest('li')
                    if (li) e.dataTransfer.setDragImage(li, 8, 8)
                  }}
                  onDragEnd={() => {
                    setDragging(null)
                    setOver(null)
                  }}
                >
                  <GripVertical size={16} aria-hidden="true" />
                </span>
                <IconButton icon={ArrowUp} label="Move up" onClick={() => move(at, at - 1)} disabled={at === 0} />
                <IconButton icon={ArrowDown} label="Move down" onClick={() => move(at, at + 1)} disabled={at === rows.length - 1} />
                <input
                  className={`indexes-input ${bad ? 'invalid' : ''}`}
                  value={row.text}
                  inputMode="numeric"
                  aria-label={`The index of "${row.note.title}"`}
                  onChange={(e) => setRows((current) => current.map((r, i) => (i === at ? { ...r, text: e.target.value } : r)))}
                  onBlur={() => {
                    if (n !== null) setRows((current) => sorted(current.map((r, i) => (i === at ? { ...r, text: indexText(n) } : r))))
                  }}
                />
                <span className="indexes-title" title={row.note.title}>
                  {row.note.title}
                </span>
                <span className="muted indexes-interval">{n === null ? '' : (intervalOf(n)?.label ?? intervalLabel(n))}</span>
                {row.note.index !== indexText(n ?? -1) && <span className="muted indexes-was">was {row.note.index}</span>}
              </li>
            )
          })}
        </ul>

        {(error || duplicates.size > 0 || invalid.size > 0) && (
          <div className="error-banner">
            {error ??
              (invalid.size > 0
                ? 'An index is a number from 1 to 999.'
                : `The index${duplicates.size > 1 ? 'es' : ''} ${[...duplicates].map(indexText).join(', ')} ${duplicates.size > 1 ? 'are' : 'is'} used by more than one note.`)}
          </div>
        )}
        <div className="toolbar-actions" style={{ justifyContent: 'space-between' }}>
          <span className="muted">{changed === 0 ? 'Nothing changed yet.' : `${changed} note${changed === 1 ? '' : 's'} will get a new index.`}</span>
          <span className="toolbar-actions">
            <IconButton icon={Check} label="Apply the new indexes" onClick={apply} disabled={!canWork || changed === 0 || busy} />
            <IconButton icon={X} label="Cancel" onClick={onClose} />
          </span>
        </div>
      </div>
    </Modal>
  )
}
