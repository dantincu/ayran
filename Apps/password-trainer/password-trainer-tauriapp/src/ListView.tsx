import { useCallback, useEffect, useRef, useState, type MouseEvent, type PointerEvent } from 'react'
import { api, errorText, type Entry } from './api'
import { ConfirmDialog, EditDialog } from './Dialogs'
import { IconDown, IconEdit, IconGrip, IconPlus, IconTrash, IconUp } from './icons'
import { moveBlock, moveDown, moveUp, rangeBetween, sameOrder } from './reorder'

type Dialog = { kind: 'add' } | { kind: 'edit'; entry: Entry } | { kind: 'delete' } | null

/** A drag in progress: which ids move, and the gap (0…n) they would be dropped into. */
interface Drag {
  pointerId: number
  ids: Set<string>
  gap: number
}

const EDGE = 64 // px from the window's top/bottom where a drag scrolls the list

export function ListView({ entries, setEntries, onOpen }: {
  entries: Entry[]
  setEntries: (e: Entry[]) => void
  onOpen: (id: string) => void
}) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [dialog, setDialog] = useState<Dialog>(null)
  const [error, setError] = useState<string | null>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  /** The checkbox toggled last: one end of a range toggle. */
  const anchor = useRef<string | null>(null)
  const rowRefs = useRef(new Map<string, HTMLLIElement>())
  const pointerY = useRef(0)

  // Forget selected ids that no longer exist (after a delete).
  useEffect(() => {
    setSelected((s) => {
      const ids = new Set(entries.map((e) => e.id))
      const kept = new Set([...s].filter((id) => ids.has(id)))
      return kept.size === s.size ? s : kept
    })
  }, [entries])

  /** Shows the new order at once, then persists it; on failure, reloads what is really stored. */
  const applyOrder = useCallback((next: Entry[]) => {
    if (sameOrder(next, entries)) return
    setEntries(next)
    api.reorder(next.map((e) => e.id)).then(setEntries, (e) => {
      setError(errorText(e))
      api.list().then(setEntries, () => {})
    })
  }, [entries, setEntries])

  // ── selection ──

  /** Toggles `id`; with `range`, every checkbox from the previously toggled one to this one gets the same new state. */
  const toggle = (id: string, range: boolean) => {
    const turnOn = !selected.has(id)
    const next = new Set(selected)
    const from = anchor.current ? entries.findIndex((e) => e.id === anchor.current) : -1
    const to = entries.findIndex((e) => e.id === id)
    const affected = range && from >= 0 ? rangeBetween(entries, from, to) : [entries[to]]
    for (const e of affected) turnOn ? next.add(e.id) : next.delete(e.id)
    anchor.current = id
    setSelected(next)
  }
  const onCheckboxClick = (e: MouseEvent, id: string) => toggle(id, e.shiftKey)
  // A right click, or a long press on a touch screen.
  const onCheckboxContext = (e: MouseEvent, id: string) => {
    e.preventDefault()
    toggle(id, true)
  }

  const allSelected = entries.length > 0 && selected.size === entries.length
  const toggleAll = () => {
    anchor.current = null
    setSelected(allSelected ? new Set() : new Set(entries.map((e) => e.id)))
  }
  const isSel = (e: Entry) => selected.has(e.id)

  // ── drag and drop (pointer events, so it works with touch as well as a mouse) ──

  const gapAt = (y: number) => {
    let gap = entries.length
    for (let i = 0; i < entries.length; i++) {
      const r = rowRefs.current.get(entries[i].id)?.getBoundingClientRect()
      if (r && y < r.top + r.height / 2) {
        gap = i
        break
      }
    }
    return gap
  }

  const startDrag = (e: PointerEvent, id: string) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    pointerY.current = e.clientY
    // Dragging a selected row moves the whole selection; dragging another row moves just that one.
    const ids = selected.has(id) ? new Set(selected) : new Set([id])
    setDrag({ pointerId: e.pointerId, ids, gap: gapAt(e.clientY) })
  }
  const moveDrag = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.pointerId) return
    pointerY.current = e.clientY
    const gap = gapAt(e.clientY)
    if (gap !== drag.gap) setDrag({ ...drag, gap })
  }
  const endDrag = (e: PointerEvent, cancelled: boolean) => {
    if (!drag || e.pointerId !== drag.pointerId) return
    if (!cancelled) applyOrder(moveBlock(entries, (x) => drag.ids.has(x.id), drag.gap))
    setDrag(null)
  }

  // While dragging near the window's top or bottom edge, scroll (and keep the drop gap under the finger).
  const dragging = drag !== null
  useEffect(() => {
    if (!dragging) return
    let frame = 0
    const tick = () => {
      const y = pointerY.current
      const speed = y < EDGE ? -(EDGE - y) / 4 : y > window.innerHeight - EDGE ? (y - window.innerHeight + EDGE) / 4 : 0
      if (speed) {
        window.scrollBy(0, speed)
        const gap = gapAt(y)
        setDrag((d) => (d && d.gap !== gap ? { ...d, gap } : d))
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [dragging])

  // ── rendering ──

  const n = selected.size
  const canUp = n > 0 && !sameOrder(moveUp(entries, isSel), entries)
  const canDown = n > 0 && !sameOrder(moveDown(entries, isSel), entries)

  return (
    <main className="page">
      <header className="bar">
        <h1>Passwords</h1>
        <button className="icon primary" onClick={() => setDialog({ kind: 'add' })} aria-label="Add a password" title="Add a password">
          <IconPlus />
        </button>
      </header>

      {entries.length > 0 && (
        <div className="toolbar">
          <label className="check-all">
            <input type="checkbox" checked={allSelected} onChange={toggleAll}
              ref={(el) => { if (el) el.indeterminate = n > 0 && !allSelected }} />
            {n > 0 ? `${n} selected` : 'Select'}
          </label>
          <span className="spacer" />
          <button className="icon" disabled={!canUp} onClick={() => applyOrder(moveUp(entries, isSel))} aria-label="Move selection up" title="Move up">
            <IconUp />
          </button>
          <button className="icon" disabled={!canDown} onClick={() => applyOrder(moveDown(entries, isSel))} aria-label="Move selection down" title="Move down">
            <IconDown />
          </button>
          <button className="icon" disabled={n === 0} onClick={() => setDialog({ kind: 'delete' })} aria-label="Delete selection" title="Delete">
            <IconTrash />
          </button>
        </div>
      )}

      {error && <p className="error" onClick={() => setError(null)}>{error}</p>}

      {entries.length === 0 ? (
        <p className="empty">No passwords yet. Add one with the + button; only its hash will be kept.</p>
      ) : (
        <ul className={`list${drag ? ' dragging' : ''}`}>
          {entries.map((entry, i) => (
            <li key={entry.id}
              ref={(el) => { el ? rowRefs.current.set(entry.id, el) : rowRefs.current.delete(entry.id) }}
              className={[
                'row',
                selected.has(entry.id) && 'selected',
                drag?.ids.has(entry.id) && 'moving',
                drag && drag.gap === i && 'drop-before',
                drag && drag.gap === entries.length && i === entries.length - 1 && 'drop-after',
              ].filter(Boolean).join(' ')}>
              <span className="grip" aria-label="Drag to reorder" title="Drag to reorder"
                onPointerDown={(e) => startDrag(e, entry.id)} onPointerMove={moveDrag}
                onPointerUp={(e) => endDrag(e, false)} onPointerCancel={(e) => endDrag(e, true)}>
                <IconGrip />
              </span>
              <input type="checkbox" className="row-check" checked={selected.has(entry.id)} onChange={() => {}}
                onClick={(e) => onCheckboxClick(e, entry.id)} onContextMenu={(e) => onCheckboxContext(e, entry.id)}
                aria-label={`Select ${entry.label}`} />
              <button className="label" onClick={() => onOpen(entry.id)}>{entry.label}</button>
              <button className="icon ghost" onClick={() => setDialog({ kind: 'edit', entry })} aria-label={`Edit ${entry.label}`} title="Edit">
                <IconEdit />
              </button>
            </li>
          ))}
        </ul>
      )}

      {entries.length > 1 && (
        <p className="hint footer-hint">
          Shift-click or long-press a checkbox to toggle every row from the previous one. Drag ⠿ to reorder.
        </p>
      )}

      {dialog?.kind === 'add' && (
        <EditDialog onClose={() => setDialog(null)}
          onSave={async (label, password) => setEntries(await api.add(label, password!))} />
      )}
      {dialog?.kind === 'edit' && (
        <EditDialog entry={dialog.entry} onClose={() => setDialog(null)}
          onSave={async (label, password) => setEntries(await api.update(dialog.entry.id, label, password))} />
      )}
      {dialog?.kind === 'delete' && (
        <ConfirmDialog title="Delete passwords"
          message={`Delete ${n === 1 ? 'the selected password' : `the ${n} selected passwords`}? This can't be undone.`}
          confirmText="Delete" onClose={() => setDialog(null)}
          onConfirm={async () => setEntries(await api.remove([...selected]))} />
      )}
    </main>
  )
}
