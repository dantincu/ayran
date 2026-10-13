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
 * **`value` doesn't have to be the whole file.** `CodeEditor.tsx`'s own virtualized rendering only ever keeps a
 * bounded *window* of lines as real DOM, and calls this with that window's own text whenever the window itself
 * changes or its content is edited — correct for exactly the same reason it's always been correct for a whole
 * small file: nothing here assumes anything about what, if anything, exists outside `highlightEl`'s own
 * content. A window is small enough that measuring it fresh, in full, on every change needs no incremental
 * reuse at all (see `carryForwardRows`'s own doc comment for the fuller story, and why a *previous* version of
 * this module had one specifically for this function, before windowing made it unnecessary).
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
  // **Every position this function measures is expressed in one consistent coordinate system: rows counted from
  // the *content* box's own top, never the padding/border box's.** Before virtualization `highlightEl` held
  // nothing but `value` itself, so its border-box top *was* its content's top (no padding at all) and this
  // distinction never mattered. The editor's own windowing (`CodeEditor.tsx`) now gives the element a
  // `paddingTop`/`paddingBottom` representing everything *outside* the window (so the frame's real scrollable
  // height stays correct regardless of the window's own size — see that component's own doc comment on
  // `windowBottomPaddingPx`) — which moves the real text down by `paddingTop` and inflates `scrollHeight` by
  // `paddingTop + paddingBottom`. Both are accounted for here: `contentTop` is offset past the padding before any
  // row is measured from it, and `totalRows` has both paddings subtracted back out, so the two stay in the same
  // "rows since the content started" units `rows.push(next - rowStarts[i])`'s own subtraction below assumes.
  // **Found live, not by inspection, as a second regression from the same `paddingBottom` fix**: a version that
  // got `totalRows` right (subtracting both paddings) but left `rowOf`'s own reference point at the unmoved
  // border-box top still broke — every *ordinary* row's delta still cancelled correctly (both ends of the
  // subtraction shared the same, consistent-if-offset border-box reference), but the window's own *last* line's
  // delta (`totalRows - rowStarts[last]`) mixed a padding-free `totalRows` against a padding-*laden* `rowStarts`,
  // coming out wildly wrong — and, carried forward uncorrected by `carryForwardRows` on the very next edit,
  // compounding further with every edit after that (reported live as "typing one letter changes the entire
  // gutter numbering before the cursor"). A file with no padding at all (the small-file, non-windowed case, or
  // any caller that never sets one) measures identically either way — `paddingTop`/`paddingBottom` are then `0`.
  const cs = getComputedStyle(highlightEl)
  const paddingTop = parseFloat(cs.paddingTop) || 0
  const paddingBottom = parseFloat(cs.paddingBottom) || 0
  const contentTop = highlightEl.getBoundingClientRect().top + paddingTop
  const range = document.createRange()
  const rowOf = (px: number) => Math.round((px - contentTop) / lineHeightPx)
  const totalRows = Math.max(1, Math.round((highlightEl.scrollHeight - paddingTop - paddingBottom) / lineHeightPx))
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

