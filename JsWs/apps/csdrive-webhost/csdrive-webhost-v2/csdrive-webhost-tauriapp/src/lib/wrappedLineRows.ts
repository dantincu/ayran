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
 * leaving the caller to fall back to "one row per line" until the next render provides it.
 *
 * **Measures each line's own *span* (`[lineStart, lineEnd)`, including its own terminating `\n`), never a
 * *collapsed* (zero-width) `Range` sitting at the bare offset** — found live, reported as a line's number
 * landing dozens of rows away from where its content actually begins: a collapsed `Range`'s own
 * `getBoundingClientRect()` can come back as an all-zero rect (`{top: 0, ...}`), with **zero** entries in
 * `getClientRects()` too, at certain boundary positions a caret has no well-defined box to report for — the one
 * directly confirmed live is the start of a genuinely *blank* line (a position sitting between two consecutive
 * `\n` characters, with nothing else around for the browser to anchor a caret rect to). `rowOf` then turns that
 * stray `0` into a wildly wrong row index for *that* line — and since each line's own row *count* is the delta
 * between two consecutive row-*starts*, the damage lands on the **next** line's count too (a `-9` row-start next
 * to a correct `+3` one computes a bogus 12-row gap), which is what actually produced the reported "hundreds of
 * rows." A **non-collapsed** range spanning real content — even content that renders with no visible glyph of
 * its own, like a bare `\n` — always has at least one real client rect (confirmed live against the exact
 * degenerate position above: a one-character range covering just that `\n` reports a correct, non-zero rect),
 * so reading `getClientRects()[0]` instead removes the failure mode at its root rather than special-casing the
 * one blank-line shape found live — any other position a collapsed `Range` might fail at the same way is
 * covered by the same fix, not just that one. Every line but the very last always has at least one character to
 * measure this way (its own `\n`, at minimum) — **only** the implicit, truly empty trailing "line" after a
 * final newline (or an empty file entirely) can have a genuinely zero-length span, which can't wrap by
 * definition, so it's taken as exactly one row ending at the very bottom (`totalRows - 1`) with no measurement
 * attempted at all, rather than risking the one case nothing could reliably measure anyway. */
export function computeRowsPerLine(highlightEl: HTMLElement, value: string, lineHeightPx: number): number[] | null {
  if (!lineHeightPx || lineHeightPx <= 0) return null
  const starts = lineStartOffsets(value)
  // One extra offset at the very end so each line's *end* position (needed to build a non-collapsed range) is
  // just the next line's own start — already in `positions` — except for the last line, whose end is this one
  // new entry.
  const allOffsets = [...starts, value.length]
  const positions = findTextPositions(highlightEl, allOffsets)
  if (positions.length !== allOffsets.length) return null
  const containerTop = highlightEl.getBoundingClientRect().top
  const range = document.createRange()
  const rowOf = (px: number) => Math.round((px - containerTop) / lineHeightPx)
  const totalRows = Math.max(1, rowOf(containerTop + highlightEl.scrollHeight))
  const rowStarts = starts.map((_, i) => {
    if (allOffsets[i] === allOffsets[i + 1]) return totalRows - 1 // the empty trailing line only — see doc above
    const start = positions[i]
    const end = positions[i + 1]
    range.setStart(start.node, start.offset)
    range.setEnd(end.node, end.offset)
    const rects = range.getClientRects()
    return rowOf(rects.length > 0 ? rects[0].top : range.getBoundingClientRect().top)
  })
  const rows: number[] = []
  for (let i = 0; i < rowStarts.length; i++) {
    const next = i + 1 < rowStarts.length ? rowStarts[i + 1] : totalRows
    rows.push(Math.max(1, next - rowStarts[i]))
  }
  return rows
}

/** The largest `i` such that source line `i` (0-based, against `starts`) — its *entire* span, including its own
 * trailing `\n` — ends at or before `prefixLen`; i.e. how many leading lines are wholly inside a matched common
 * prefix of that many characters. A line that the prefix only reaches partway through doesn't count: the rest of
 * it could still differ. `starts` is sorted ascending, so a binary search finds this in `O(log lines)` rather
 * than a linear scan — pure and trivial, split out so it's covered without a browser, the same reason
 * `lineStartOffsets` itself is. */
