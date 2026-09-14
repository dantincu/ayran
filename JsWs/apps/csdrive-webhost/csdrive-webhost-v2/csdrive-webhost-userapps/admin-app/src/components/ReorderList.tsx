import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronUp, GripVertical } from 'lucide-react'
import IconButton from './IconButton'

interface ReorderListProps<T> {
  items: T[]
  getId: (item: T) => string
  renderItem: (item: T) => ReactNode
  onChange: (items: T[]) => void
}

/** A reorderable list: drag-and-drop for mouse users, plus a selection + up/down-arrow
 * mechanism that also works on touch (holding an arrow repeats the move ~10x/sec).
 * Selected items move together as a block, preserving their relative order. */
export default function ReorderList<T>({ items, getId, renderItem, onChange }: ReorderListProps<T>) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const dragIndex = useRef<number | null>(null)
  const holdTimer = useRef<number | null>(null)

  // Kept current every render so the setInterval callback in startHold always acts
  // on the latest props/state instead of a stale snapshot from when the hold began.
  const latest = useRef({ items, selected, getId, onChange })
  latest.current = { items, selected, getId, onChange }

  useEffect(() => {
    const ids = new Set(items.map(getId))
    setSelected((prev) => {
      let changed = false
      const next = new Set<string>()
      prev.forEach((id) => {
        if (ids.has(id)) next.add(id)
        else changed = true
      })
      return changed ? next : prev
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items])

  useEffect(() => stopHold, [])

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function moveOnce(direction: 'up' | 'down') {
    const { items: curItems, selected: curSelected, getId: curGetId, onChange: curOnChange } = latest.current
    if (curSelected.size === 0) return
    const arr = curItems.slice()
    if (direction === 'up') {
      for (let i = 1; i < arr.length; i++) {
        if (curSelected.has(curGetId(arr[i])) && !curSelected.has(curGetId(arr[i - 1]))) {
          const tmp = arr[i - 1]
          arr[i - 1] = arr[i]
          arr[i] = tmp
        }
      }
    } else {
      for (let i = arr.length - 2; i >= 0; i--) {
        if (curSelected.has(curGetId(arr[i])) && !curSelected.has(curGetId(arr[i + 1]))) {
          const tmp = arr[i + 1]
          arr[i + 1] = arr[i]
          arr[i] = tmp
        }
      }
    }
    curOnChange(arr)
  }

  function stopHold() {
    if (holdTimer.current !== null) {
      window.clearInterval(holdTimer.current)
      holdTimer.current = null
    }
  }

  function startHold(direction: 'up' | 'down') {
    stopHold()
    moveOnce(direction)
    holdTimer.current = window.setInterval(() => moveOnce(direction), 100)
  }

  function handleDrop(targetIndex: number) {
    const from = dragIndex.current
    dragIndex.current = null
    if (from === null || from === targetIndex) return
    const arr = items.slice()
    const [moved] = arr.splice(from, 1)
    arr.splice(targetIndex, 0, moved)
    onChange(arr)
  }

  return (
    <div className="reorder-list">
      <div className="reorder-list-controls">
        <span className="muted">{selected.size === 0 ? 'Select items to reorder' : `${selected.size} selected`}</span>
        <div className="toolbar-actions">
          <IconButton
            icon={ChevronUp}
            label="Move up"
            disabled={selected.size === 0}
            onMouseDown={() => startHold('up')}
            onMouseUp={stopHold}
            onMouseLeave={stopHold}
            onTouchStart={(e) => {
              e.preventDefault()
              startHold('up')
            }}
            onTouchEnd={stopHold}
          />
          <IconButton
            icon={ChevronDown}
            label="Move down"
            disabled={selected.size === 0}
            onMouseDown={() => startHold('down')}
            onMouseUp={stopHold}
            onMouseLeave={stopHold}
            onTouchStart={(e) => {
              e.preventDefault()
              startHold('down')
            }}
            onTouchEnd={stopHold}
          />
        </div>
      </div>
      <ul className="reorder-items">
        {items.map((item, index) => {
          const id = getId(item)
          return (
            <li
              key={id}
              className={`reorder-item ${selected.has(id) ? 'selected' : ''}`}
              draggable
              onDragStart={() => {
                dragIndex.current = index
              }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => handleDrop(index)}
            >
              <label className="reorder-item-select">
                <input type="checkbox" checked={selected.has(id)} onChange={() => toggle(id)} />
              </label>
              <GripVertical size={14} strokeWidth={2} className="reorder-grip" aria-hidden="true" />
              <div className="reorder-item-content">{renderItem(item)}</div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