/** The pure, DOM-free half of reusing a line's own row count across an edit: which lines at the start and end
 * of `value` are provably unchanged from `previousValue`, carrying their known row counts forward from
 * `previousRows` at their new (possibly shifted, if lines were inserted or deleted) indices. Every line in
 * between — the "changed" range — is left at `1`, the same "not yet known" default `computeRowsPerLine`'s own
 * fallback already uses before any real measurement exists; this function never touches the DOM at all, so it
 * cannot be the one to replace that default with a real count.
 *
 * **Why a *separate*, DOM-free function, where an earlier version of this module measured the changed range
 * directly (`computeRowsPerLineIncremental`, since removed).** That version assumed `highlightEl` always held
 * the *entire* document, so it could resolve a changed line's own position by walking straight into the live
 * DOM. Once the editor's own rendering became virtualized (`CodeEditor.tsx` — only a window of lines around
 * what's visible is ever real DOM), that assumption stopped holding: `highlightEl` now holds only a bounded
 * window's worth of text, so a changed line *outside* that window has nothing in the DOM to measure at all —
 * and a window's own content is small enough that measuring it fresh, in full, costs nothing worth optimizing
 * further (see `computeRowsPerLine`'s own doc comment for why windowing removed the need for *any* incremental
 * reuse within one window). What's left genuinely DOM-free — figuring out *which* row counts can simply be
 * carried over by position, regardless of whether anything is currently rendered to measure the rest — is
 * exactly this function, kept because `CodeEditor.tsx` still needs it to correctly shift the *off-window*
 * portion of its own lazily-measured row array across an edit that inserts or deletes lines; the row-count data
 * for the current window itself is simply overwritten with a fresh `computeRowsPerLine` call afterward.
 *
 * **Finds the unchanged run by the longest common prefix/suffix of the two raw *strings*, never by splitting
 * either one into an array of line strings first** (a still-earlier version did exactly that — `diffLines`,
 * also since removed — paying for two whole-file `String.split('\n')` allocations on every call; reported live
 * as a real, measured regression before being replaced with the character-level scan below, which needs none).
 * A line only counts as unchanged once its *entire* span — including its own trailing `\n` — falls inside the
 * matched prefix/suffix (`countLeadingUnchangedLines`/`countTrailingUnchangedLines`, each a binary search over
 * `lineStartOffsets`, not a scan): a half-matched line, where the common prefix ends partway through it, must
 * still be treated as changed.
 *
 * **Three correctness gaps were caught by a dedicated Node stress test before any of this ever reached a
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
 * Returns `null` when there's nothing of `previousValue`'s own to carry forward productively (`previousRows`
 * not matching its own line count — shouldn't happen, but a concurrent edit mid-measurement could race one) —
 * the caller then has nothing to do but start a fresh, all-`1` array instead. */
export function carryForwardRows(previousValue: string, previousRows: number[], value: string): number[] | null {
  // `lineStartOffsets(previousValue).length` is the same count `previousValue.split('\n').length` would give, at
  // a fraction of the cost: a single pass counting `\n`s, no substring allocated for a single one of its lines.
  const previousLineCount = lineStartOffsets(previousValue).length
  if (previousLineCount !== previousRows.length) return null
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

  const rows = new Array<number>(starts.length).fill(1)
  for (let i = 0; i < prefixLines; i++) rows[i] = previousRows[i]
  for (let i = 0; i < suffixLines; i++) rows[starts.length - 1 - i] = previousRows[previousRows.length - 1 - i]
  return rows
}

/** The largest `i` with `starts[i] <= target` (clamped to `0` for a target before the first entry) — a plain
 * binary search over any ascending array, the shared shape both `lineAtOffset` and `computeWindowRange`'s own
 * row-to-line lookup need, just against two different kinds of `starts` array (character offsets, or pixel
 * rows). */
