import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { LucideIcon } from 'lucide-react'

export interface MenuItem {
  label: string
  icon?: LucideIcon
  onSelect: () => void
  disabled?: boolean
  danger?: boolean
  /** A line is drawn above it. */
  separated?: boolean
}

interface Props {
  items: MenuItem[]
  /** Where it opens (the corner is kept inside the window). */
  x: number
  y: number
  onClose: () => void
}

/** A menu of actions that opens where it was asked for — at a pointer, or at a button — and closes on a choice, on Escape, or
 * on a press or a scroll anywhere else. */
export default function ContextMenu({ items, x, y, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [at, setAt] = useState({ left: x, top: y })

  // Kept inside the window: moved left or up when it would run out at the right or the bottom.
  useLayoutEffect(() => {
    const menu = ref.current
    if (!menu) return
    const box = menu.getBoundingClientRect()
    setAt({
      left: Math.max(4, Math.min(x, window.innerWidth - box.width - 4)),
      top: Math.max(4, Math.min(y, window.innerHeight - box.height - 4)),
    })
  }, [x, y, items.length])

  useEffect(() => {
    // The backdrop below (a real element under the pointer, covering everything but the menu) is what
    // actually catches a press outside and closes the menu without it reaching whatever is behind it —
    // this listener only needs to catch a scroll/resize, and Escape from anywhere (a text box's own key
    // handling can stop it reaching here, which is why it's a capturing window listener, not the menu's own).
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('scroll', onClose, true)
    window.addEventListener('resize', onClose)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('scroll', onClose, true)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])

  return createPortal(
    <>
      {/* Transparent, covers the whole window beneath the menu: a press anywhere outside the menu lands on
       * this (not on whatever the menu happens to be sitting over), closing the menu without also acting on
       * that background element — the actual fix for "clicking outside also clicks through to what's under
       * the menu" (found live: closing the row-actions overflow menu this way could press the button under
       * it). `onPointerDown`, not `onClick`, so it can't be reached by a synthesized click from something else. */}
      <div className="context-menu-backdrop" onPointerDown={onClose} />
      <div ref={ref} className="context-menu" role="menu" style={{ left: at.left, top: at.top }} data-no-text-menu>
        {items.map((item) => {
          const Icon = item.icon
          return (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className={`${item.danger ? 'danger' : ''} ${item.separated ? 'separated' : ''}`}
              disabled={item.disabled}
              onClick={() => {
                onClose()
                item.onSelect()
              }}
            >
              {Icon && <Icon size={14} aria-hidden="true" />} {item.label}
            </button>
          )
        })}
      </div>
    </>,
    document.body,
  )
}

/** Props that make an element ask for its menu: a right click, and — on a touch screen, where there is none — a long press. */
export function contextTrigger(open: (x: number, y: number) => void) {
  let timer: number | undefined
  let start: { x: number; y: number } | null = null
  const cancel = () => {
    window.clearTimeout(timer)
    start = null
  }
  return {
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault()
      open(e.clientX, e.clientY)
    },
    onPointerDown: (e: React.PointerEvent) => {
      if (e.pointerType !== 'touch') return
      start = { x: e.clientX, y: e.clientY }
      timer = window.setTimeout(() => {
        if (start) open(start.x, start.y)
        start = null
      }, 550)
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) cancel()
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
  }
}
