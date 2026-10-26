import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { LucideIcon } from 'lucide-react'
import { fastNavAmount, PAGE_JUMP } from '../lib/keyboard'

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

/** The menu's own real, focusable `<button role="menuitem">`s — disabled ones excluded, the same `:not(:disabled)` filter
 * `buttonRowKeyboard.ts`'s `buttonsIn` already uses for a row of icon buttons (this menu is a *list* of them, one per line,
 * so it moves by Up/Down rather than Left/Right, but is otherwise the identical kind of "real DOM focus, nothing virtual" row). */
function menuItemsIn(menu: HTMLElement): HTMLButtonElement[] {
  return Array.from(menu.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)'))
}

/** A menu of actions that opens where it was asked for — at a pointer, or at a button — and closes on a choice, on Escape, or
 * on a press or a scroll anywhere else. **Keyboard-navigable** (asked for directly, for the new three-dots popovers — item 2's
 * own "readily navigable with arrows, pg up, pg down, Alt+N, Alt+P etc" — but this is the one `ContextMenu` every right-click/
 * long-press menu in the app already opens, so every one of them gets this for free too, not just the new callers): the first
 * enabled item takes real focus the moment the menu opens, and from there **Up/Down** move it by one, **Home/End** to the
 * first/last, **PageUp/PageDown** by `PAGE_JUMP`, and the same **fast-navigation** modifiers (`fastNavAmount`) every list and
 * row of buttons elsewhere already use move it by 2/5/20/50 — Enter/Space activating the focused item is the browser's own
 * default action on a real `<button>`, needing nothing from this module (the same reasoning `buttonRowKeyboard.ts`'s own doc
 * comment already gives for why a row of *real* buttons is simpler than a list's virtual focus). */
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

  // The first enabled item gets real focus once the menu has actually settled at its final position
  // (the layout effect above, not mount — focusing before `at` is corrected would still work, since focus
  // doesn't depend on position, but doing it in the same effect that already runs right after layout keeps
  // this in one place rather than a second, separate mount-only effect).
  useEffect(() => {
    menuItemsIn(ref.current!)[0]?.focus()
  }, [])

  function onKeyDown(e: React.KeyboardEvent) {
    const menu = ref.current
    if (!menu) return
    const fast = fastNavAmount(e.nativeEvent)
    let delta: number | null = fast
    if (delta === null) {
      switch (e.key) {
        case 'ArrowDown':
          delta = 1
          break
        case 'ArrowUp':
          delta = -1
          break
        case 'PageDown':
          delta = PAGE_JUMP
          break
        case 'PageUp':
          delta = -PAGE_JUMP
          break
        case 'Home':
          delta = -Infinity
          break
        case 'End':
          delta = Infinity
          break
        default:
          return
      }
    }
    e.preventDefault()
    e.stopPropagation()
    const buttons = menuItemsIn(menu)
    if (buttons.length === 0) return
    const current = Math.max(0, buttons.indexOf(document.activeElement as HTMLButtonElement))
    buttons[Math.min(buttons.length - 1, Math.max(0, current + delta))]?.focus()
  }

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
       * it). It closes on `onClick`, not `onPointerDown`: a real tap's `click` is a *separate* event that
       * follows `pointerdown` a moment later, with its target re-resolved by the browser at that moment against
       * whatever is in the DOM then — so closing (unmounting the backdrop) on `pointerdown` leaves nothing there
       * to catch the follow-up `click`, which lands on whatever is now exposed underneath and reopens exactly
       * the bug this backdrop exists to prevent, one event later (`preventDefault()` on `pointerdown` does NOT
       * stop this: found live on Android — the backdrop's `pointerdown` fired and closed the menu, but the
       * `click` that followed still reached the row underneath and reopened a menu there, making it look like
       * nothing had closed at all). Waiting for `onClick` instead means the backdrop is still mounted — still
       * the real element under the pointer — when the browser dispatches that click, so it is the backdrop
       * itself that receives and stops it; only then does closing remove it, with no event left to leak through.
       * (A synthetic `pointerdown` dispatched by a test script never reproduces this, since nothing then fires
       * the follow-up `click` a real tap or mouse click does — which is why an earlier, `pointerdown`-based
       * version of this fix passed a synthetic-event test but failed on real touch input.) */}
      <div className="context-menu-backdrop" onClick={(e) => { e.preventDefault(); e.stopPropagation(); onClose() }} />
      <div ref={ref} className="context-menu" role="menu" style={{ left: at.left, top: at.top }} data-no-text-menu onKeyDown={onKeyDown}>
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
