import { ChevronLeft, ChevronRight } from 'lucide-react'
import IconButton from './IconButton'
import { PAGE_SIZE_OPTIONS } from '../lib/listPageSize'

interface PaginationProps {
  /** 0-indexed. Clamp this yourself before using it to slice — Pagination clamps
   * only its own display, it doesn't report a corrected value back. */
  page: number
  pageSize: number
  totalItems: number
  onPageChange: (page: number) => void
  onPageSizeChange: (size: number) => void
}

export default function Pagination({ page, pageSize, totalItems, onPageChange, onPageSizeChange }: PaginationProps) {
  if (totalItems === 0) return null

  const pageCount = Math.max(1, Math.ceil(totalItems / pageSize))
  const current = Math.min(Math.max(page, 0), pageCount - 1)
  const start = current * pageSize + 1
  const end = Math.min(totalItems, (current + 1) * pageSize)

  return (
    <div className="pagination">
      <span className="muted pagination-range">
        {start}–{end} of {totalItems}
      </span>
      <div className="pagination-controls">
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
        <span className="muted pagination-page">
          {current + 1} / {pageCount}
        </span>
        <IconButton
          icon={ChevronRight}
          label="Next page"
          onClick={() => onPageChange(current + 1)}
          disabled={current >= pageCount - 1}
        />
      </div>
    </div>
  )
}
