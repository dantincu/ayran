/** Where each source line of `value` actually starts on screen once "wrap long lines" has wrapped it across
 * several visual rows — the line-number gutter's own correctness depends on this, since it draws one number per
 * *source* line but must place each one beside the row that line's text actually begins on, not just `(index *
 * lineHeight)` down the page.
 *
 * **Why this can't be a character-count calculation.** The font is monospace, so it's tempting to compute
 * `Math.ceil(lineLength / charsPerRow)` from the box's own pixel width — but `white-space: pre-wrap` wraps at
 * *word* boundaries (the last space before the width limit), not at an exact character count: a line whose last
 * word would cross the limit wraps *earlier* than a plain division predicts, so an arithmetic guess is wrong
 * exactly often enough to be worse than useless (confidently wrong, not obviously approximate). The only way to
 * know for certain is to ask the browser's own layout engine, which has already wrapped the text correctly in the
 * highlighted copy sitting right there in the DOM (`CodeEditor.tsx`'s `.code-editor-highlight`).
 *
 * **How it's measured.** `highlight()`'s own invariant (its module doc) is that the *text content* of its output
 * is exactly its input, character for character, only ever wrapped in `<span>` tags — so a plain `TreeWalker`
 * over `highlightEl`'s real text nodes reads back exactly `value`, in order, regardless of how many `tok-*` spans
 * (or `markWhitespace`'s own, for "show whitespace") the syntax highlighting nested it in. Walking it once finds
 * the (text node, offset-within-node) pair for the start of every source line; a single *collapsed* Range at each
 * of those positions (`getBoundingClientRect().top`) gives the exact pixel row that line starts on — accurate by
 * construction, since it's reading the measurement the browser's own wrapping already computed, not guessing at
 * it. */

/** The character offset (into `value`) that each source line starts at — line 0 always starts at 0. Pure and
 * trivial; split out so it's covered without a browser. */
export function lineStartOffsets(value: string): number[] {
  const starts = [0]
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '\n') starts.push(i + 1)
  }
  return starts
}

/** For each offset in `offsets` (ascending, as `lineStartOffsets` produces), the real text node and the offset
 * within it that character position falls at — a single pass over `root`'s text nodes (`TreeWalker`), not one
 * walk per line, so the cost is proportional to the text's own length once, however many lines it has. An offset
 * past the end of all text (shouldn't happen for a valid `value`/`root` pair, but a concurrent edit mid-measurement
 * could race one) falls back to the very end of the last text node seen, rather than throwing. */
export function findTextPositions(root: Node, offsets: number[]): { node: Text; offset: number }[] {
  const positions: { node: Text; offset: number }[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let consumed = 0
  let next = 0
  let lastNode: Text | null = null
  let node = walker.nextNode() as Text | null
  while (node && next < offsets.length) {
    lastNode = node
    const len = node.data.length
    while (next < offsets.length && offsets[next] <= consumed + len) {
      positions.push({ node, offset: offsets[next] - consumed })
      next++
    }
    consumed += len
    node = walker.nextNode() as Text | null
  }
  while (next < offsets.length) {
    positions.push(lastNode ? { node: lastNode, offset: lastNode.data.length } : { node: document.createTextNode(''), offset: 0 })
    next++
  }
  return positions
}

/** One visual row count per source line of `value` (always `value.split('\n').length` entries, each `>= 1`),
 * measured from `highlightEl`'s own already-rendered DOM — see the module doc above. `lineHeightPx` is the box's
 * own resolved `line-height` (`parseFloat(getComputedStyle(...).lineHeight)`, the same value the editor's mirror-
 * scroll already reads). Returns `null` when there's nothing to measure against yet (`highlightEl` not mounted),
 * leaving the caller to fall back to "one row per line" until the next render provides it. */
export function computeRowsPerLine(highlightEl: HTMLElement, value: string, lineHeightPx: number): number[] | null {
  if (!lineHeightPx || lineHeightPx <= 0) return null
  const starts = lineStartOffsets(value)
  const positions = findTextPositions(highlightEl, starts)
  if (positions.length !== starts.length) return null
  const containerTop = highlightEl.getBoundingClientRect().top
  const range = document.createRange()
  const rowOf = (px: number) => Math.round((px - containerTop) / lineHeightPx)
  const rowStarts = positions.map(({ node, offset }) => {
    range.setStart(node, Math.min(offset, node.data.length))
    range.collapse(true)
    return rowOf(range.getBoundingClientRect().top)
  })
  const totalRows = Math.max(1, rowOf(containerTop + highlightEl.scrollHeight))
  const rows: number[] = []
  for (let i = 0; i < rowStarts.length; i++) {
    const next = i + 1 < rowStarts.length ? rowStarts[i + 1] : totalRows
    rows.push(Math.max(1, next - rowStarts[i]))
  }
  return rows
}
