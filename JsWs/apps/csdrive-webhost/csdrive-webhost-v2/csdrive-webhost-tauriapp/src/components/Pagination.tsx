import { useEffect, useRef, useState } from 'react'
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
  const rootRef = useRef<HTMLDivElement>(null)
  const currentRef = useRef<HTMLButtonElement>(null)

  const pageCount = Math.max(1, Math.ceil(totalItems / pageSize))
  const current = Math.min(Math.max(page, 0), pageCount - 1)

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
      setOpened('keyboard')
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [shown])

  // Open: Escape or a press outside closes it, and the current page is scrolled into view.
  useEffect(() => {
    if (opened === null) return
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpened(null)
      }
    }
    function onPress(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpened(null)
    }
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('mousedown', onPress)
    currentRef.current?.scrollIntoView({ block: 'nearest' })
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('mousedown', onPress)
    }
  }, [opened])

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
          <div className="page-popover" role="dialog" aria-label="Go to page">
            {opened === 'keyboard' && (
              <input
                autoFocus
                className={`page-popover-input ${invalid ? 'invalid' : ''}`}
                inputMode="numeric"
                placeholder={`Page 1–${pageCount}, then Enter`}
                aria-label="Page number"
                value={typed}
                onChange={(e) => {
                  setTyped(e.target.value.replace(/\D/g, ''))
                  setInvalid(false)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    submitTyped()
                  }
                }}
              />
            )}
            <div className="page-popover-grid">
              {Array.from({ length: pageCount }, (_, i) => (
                <button
                  key={i}
                  type="button"
                  ref={i === current ? currentRef : undefined}
                  className={`page-popover-item ${i === current ? 'current' : ''}`}
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
