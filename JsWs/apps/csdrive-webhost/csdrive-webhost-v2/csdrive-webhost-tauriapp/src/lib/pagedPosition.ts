/** Where a paginated list is, when that is saved (with the place it is the list of): as **the number of
 * records skipped** — never as a page number.
 *
 * The page size is one setting for the whole app (see listPageSize.ts), so it can change between the
 * moment a position is saved and the moment it is restored — and "page 3" only means the same records
 * for the same page size. The number of records skipped means the same records whatever the page size:
 * restored with another size, the page shown is the one that holds the first record that was on
 * screen. Every list that saves its position saves it this way. */

/** The number of records skipped to reach `page` (0-indexed) at `pageSize` records a page. */
export function offsetOfPage(page: number, pageSize: number): number {
  return Math.max(0, Math.floor(page)) * pageSize
}

/** The page (0-indexed) that holds the record at `offset` at `pageSize` records a page. It isn't clamped
 * to the list's length — the list clamps what it shows, as it always does. */
export function pageOfOffset(offset: number, pageSize: number): number {
  return Math.max(0, Math.floor(offset / pageSize))
}

/** A saved offset that can be used: a whole number, not negative — anything else is ignored. */
export function validOffset(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isInteger(raw) && raw > 0 ? raw : null
}