export function countLeadingUnchangedLines(starts: number[], totalLength: number, prefixLen: number): number {
  let lo = 0
  let hi = starts.length - 1
  let count = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const lineEnd = mid + 1 < starts.length ? starts[mid + 1] : totalLength
    if (lineEnd <= prefixLen) {
      count = mid + 1
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return count
}

/** The mirror image of `countLeadingUnchangedLines`: how many *trailing* lines start at or after `suffixStart` —
 * i.e. lie wholly inside a matched common suffix starting there. Also a binary search, for the same reason. */
export function countTrailingUnchangedLines(starts: number[], suffixStart: number): number {
  let lo = 0
  let hi = starts.length - 1
  let count = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (starts[mid] >= suffixStart) {
      count = starts.length - mid
      hi = mid - 1
    } else {
      lo = mid + 1
    }
  }
  return count
}

/** Like `computeRowsPerLine`, but reuses the row *count* of every line that's provably unchanged between
 * `previousValue` and `value` instead of asking the browser to measure it again — a line's own row count depends
 * only on its own text and the box's own width, never on where it sits in the document, so a line that's
 * genuinely identical in both texts keeps exactly the count it already had. Only the genuinely changed run in the
 * middle (almost always just the one or few lines actually being typed in, on an ordinary edit) is measured at
 * all.
 *
 * **Why this matters**: `computeRowsPerLine`'s own cost is one `Range.getClientRects()` call *per source line* —
 * fine for a short file, measurably slow for a big one (reported live, on a file with many thousands of lines:
 * "every time a new line is added, all line numbers disappear for a few seconds then show again correctly," the
 * synchronous measurement blocking the main thread for however long thousands of individual layout-forcing calls
 * take, well past the debounce that already protects the *dispatch* of this work — see `CodeEditor.tsx`'s own
 * `WRAP_MEASURE_DEBOUNCE_MS` doc comment for that separate, already-fixed cost). Reusing almost every line's
 * already-known count turns that per-edit cost from *O(the whole file)* into *O(the few lines that actually
 * changed)* — typically one — regardless of how long the file around them is.
 *
 * **Finds the unchanged run by the longest common prefix/suffix of the two raw *strings*, never by splitting
 * either one into an array of line strings first.** A first version of this function did exactly that —
 * `oldLines = previousValue.split('\n')`, `newLines = value.split('\n')`, then a per-line `===` comparison
 * (`diffLines`, since removed) — which was correct, but paid for two full `String.split('\n')` allocations, *and*
 * then the line-by-line comparison itself, proportional to the *whole file*, on every single debounced
 * remeasure, whatever the edit's own position. Reported live, after shipping, as "slower now... just as slow as
 * the default editor" on a real file — profiled and confirmed: those two splits (each allocating one substring
 * per line) were real, measurable, whole-file-sized overhead paid back on *every* remeasure, eating most of what
 * the incremental approach was meant to save, and (together with the missing `lineNumbers` gate above, in
 * `CodeEditor.tsx`) could leave this function no faster than simply remeasuring everything. Comparing the raw
 * strings character by character from each end, with **no allocation at all**, finds the exact same boundary at
 * the same (or better) cost for the common, localized-edit case — a handful of characters near one spot — while
 * removing the always-paid, whole-file-sized splitting cost entirely. A line only counts as unchanged once its
 * *entire* span — including its own trailing `\n` — falls inside the matched prefix/suffix
 * (`countLeadingUnchangedLines`/`countTrailingUnchangedLines`, each a binary search over `lineStartOffsets`, not
 * a scan): a half-matched line, where the common prefix ends partway through it, must still be remeasured, the
 * same rule the line-array version already enforced.
 *
 * **Three further correctness gaps were caught by a dedicated Node stress test before this ever reached a
 * browser** — comparing, over tens of thousands of randomized edits, how many leading/trailing lines this
 * approach trusts against what the old, slower line-array `diffLines` would have trusted, flagging any case
 * where *this* function trusted *more* (the only unsafe direction — trusting fewer is just a missed, harmless
 * optimization):
 * 1. **Value's own last line, specifically** — measured with `lineEnd = value.length` rather than a confirmed
 *    `starts[mid + 1]`, the one place `countLeadingUnchangedLines` can validate a line without a genuine `\n`
 *    backing it up. `prefixLen` reaching all the way to `value.length` doesn't by itself mean `previousValue`'s
 *    own structure beyond that point lines up the same way — `previousValue` can keep going (more characters,
 *    on the *same* line or a new one) in a way that makes its line at this same index a *different* line than
 *    value's own (now possibly truncated) last one. Concretely: `previousValue = "ab\ncd"`, `value = "ab\n"` —
 *    the confirmed 3-character prefix covers all of `value`, but `previousRows`'s line 1 is `"cd"`'s row count,
 *    not an empty line's. Guarded by requiring `previousValue.length === prefixLen` too whenever the leading
 *    count would otherwise reach every line of `value` — i.e. nothing of `previousValue` is left over past the
 *    confirmed match.
 * 2. **The suffix's mirror image**: the *outermost* (smallest-index) trailing line counted as unchanged is
 *    vulnerable in the same way, but only when its own start lands *exactly* on the matched suffix's edge — an
 *    interior boundary is always safe (the matched suffix content is identical on both sides, so any `\n`
 *    strictly inside it exists at the same relative position in both), but the very edge is the one place
 *    `previousValue`'s own corresponding position can fail to be a genuine line start too (landing mid-line
 *    there instead). Guarded by checking that `previousValue.length - suffixLen` is itself `0` or follows a
 *    `\n` in `previousValue` — the cheap, one-character check `previousBoundaryIsLineStart` makes, rather than
 *    computing a second full `lineStartOffsets` array just to confirm it.
 * 3. **Value's own implicit trailing line, specifically, on the suffix side** — if `value` ends with `\n` (or is
 *    empty), its one trailing empty "line" trivially satisfies `start >= suffixBoundary` for *any* `suffixLen`,
 *    including `0` (a wholly vacuous match confirming zero real characters) — and because a trailing run always
 *    includes the very last line the moment its count is `>= 1`, this one can't be fixed by capping the count
 *    the way gap 1 is; it has to be subtracted unconditionally whenever `value`'s last line is degenerate,
 *    before the edge check above even runs.
 *
 * **Only valid when nothing *else* that could change a reused line's own row count has changed since
 * `previousValue` was measured** — the box's own width, in particular (a width change can move where *every*
 * line wraps, unchanged text included), which is why the caller (`CodeEditor.tsx`) only takes this path for an
 * ordinary content edit and forces a full `computeRowsPerLine` instead whenever the frame itself was resized.
 * Falls back to a full `computeRowsPerLine` itself whenever there's nothing of `previousValue`'s own to diff
 * against productively (`previousRows` not matching its own line count — shouldn't happen, but a concurrent
 * edit mid-measurement could race one, the same defensive shape `findTextPositions` already takes for this
 * exact reason elsewhere in this module). */
