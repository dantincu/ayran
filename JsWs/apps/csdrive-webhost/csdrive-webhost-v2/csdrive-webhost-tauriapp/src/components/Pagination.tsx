import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import IconButton from './IconButton'
import { PAGE_SIZE_OPTIONS } from '../lib/listPageSize'
import { isShortcut, overlayOpen, PAGE_LIST_LETTER, shortcutLabel } from '../lib/keyboard'

interface PaginationProps {
  /** 0-indexed. Clamp this yourself before using it to slice — Pagination clamps
   * only its own display, it doesn't report a corrected value back. */
  page: number
  pageSize: number
  totalItems: number
  onPageChange: (page: number) => void
  onPageSizeChange: (size: number) => void
}

/** How the page list was opened: with the keyboard shortcut (it then has a box to type the page
 * number in) or by pressing the page indicator with a finger or the mouse (just the list). */
type Opened = 'keyboard' | 'pointer'

export default function Pagination({ page, pageSize, totalItems, onPageChange, onPageSizeChange }: PaginationProps) {
  const [opened, setOpened] = useState<Opened | null>(null)
  const [typed, setTyped] = useState('')
  const [invalid, setInvalid] = useState(false)
  // The page the keyboard is on inside the list (drawn with an outline; Enter goes to it) — it starts at the
  // current page and the arrow keys move it.
  const [cursor, setCursor] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const cursorRef = useRef<HTMLButtonElement>(null)

  const pageCount = Math.max(1, Math.ceil(totalItems / pageSize))
  const current = Math.min(Math.max(page, 0), pageCount - 1)
  // What the key handler below (registered once per opening) needs to see fresh.
  const live = useRef({ cursor, typed, pageCount, goTo: (_index: number) => {} })
  live.current = { cursor, typed, pageCount, goTo }

  // The shortcut opens the page list, with the box for typing a page number.
  const shown = totalItems > 0
  useEffect(() => {
    if (!shown) return
    function onKeyDown(e: KeyboardEvent) {
      if (!isShortcut(e, PAGE_LIST_LETTER)) return
      if (overlayOpen() && !document.querySelector('.page-popover')) return // a dialog has the keys
      e.preventDefault()
      setTyped('')
      setInvalid(false)
      setCursor(current)
      setOpened('keyboard')
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [shown, current])

  /** Where the cursor goes for a key, or null if the key isn't one of the list's. The rows of page numbers
   * are read from where the buttons really are (the ones sharing the first button's top make the first row),
   * so Up/Down and PageUp/PageDown move by whole rows whatever the width and font make of the grid. */
  function cursorFor(key: string): number | null {
    const { cursor: at, pageCount: count } = live.current
    const last = count - 1
    switch (key) {
      case 'ArrowLeft':
        return Math.max(0, at - 1)
      case 'ArrowRight':
        return Math.min(last, at + 1)
      case 'Home':
        return 0
      case 'End':
        return last
      case 'ArrowUp':
      case 'ArrowDown':
      case 'PageUp':
      case 'PageDown': {
        const grid = gridRef.current
        const buttons = grid ? Array.from(grid.querySelectorAll<HTMLElement>('.page-popover-item')) : []
        if (!grid || buttons.length === 0) return at
        const firstTop = buttons[0].offsetTop
        let columns = 0
        while (columns < buttons.length && buttons[columns].offsetTop === firstTop) columns++
        if (columns >= buttons.length) return at // one row: nothing above or below
        const pitch = buttons[columns].offsetTop - firstTop // the height of a row, with the gap
        const rows = Math.ceil(buttons.length / columns)
        const half = Math.max(1, Math.floor(grid.clientHeight / 2 / pitch)) // half the height of the list, in rows
        const delta = key === 'ArrowUp' ? -1 : key === 'ArrowDown' ? 1 : key === 'PageUp' ? -half : half
        const row = Math.min(rows - 1, Math.max(0, Math.floor(at / columns) + delta))
        return Math.min(last, row * columns + (at % columns)) // the same column; on a shorter last row, its last page
      }
      default:
        return null
    }
  }

  // Open: Escape or a press outside closes it; the arrow keys, Home/End and PageUp/PageDown move the cursor
  // (whether or not the box for typing a number is there — it only takes digits, so its own caret keys aren't
  // missed); Enter goes to the page the cursor is on when no number has been typed.
  useEffect(() => {
    if (opened === null) return
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpened(null)
        return
      }
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return
      const target = cursorFor(e.key)
      if (target !== null) {
        e.preventDefault()
        e.stopPropagation()
        setCursor(target)
        return
      }
      if (e.key === 'Enter' && live.current.typed === '' && !(document.activeElement instanceof HTMLElement && document.activeElement.closest('.page-popover-item'))) {
        e.preventDefault()
        e.stopPropagation()
        live.current.goTo(live.current.cursor)
      }
    }
    function onPress(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpened(null)
    }
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('mousedown', onPress)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('mousedown', onPress)
    }
  }, [opened])

  // The popover is placed against the *screen* (position: fixed), not the button, so that it can be as tall as
  // the screen: it sits above the button when it fits there, and otherwise slides down as far as it must,
  // always inside the screen (less the system bars' insets on a phone). Measured after every render while open
  // — the number of pages changes its height — and again when the window is resized.
  useLayoutEffect(() => {
    if (opened === null) return
    function place() {
      const popover = popoverRef.current
      const anchor = rootRef.current
      if (!popover || !anchor) return
      const inset = (side: string) => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--csdrive-safe-area-inset-' + side)) || 0
      const margin = 8
      const top = margin + inset('top')
      const bottom = window.innerHeight - margin - inset('bottom')
      const left = margin + inset('left')
      const right = window.innerWidth - margin - inset('right')
      const box = anchor.getBoundingClientRect()
      const height = popover.offsetHeight
      const width = popover.offsetWidth
      // Above the button (its bottom edge 6px over the button), pulled down if that would leave the screen.
      const wanted = box.top - 6 - height
      popover.style.top = Math.max(top, Math.min(wanted, bottom - height)) + 'px'
      // Its right edge under the button's, kept inside the screen.
      popover.style.left = Math.max(left, Math.min(box.right - width, right - width)) + 'px'
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  })

  // The cursor stays in view as it moves (and at first, on the current page).
  useEffect(() => {
    if (opened !== null) cursorRef.current?.scrollIntoView({ block: 'nearest' })
  }, [opened, cursor])

  if (totalItems === 0) return null

  const start = current * pageSize + 1
  const end = Math.min(totalItems, (current + 1) * pageSize)

  function goTo(index: number) {
    setOpened(null)
    if (index !== current) onPageChange(index)
  }

  function submitTyped() {
    const n = Number(typed)
    if (!Number.isInteger(n) || n < 1 || n > pageCount) {
      setInvalid(true)
      return
    }
    goTo(n - 1)
  }

  return (
    <div className="pagination">
      <span className="muted pagination-range">
        {start}–{end} of {totalItems}
      </span>
      <div className="pagination-controls" ref={rootRef}>
        <select
          className="pagination-size"
          value={pageSize}
          onChange={(e) => onPageSizeChange(Number(e.target.value))}
          aria-label="Items per page"
        >
          {PAGE_SIZE_OPTIONS.map((n) => (
            <option key={n} value={n}>
              {n} / page
            </option>
          ))}
        </select>
        <IconButton
          icon={ChevronLeft}
          label="Previous page"
          onClick={() => onPageChange(current - 1)}
          disabled={current === 0}
        />
        <button
          type="button"
          className="muted pagination-page pagination-page-button"
          title={`All pages (${shortcutLabel(PAGE_LIST_LETTER)})`}
          aria-haspopup="dialog"
          aria-expanded={opened !== null}
          onClick={() => {
            setTyped('')
            setInvalid(false)
            setCursor(current)
            setOpened((o) => (o === null ? 'pointer' : null))
          }}
        >
          {current + 1} / {pageCount}
        </button>
        <IconButton
          icon={ChevronRight}
          label="Next page"
          onClick={() => onPageChange(current + 1)}
          disabled={current >= pageCount - 1}
        />

        {opened !== null && (
          <div className="page-popover" role="dialog" aria-label="Go to page" ref={popoverRef} data-no-text-menu>
            {opened === 'keyboard' && (
              <input
                autoFocus
                className={`page-popover-input ${invalid ? 'invalid' : ''}`}
                inputMode="numeric"
                placeholder={`Page 1–${pageCount}, then Enter`}
                aria-label="Page number"
                value={typed}
                onChange={(e) => {
                  const digits = e.target.value.replace(/\D/g, '')
                  setTyped(digits)
                  setInvalid(false)
                  const n = Number(digits)
                  if (digits !== '' && n >= 1 && n <= pageCount) setCursor(n - 1) // the list follows what is typed
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    submitTyped()
                  }
                }}
              />
            )}
            <div className="page-popover-grid" ref={gridRef}>
              {Array.from({ length: pageCount }, (_, i) => (
                <button
                  key={i}
                  type="button"
                  ref={i === cursor ? cursorRef : undefined}
                  className={`page-popover-item ${i === current ? 'current' : ''} ${i === cursor ? 'cursor' : ''}`}
                  aria-current={i === current ? 'page' : undefined}
                  onClick={() => goTo(i)}
                >
                  {i + 1}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
