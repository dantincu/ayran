import { useState, useRef, useEffect, useCallback } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'

interface PageSelectorProps {
  currentPage: number
  totalPages: number
  onPageChange: (page: number) => void
  onLoadMorePages?: (upToPage: number) => Promise<number>
}

export function PageSelector({
  currentPage,
  totalPages,
  onPageChange,
}: PageSelectorProps) {
  const [open, setOpen] = useState(false)
  const [inputValue, setInputValue] = useState(String(currentPage))
  const [highlighted, setHighlighted] = useState(currentPage)
  const popoverRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setInputValue(String(currentPage))
    setHighlighted(currentPage)
  }, [currentPage])

  const handleOpen = () => {
    setOpen(true)
    setInputValue(String(currentPage))
    setHighlighted(currentPage)
    setTimeout(() => {
      inputRef.current?.select()
      scrollToHighlighted(currentPage)
    }, 0)
  }

  const scrollToHighlighted = (page: number) => {
    const el = listRef.current?.querySelector(`[data-page="${page}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }

  const handleInputChange = (v: string) => {
    setInputValue(v)
    const n = parseInt(v)
    if (!isNaN(n) && n >= 1 && n <= totalPages) {
      setHighlighted(n)
      setTimeout(() => scrollToHighlighted(n), 0)
    }
  }

  const handleSelect = (page: number) => {
    onPageChange(page)
    setOpen(false)
  }

  const handleClickOutside = useCallback(
    (e: MouseEvent) => {
      if (open && popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    },
    [open]
  )

  useEffect(() => {
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [handleClickOutside])

  const getVisiblePages = () => {
    const pages: number[] = []
    const min = Math.max(1, highlighted - 10)
    const max = Math.min(totalPages, highlighted + 10)
    for (let i = min; i <= max; i++) pages.push(i)
    return pages
  }

  return (
    <div className="flex items-center gap-1">
      <button
        onClick={() => currentPage > 1 && onPageChange(currentPage - 1)}
        disabled={currentPage <= 1}
        className="p-1.5 rounded-md text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        title="Previous page"
      >
        <ChevronLeft size={16} />
      </button>

      <div className="relative" ref={popoverRef}>
        <button
          onClick={handleOpen}
          className="px-3 py-1 rounded-md text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors font-medium border border-gray-200 dark:border-gray-600"
          title="Go to page"
        >
          Page {currentPage}
          {totalPages > 0 && <span className="text-gray-400 dark:text-gray-500 font-normal"> / {totalPages}</span>}
        </button>

        {open && (
          <div className="absolute top-full mt-1 left-1/2 -translate-x-1/2 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-50 w-48">
            <div className="p-2 border-b border-gray-100 dark:border-gray-700">
              <input
                ref={inputRef}
                type="number"
                min={1}
                max={totalPages}
                value={inputValue}
                onChange={(e) => handleInputChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    const n = parseInt(inputValue)
                    if (!isNaN(n) && n >= 1 && n <= totalPages) handleSelect(n)
                  } else if (e.key === 'Escape') {
                    setOpen(false)
                  }
                }}
                className="w-full px-2 py-1 text-sm border border-gray-200 dark:border-gray-600 rounded-md focus:outline-none focus:ring-1 focus:ring-primary-400 text-center bg-white dark:bg-gray-700 text-gray-800 dark:text-gray-200"
                placeholder="Page #"
              />
            </div>
            <div ref={listRef} className="max-h-48 overflow-y-auto py-1">
              {getVisiblePages().map((page) => (
                <button
                  key={page}
                  data-page={page}
                  onClick={() => handleSelect(page)}
                  className={`w-full text-center py-1 text-sm transition-colors ${
                    page === highlighted
                      ? 'bg-primary-100 dark:bg-primary-900/30 text-primary-700 dark:text-primary-400 font-semibold'
                      : page === currentPage
                      ? 'bg-gray-50 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
                      : 'text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700'
                  }`}
                >
                  {page === currentPage && page !== highlighted ? `${page} (current)` : page}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <button
        onClick={() => currentPage < totalPages && onPageChange(currentPage + 1)}
        disabled={currentPage >= totalPages}
        className="p-1.5 rounded-md text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        title="Next page"
      >
        <ChevronRight size={16} />
      </button>
    </div>
  )
}
