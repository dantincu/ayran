/** What the Tab and Shift+Tab keys do in `components/CodeEditor.tsx` — pure text logic, no DOM, so it's easy to get
 * right and to check. Reported live: pressing Tab moved the focus to the next control instead of typing anything,
 * because a `textarea` doesn't intercept it by itself — the browser's own default action (focus the next
 * focusable element) has to be prevented and the indentation inserted by hand. */

export interface TabEdit {
  value: string
  /** Where the selection should be afterward. */
  start: number
  end: number
}

/** The literal text one Tab key press inserts: a tab character, or `count` spaces (`editorSettings.ts`). */
export function indentUnit(tabInsertsSpaces: boolean, tabSpaceCount: number): string {
  return tabInsertsSpaces ? ' '.repeat(tabSpaceCount) : '\t'
}

/** Applies Tab (`outdent: false`) or Shift+Tab (`true`) to `value`, whose selection is `[start, end)`.
 *
 * A **collapsed caret or a selection within one line**, indenting: `unit` replaces the selection (or is inserted at
 * the caret), and the caret ends up right after it — the ordinary "type a character" case.
 *
 * **Every other case works on whole lines**: outdenting always does (there's nothing to insert at a caret), and a
 * selection spanning more than one line indents every line it touches rather than replacing the selection with a
 * single `unit`. Each touched line — from the start of the first one to the end of the last, even if the selection
 * itself starts or ends mid-line — gets `unit` added at its start (indent) or removed from its start (outdent: the
 * whole of `unit` if the line starts with exactly that, else whatever leading whitespace is there, up to `unit`'s
 * length — a line that isn't indented at all, or with something else entirely, is left alone). The selection is
 * adjusted to keep covering the same lines afterward. */
export function applyTab(value: string, start: number, end: number, unit: string, outdent: boolean): TabEdit {
  const singleLine = !value.slice(start, end).includes('\n')
  if (!outdent && singleLine) {
    const inserted = start + unit.length
    return { value: value.slice(0, start) + unit + value.slice(end), start: inserted, end: inserted }
  }

  const lineStart = value.lastIndexOf('\n', start - 1) + 1
  const nextBreak = value.indexOf('\n', Math.max(end - 1, lineStart))
  const lineEnd = nextBreak === -1 ? value.length : nextBreak
  const lines = value.slice(lineStart, lineEnd).split('\n')

  let startDelta = 0
  let totalDelta = 0
  const changed = lines.map((line, i) => {
    let delta: number
    let result: string
    if (outdent) {
      const removed = line.startsWith(unit) ? unit.length : (line.match(/^\s*/)?.[0].length ?? 0) < unit.length ? (line.match(/^\s*/)?.[0].length ?? 0) : unit.length
      result = line.slice(removed)
      delta = -removed
    } else {
      result = unit + line
      delta = unit.length
    }
    if (i === 0) startDelta = delta
    totalDelta += delta
    return result
  })

  const newValue = value.slice(0, lineStart) + changed.join('\n') + value.slice(lineEnd)
  return { value: newValue, start: Math.max(lineStart, start + startDelta), end: Math.max(lineStart, end + totalDelta) }
}
