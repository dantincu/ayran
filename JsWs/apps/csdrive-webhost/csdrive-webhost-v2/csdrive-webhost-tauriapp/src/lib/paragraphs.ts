/** Paragraphs of a plain text, for "select paragraphs" in the text editors (`components/TextFieldMenu.tsx`).
 *
 * A **paragraph** is a run of text between blank lines: two line breaks in a row, or more, with nothing but spaces and tabs
 * between them (a single line break doesn't end one — as in Markdown). The spaces and line breaks at the very start and end of
 * a paragraph aren't part of it, so selecting it never selects the blank space around it. */

export interface Range {
  start: number
  end: number
}

/** A run of blank lines: a line break, then — any number of times — spaces and tabs and another line break. */
const BLANK_LINES = /\r?\n[ \t]*(?:\r?\n[ \t]*)+/g

/** Every paragraph of `text`, in order, each without the whitespace around it. */
export function paragraphsOf(text: string): Range[] {
  const paragraphs: Range[] = []
  let from = 0
  const add = (start: number, end: number) => {
    while (start < end && /\s/.test(text[start])) start++
    while (end > start && /\s/.test(text[end - 1])) end--
    if (start < end) paragraphs.push({ start, end })
  }
  for (const gap of text.matchAll(BLANK_LINES)) {
    add(from, gap.index)
    from = gap.index + gap[0].length
  }
  add(from, text.length)
  return paragraphs
}

/** What "select paragraphs" selects when `selectionStart`–`selectionEnd` is the selection (or, collapsed, the caret): the
 * paragraph(s) that selection touches, entirely — from the start of the first to the end of the last, with the whitespace
 * before the first and after the last left out. A caret between two paragraphs takes the one before it (the first, if
 * there is none). With no paragraph at all (nothing but whitespace) the selection stays as it is. */
export function selectParagraphs(text: string, selectionStart: number, selectionEnd: number): Range {
  const start = Math.min(selectionStart, selectionEnd)
  const end = Math.max(selectionStart, selectionEnd)
  const paragraphs = paragraphsOf(text)
  if (paragraphs.length === 0) return { start, end }

  const touched = paragraphs.filter((p) => (start === end ? p.start <= start && start <= p.end : p.end > start && p.start < end))
  if (touched.length > 0) return { start: touched[0].start, end: touched[touched.length - 1].end }

  // Nothing touched (the caret is in a gap, or the selection is only whitespace between paragraphs): the one before it.
  const before = paragraphs.filter((p) => p.end <= start)
  return before.length > 0 ? before[before.length - 1] : paragraphs[0]
}
