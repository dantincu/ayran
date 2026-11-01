/** Increasing/decreasing the blockquote level of the selected (or current) lines in a markdown file — item 4
 * of the todo. Pure text logic, no DOM, the same shape as `editorIndent.ts`'s own `applyTab` — but simpler:
 * a blockquote marker always belongs at a line's own *start*, never wherever the caret happens to sit within
 * it, so unlike `applyTab`'s "insert at the caret" special case for a single-line, collapsed selection, this
 * always works on whole lines, for both directions. */

const QUOTE_PREFIX = '> '

/** Removes one leading `>` from `line` — its own one trailing space too, if there is one — or returns it
 * unchanged if it doesn't start with one (the same "nothing to do" shape `applyTab`'s own outdent already has
 * for a line with no matching prefix). A doubly (or more) nested quote (`>> text`, `> > text`) loses exactly
 * one level either way: the first `>` found, and at most one space after it. */
function unquoteLine(line: string): string {
  if (!line.startsWith('>')) return line
  return line.slice(1).startsWith(' ') ? line.slice(2) : line.slice(1)
}

export interface QuoteEdit {
  /** Where the affected lines begin — right after the previous `\n`, or 0. */
  rangeStart: number
  /** Where they end — right before the next `\n`, or the text's own length. */
  rangeEnd: number
  /** Replaces `value.slice(rangeStart, rangeEnd)`. */
  replacement: string
  /** Where the selection should be afterward, in the whole document's own coordinates. */
  start: number
  end: number
}

/** Increases (`decrease: false`) or decreases the quote level of every line the selection `[start, end)`
 * touches — the whole of each one, from the start of the first to the end of the last, even when the
 * selection only partly covers either end. Increasing always prepends `"> "` to every touched line (so
 * nesting it twice reads as `"> > text"`, itself valid markdown for a two-level quote — not the more compact
 * `">> text"`, which this never produces but `unquoteLine` above still correctly unwinds one level of either
 * shape). Decreasing removes one marker only from the lines that actually have one, leaving the rest exactly
 * as they are — the same per-line independence `applyTab`'s own outdent already has. */
export function applyQuoteLevel(value: string, start: number, end: number, decrease: boolean): QuoteEdit {
  const rangeStart = value.lastIndexOf('\n', start - 1) + 1
  const nextBreak = value.indexOf('\n', Math.max(end - 1, rangeStart))
  const rangeEnd = nextBreak === -1 ? value.length : nextBreak
  const lines = value.slice(rangeStart, rangeEnd).split('\n')

  let startDelta = 0
  let totalDelta = 0
  const changed = lines.map((line, i) => {
    const result = decrease ? unquoteLine(line) : QUOTE_PREFIX + line
    const delta = result.length - line.length
    if (i === 0) startDelta = delta
    totalDelta += delta
    return result
  })

  return {
    rangeStart,
    rangeEnd,
    replacement: changed.join('\n'),
    start: Math.max(rangeStart, start + startDelta),
    end: Math.max(rangeStart, end + totalDelta),
  }
}