function lastIndexAtMost(starts: number[], target: number): number {
  let lo = 0
  let hi = starts.length - 1
  let result = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (starts[mid] <= target) {
      result = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return result
}

/** The line (0-based) that character offset `offset` falls inside, against `starts` (`lineStartOffsets`'s own
 * output — sorted ascending, one entry per line, the character position it starts at). */
export function lineAtOffset(starts: number[], offset: number): number {
  return lastIndexAtMost(starts, offset)
}

/** A 0-based, end-*exclusive* line range: `[startLine, endLine)`. */
export interface WindowRange {
  startLine: number
  endLine: number
}

/** The line range `CodeEditor.tsx`'s virtualized rendering should materialize real DOM for right now — the
 * lines visible in `[scrollTop, scrollTop + clientHeight)`, padded by `bufferScreens` worth of *screens* on
 * each side (a "screen" being however many rows fit in `clientHeight`), clamped to the document's own bounds.
 * Pure arithmetic plus two binary searches over the already-computed `starts` array — no DOM, nothing to
 * measure here, which is deliberate: *deciding* which lines to render must never itself cost what rendering
 * them would have. Doesn't decide *whether* to actually adopt the result over whatever's currently
 * rendered — that's the caller's own hysteresis check (`CodeEditor.tsx`), so a one-pixel scroll doesn't thrash
 * a rebuild of a many-hundred-line window every tick; this function only ever answers "what would the ideal
 * window be, right now." A zero-line document, or a `lineHeightPx` that hasn't resolved yet (`<= 0`), answers
 * with the whole (empty, or not-yet-measurable) range — the same "nothing to window yet" fallback the rest of
 * this module already uses before a real measurement exists. */
export function computeWindowRange(
  scrollTop: number,
  clientHeight: number,
  lineHeightPx: number,
  starts: number[],
  bufferScreens: number,
): WindowRange {
  const lineCount = starts.length
  if (lineCount === 0) return { startLine: 0, endLine: 0 }
  if (!lineHeightPx || lineHeightPx <= 0) return { startLine: 0, endLine: lineCount }
  const visibleRows = Math.max(1, clientHeight / lineHeightPx)
  const bufferRows = Math.max(0, bufferScreens) * visibleRows
  const topRow = scrollTop / lineHeightPx
  const startLine = lastIndexAtMost(starts, Math.max(0, topRow - bufferRows))
  const endLine = Math.min(lineCount, lastIndexAtMost(starts, topRow + visibleRows + bufferRows) + 1)
  return { startLine, endLine: Math.max(startLine + 1, endLine) }
}

/** Widens `range` backward (decreasing `startLine`, never touching `endLine`) until its *character* span —
 * not just its line-index span, which `computeWindowRange` already guarantees is non-empty — covers at least
 * one real character, clamped at `0`. Call this on every `computeWindowRange` result before adopting it.
 *
 * **Why this is needed at all**: `computeWindowRange`'s own row-to-line lookup is only as good as `starts`
 * itself — and `starts` is built from *estimated* row counts for any line not yet actually measured (the
 * accepted "assume 1 row until visited, self-correct" trade-off — see `CodeEditor.tsx`'s own module doc). A
 * fast scroll through a long, heavily-wrapping, largely unmeasured stretch of a file can leave the *real*
 * `scrollTop` (driven by the always-accurate, unvirtualized `<textarea>`) corresponding to a `topRow` far
 * past what the *estimated* `starts` array accounts for — `lastIndexAtMost` then has nothing left to find
 * past the array's own last entry and correctly, faithfully returns the very last line, clamped. **Found
 * live, not by inspection**: reported as "if I scroll very fast and then stop, I start seeing a blank editor…
 * if I then scroll just a little, I again see what I should" — reproduced with a real, fast CDP wheel-event
 * burst (never a synthetic `scrollTop` assignment, which doesn't exercise the same under-measured-estimate
 * path a genuine fast scroll does) on a large file whose last line is the common, unremarkable "document ends
 * with a trailing newline" shape: the clamped last line *is* that trailing, zero-length line, so the window
 * `computeWindowRange` picked was **exactly one line long and that line has no characters at all** —
 * `windowStartChar === windowEndChar`, an empty slice, so `RunPatchController` has nothing to render and the
 * overlay sits genuinely blank — confirmed directly (not inferred): `pre.textContent.length === 0` immediately
 * after a real fast burst, and **still `0` a full 1.3 seconds later with no further input**, ruling out a
 * transient render-lag race that would have self-corrected on its own — matching "stays blank until I scroll a
 * little" precisely, since nothing *else* re-triggers `computeWindowRange` until the next `scroll` event does.
 *
 * Widening backward is the direct, minimal fix for the *symptom* (never show literally nothing) without
 * touching the underlying estimate/measurement machinery at all: the widened window still shows whichever
 * *real*, already-known lines sit just before the degenerate tail, which is far closer to "you can see
 * something, and scrolling resolves the rest" than a blank screen — the same spirit as the already-accepted
 * scrollbar-proportion trade-off, just extended to guarantee *some* real content rather than *correctly
 * positioned* content, until the next real measurement (or scroll) corrects the position too. */
export function widenIfCharsEmpty(range: WindowRange, lineStarts: number[], totalChars: number): WindowRange {
  let { startLine, endLine } = range
  const endChar = endLine < lineStarts.length ? lineStarts[endLine] : totalChars
  while (startLine > 0 && (lineStarts[startLine] ?? totalChars) >= endChar) startLine--
  return { startLine, endLine }
}
