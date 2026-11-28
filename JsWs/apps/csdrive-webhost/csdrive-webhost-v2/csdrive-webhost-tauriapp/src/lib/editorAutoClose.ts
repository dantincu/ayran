/** Auto-closing brackets/quotes and "smart" indent on Enter for `components/CodeEditor.tsx`'s own built-in
 * editor (`HighlightedEditor`/`PlainTextEditor`) — pure text logic, no DOM, the same shape `editorIndent.ts`'s
 * own `applyTab` already has. **Neither Monaco nor CodeMirror needed any of this module** — both already do
 * all three things out of the box (confirmed live for Monaco with corrected CDP key dispatch, and by reading
 * `@codemirror/autocomplete`'s/`@codemirror/commands`'s actual installed source for CodeMirror, not assumed):
 * Monaco's own JS/TS language configuration already lists `autoClosingPairs` for every bracket and quote, and
 * its core editor already has a built-in "Enter between matching brackets gets a third line" fallback for any
 * language with `brackets` defined; CodeMirror's `basicSetup` already bundles `closeBrackets()` (its own
 * default `brackets` list is exactly `( [ { ' "`) and `defaultKeymap`'s `insertNewlineAndIndent`, whose own
 * `isBetweenBrackets`/`newlineAndIndent` implementation explicitly builds the identical three-line "explode"
 * insertion for `()`/`[]`/`{}`. Only the built-in editor — a plain `<textarea>` with no editor engine behind
 * it at all — needed any of this written by hand. See CLAUDE.md's "Auto-closing brackets and quotes, and
 * smart indent on Enter" for the full account, including the two Monaco behaviors (backspace deletes an empty
 * auto-inserted pair in one step; typing a closing bracket right before an identical one steps over it rather
 * than inserting a second one) this module also replicates, for the same reason: not asked for explicitly, but
 * confirmed live as part of Monaco's own default "auto-closing" feature, so leaving them out of the built-in
 * editor would have been a real, noticeable inconsistency between the three editors.
 *
 * **Deliberately not gated to any one language** — unlike the JS-specific 2-space indent (`editorIndent.ts`'s
 * `effectiveTabSettings`), nothing here checks `effectiveLanguage` at all: CodeMirror's own `closeBrackets()`
 * and `isBetweenBrackets`'s own fast-path regex (`/\(\)|\[\]|\{\}/`) are themselves not gated by language
 * either (confirmed by reading their source — the regex check runs before any language-specific lookup), and
 * "continuing whatever indent the current line already has" is a plain text convenience most editors apply
 * regardless of file type. The one JS-specific rule in the original ask is the indent *size*, not whether any
 * of this applies at all. */

export interface AutoCloseEdit {
  value: string
  start: number
  end: number
}

const PAIRS: Record<string, string> = { '(': ')', '[': ']', '{': '}' }
const CLOSERS = new Set(Object.values(PAIRS))
const QUOTES = new Set(["'", '"'])

/** What typing a single printable `key` should do, beyond the browser's own default single-character
 * insertion — `null` means "let the default happen" (an ordinary character, or an opening bracket/quote with
 * nothing special to react to that the caller should just let through, not actually reachable here since every
 * open bracket/quote always does *something*, but kept for a caller that wants one place to check "did this
 * character need special handling at all"). Any other result **replaces** the default insertion entirely, so
 * the caller must have already called `preventDefault()`. */
export function autoCloseEdit(value: string, selStart: number, selEnd: number, key: string): AutoCloseEdit | null {
  const isOpener = key in PAIRS || QUOTES.has(key)
  const hasSelection = selStart !== selEnd

  // An opening bracket or a quote, with text selected: wrap the selection instead of replacing it — the
  // "surround" behaviour that comes bundled with auto-closing in every editor that has it.
  if (hasSelection && isOpener) {
    const close = PAIRS[key] ?? key
    const selected = value.slice(selStart, selEnd)
    return { value: value.slice(0, selStart) + key + selected + close + value.slice(selEnd), start: selStart + 1, end: selEnd + 1 }
  }

  if (!hasSelection) {
    const nextChar = value[selEnd]
    // A closing bracket or a quote, typed right where the identical character already sits: step over it —
    // the same "finishing what was already closed" convenience, so this doesn't end up as a duplicate.
    if ((CLOSERS.has(key) || QUOTES.has(key)) && nextChar === key) {
      return { value, start: selEnd + 1, end: selEnd + 1 }
    }
    // An opening bracket or a quote, nothing selected and nothing to step over: insert the matching close
    // right after, caret landing between the two.
    if (isOpener) {
      const close = PAIRS[key] ?? key
      const caret = selStart + 1
      return { value: value.slice(0, selStart) + key + close + value.slice(selEnd), start: caret, end: caret }
    }
  }

  return null
}

/** Backspace, with a collapsed caret sitting directly between a matching pair this module itself (or typing
 * it by hand) just produced with nothing in between (`(|)`, `[|]`, `{|}`, `'|'`, `"|"`) — deletes both
 * characters in one step rather than leaving the lone closing one behind. `null` for every other case (a
 * selection, or anything else): the caller should let the browser's own default Backspace run. */
export function autoCloseBackspaceEdit(value: string, selStart: number, selEnd: number): AutoCloseEdit | null {
  if (selStart !== selEnd || selStart === 0) return null
  const before = value[selStart - 1]
  const after = value[selStart]
  const matches = PAIRS[before] === after || (QUOTES.has(before) && after === before)
  if (!matches) return null
  return { value: value.slice(0, selStart - 1) + value.slice(selStart + 1), start: selStart - 1, end: selStart - 1 }
}

/** What pressing Enter at a collapsed caret, or with a selection (replaced the same way typing any other
 * character over a selection would), should insert — always computed, since a plain textarea's own default
 * Enter is just a bare `"\n"` with no indentation at all. Mirrors Monaco's and CodeMirror's own default
 * "electric" Enter: a caret directly between a matching bracket pair gets a *third* line, the closing
 * bracket pushed down to the original line's own indent with a new, one-level-deeper line in between;
 * everywhere else, the new line simply continues whatever indentation the current line already has. */
export function smartEnterEdit(value: string, selStart: number, selEnd: number, unit: string): AutoCloseEdit {
  const before = value.slice(0, selStart)
  const after = value.slice(selEnd)
  const lineStart = before.lastIndexOf('\n') + 1
  const currentIndent = /^[ \t]*/.exec(before.slice(lineStart))![0]

  const adjacent = before.slice(-1) + after.slice(0, 1)
  if (adjacent === '()' || adjacent === '[]' || adjacent === '{}') {
    const middle = `\n${currentIndent}${unit}`
    const closing = `\n${currentIndent}`
    const caret = selStart + middle.length
    return { value: before + middle + closing + after, start: caret, end: caret }
  }

  const insertion = `\n${currentIndent}`
  const caret = selStart + insertion.length
  return { value: before + insertion + after, start: caret, end: caret }
}