export function computeRowsPerLineIncremental(
  highlightEl: HTMLElement,
  value: string,
  lineHeightPx: number,
  previousValue: string,
  previousRows: number[],
): number[] | null {
  if (!lineHeightPx || lineHeightPx <= 0) return null
  // `lineStartOffsets(previousValue).length` is the same count `previousValue.split('\n').length` would give, at
  // a fraction of the cost: a single pass counting `\n`s, no substring allocated for a single one of its lines.
  const previousLineCount = lineStartOffsets(previousValue).length
  if (previousLineCount !== previousRows.length) return computeRowsPerLine(highlightEl, value, lineHeightPx)
  const starts = lineStartOffsets(value)

  const maxCommonChars = Math.min(previousValue.length, value.length)
  let prefixLen = 0
  while (prefixLen < maxCommonChars && previousValue.charCodeAt(prefixLen) === value.charCodeAt(prefixLen)) prefixLen++
  let suffixLen = 0
  while (
    suffixLen < maxCommonChars - prefixLen &&
    previousValue.charCodeAt(previousValue.length - 1 - suffixLen) === value.charCodeAt(value.length - 1 - suffixLen)
  )
    suffixLen++

  let prefixLines = countLeadingUnchangedLines(starts, value.length, prefixLen)
  // Gap 1 above: only trust *every* line of `value` (including its last) when `previousValue` has nothing left
  // over past the confirmed prefix either.
  if (prefixLines === starts.length && previousValue.length !== prefixLen) prefixLines--

  let suffixLines = countTrailingUnchangedLines(starts, value.length - suffixLen)
  // Gap 3 above: `value`'s own trailing degenerate line (if it has one) is always the outermost line counted the
  // moment `suffixLines >= 1`, and always vacuously - exclude it unconditionally before the edge check below,
  // which only ever handles a *non*-degenerate outermost line landing exactly on the matched edge.
  const valueEndsDegenerate = starts.length > 0 && starts[starts.length - 1] === value.length
  if (valueEndsDegenerate) suffixLines = Math.max(0, suffixLines - 1)
  // Gap 2 above: the (possibly just-adjusted) outermost trailing line, only when its own start lands exactly on
  // the matched suffix's edge - an interior boundary needs no check at all (see this function's own doc comment).
  if (suffixLines > 0) {
    const outerStart = starts[starts.length - suffixLines]
    const suffixBoundary = value.length - suffixLen
    if (outerStart === suffixBoundary) {
      const previousBoundary = previousValue.length - suffixLen
      const previousBoundaryIsLineStart = previousBoundary === 0 || previousValue.charCodeAt(previousBoundary - 1) === 10 // '\n'
      if (!previousBoundaryIsLineStart) suffixLines--
    }
  }
  // Defensive, mirroring the bound the character-level scan above already keeps (`suffixLen < maxCommonChars -
  // prefixLen`): the two runs shouldn't be able to overlap, but never trust a reused line twice over one that
  // genuinely needs remeasuring.
  const maxLines = Math.min(starts.length, previousLineCount)
  if (prefixLines + suffixLines > maxLines) suffixLines = Math.max(0, maxLines - prefixLines)

  const rows = new Array<number>(starts.length)
  for (let i = 0; i < prefixLines; i++) rows[i] = previousRows[i]
  for (let i = 0; i < suffixLines; i++) rows[starts.length - 1 - i] = previousRows[previousRows.length - 1 - i]
  const changedStart = prefixLines
  const changedEndExclusive = starts.length - suffixLines // one past the last changed line
  if (changedStart >= changedEndExclusive) return rows // the prefix/suffix trim covered everything — nothing left to measure
  // One extra position, right after the changed run: either the first *unchanged* suffix line's own start (so the
  // changed run's own last line gets a correct "next row" boundary to measure its row *count* against — the row
  // immediately after it, exactly as `computeRowsPerLine`'s own `rowStarts[i+1]` does for an interior line), or
  // the true end of the document when the changed run reaches it (`totalRows`, below, is what that boundary
  // means then — the same convention `computeRowsPerLine` itself uses for its own true last line).
  const hasTrailingSuffix = changedEndExclusive < starts.length
  const changedLineStarts = starts.slice(changedStart, changedEndExclusive)
  const allOffsets = hasTrailingSuffix ? [...changedLineStarts, starts[changedEndExclusive]] : [...changedLineStarts, value.length]
  const positions = findTextPositions(highlightEl, allOffsets)
  if (positions.length !== allOffsets.length) return null
  const containerTop = highlightEl.getBoundingClientRect().top
  const range = document.createRange()
  const rowOf = (px: number) => Math.round((px - containerTop) / lineHeightPx)
  const totalRows = Math.max(1, rowOf(containerTop + highlightEl.scrollHeight))
  const rowStarts: number[] = []
  // The row *right after* the changed run's own last line — `rowStarts[i+1]` already gives this for every
  // *interior* changed line, but the last one has nothing of its own kind to compare against. When there's a
  // trailing suffix, that boundary is simply the last changed line's own final visual row plus one: a `\n` is
  // always a hard line break in a `<pre>`-rendered box, whatever wraps around it, so the row right after the
  // last character this line's own range covers (its own trailing `\n`) is, by construction, exactly the row
  // the next source line starts on — reusing the very same `getClientRects()` the loop below already calls for
  // that line's own row-*start*, rather than a second, separate measurement (which, at the exact position a new
  // line begins, risks the identical collapsed-range failure mode `computeRowsPerLine`'s own doc comment already
  // covers for a line's start — avoided here simply by never taking it).
  let sentinelRow = totalRows
  changedLineStarts.forEach((_, i) => {
    if (allOffsets[i] === allOffsets[i + 1]) {
      rowStarts.push(totalRows - 1) // the empty trailing line only — see `computeRowsPerLine`'s own doc comment
      return
    }
    const start = positions[i]
    const end = positions[i + 1]
    range.setStart(start.node, start.offset)
    range.setEnd(end.node, end.offset)
    const rects = range.getClientRects()
    rowStarts.push(rowOf(rects.length > 0 ? rects[0].top : range.getBoundingClientRect().top))
    if (hasTrailingSuffix && i === changedLineStarts.length - 1) {
      sentinelRow = rects.length > 0 ? rowOf(rects[rects.length - 1].top) + 1 : totalRows
    }
  })
  for (let i = 0; i < rowStarts.length; i++) {
    const next = i + 1 < rowStarts.length ? rowStarts[i + 1] : sentinelRow
    rows[changedStart + i] = Math.max(1, next - rowStarts[i])
  }
  return rows
}
