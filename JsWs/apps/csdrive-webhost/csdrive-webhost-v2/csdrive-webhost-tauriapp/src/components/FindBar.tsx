import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, X } from 'lucide-react'
import IconButton from './IconButton'
import { findMatches, matchIndexNear, type FindMatch } from '../lib/textFind'

interface Props {
  text: string
  /** Where the very first jump lands from — the caret's own offset at the moment the bar opened, so the
   * first match found is the nearest one from where the person actually was, not always the file's own
   * first occurrence. */
  anchorOffset: number
  /** The caret's own selected text when the bar opened, if any — pre-filled into the query box, the same
   * "search for what I already had selected" convention every other Ctrl+F already follows. */
  initialQuery?: string
  onJumpToMatch: (match: FindMatch) => void
  onClose: () => void
}

/** A find bar for this app's own built-in editor (`HighlightedEditor`/`PlainTextEditor` in `CodeEditor.tsx`) —
 * asked for directly: "searches both by plain text and by regex (with a checkbox toggling between the two)."
 * Monaco and CodeMirror, the app's two *third-party* editors, already ship their own complete find/replace
 * widgets (regex toggle included — see `MonacoCodeEditor.tsx`'s and `MobileCodeMirrorEditor.tsx`'s own module
 * docs for how each is reached), so this is deliberately scoped to the one editor that had nothing at all: a
 * query box, the checkbox, Previous/Next, a match count, and Close — no Replace, which wasn't asked for here.
 *
 * **The current match is shown by the editor's own native text *selection*** (`onJumpToMatch` ends up calling
 * `setSelectionRange` on the real `<textarea>`, which already paints a visible selection highlight on top of
 * the syntax-coloured layer behind it — exactly how dragging to select text already looks in this editor) —
 * not a second, independent "highlight every match" overlay. `RunPatchController` (`lib/runPatchController.ts`)
 * owns every node under the highlighted `<pre>` exclusively, by design, so it isn't a safe target for this bar
 * to also paint into; reusing the box's own existing selection mechanism needed no change to that at all. */
export default function FindBar({ text, anchorOffset, initialQuery, onJumpToMatch, onClose }: Props) {
  const [query, setQuery] = useState(initialQuery ?? '')
  const [useRegex, setUseRegex] = useState(false)
  const [currentIndex, setCurrentIndex] = useState<number | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  // The anchor only matters for the very first jump after the query/mode itself changes — Next/Previous move
  // it forward as the person navigates, so re-anchoring after typing more lands near where they last were,
  // not always back at the original caret.
  const anchorRef = useRef(anchorOffset)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const { matches, error } = findMatches(text, query, useRegex)

  useEffect(() => {
    const next = matchIndexNear(matches, anchorRef.current, 'forward')
    setCurrentIndex(next)
    if (next !== null) onJumpToMatch(matches[next])
    // Deliberately scoped to the query/mode changing, not to every render this component gets while the
    // document itself is being edited elsewhere (the bar can stay open while that happens) — jumping, and so
    // moving the real selection, on every unrelated keystroke outside this box would fight whatever the
    // person is actually doing there. `matches` is already current for this render's own `query`/`useRegex`
    // by the time this runs (computed moments earlier, in the very same render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, useRegex])

  function go(direction: 1 | -1) {
    if (matches.length === 0) return
    const next = currentIndex === null ? 0 : (currentIndex + direction + matches.length) % matches.length
    setCurrentIndex(next)
    anchorRef.current = matches[next].start
    onJumpToMatch(matches[next])
  }

  const countText = error ? error : query === '' ? '' : matches.length === 0 ? 'No matches' : `${(currentIndex ?? 0) + 1} of ${matches.length}`

  return (
    <div className="code-editor-find-bar">
      <input
        ref={inputRef}
        className="code-editor-find-input"
        type="text"
        placeholder="Find"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            go(e.shiftKey ? -1 : 1)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onClose()
          }
        }}
      />
      <label className="code-editor-find-regex">
        <input type="checkbox" checked={useRegex} onChange={(e) => setUseRegex(e.target.checked)} />
        Regex
      </label>
      <span className={`code-editor-find-count ${error ? 'code-editor-find-error' : ''}`}>{countText}</span>
      <IconButton icon={ChevronUp} label="Previous match (Shift+Enter)" onClick={() => go(-1)} disabled={matches.length === 0} />
      <IconButton icon={ChevronDown} label="Next match (Enter)" onClick={() => go(1)} disabled={matches.length === 0} />
      <IconButton icon={X} label="Close (Esc)" onClick={onClose} />
    </div>
  )
}
