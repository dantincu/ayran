import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useReducer, useRef, useState } from 'react'
import { Redo2, Undo2 } from 'lucide-react'
import IconButton from './IconButton'
import { UndoHistory } from '../lib/undoHistory'
import { highlight, languageOf, type Language } from '../lib/highlight'
import { editorLinkHandlers, type LinkHandler } from '../lib/textLinks'
import { applyTab, indentUnit } from '../lib/editorIndent'
import { subscribeEditorSettings, type EditorSettings } from '../lib/editorSettings'
import { useChord } from '../lib/chords'

interface Props {
  value: string
  onChange: (value: string) => void
  /** The file's name: what it is highlighted as (Markdown, HTML — anything else is plain). */
  fileName: string
  /** What to do with a link the caret is in when the person asks to open it (the clipboard menu offers it when this is set). */
  onOpenLink?: LinkHandler
  readOnly?: boolean
  /** Which language to use, when it isn't the file name's. */
  language?: Language
}

/** What a ref to `CodeEditor` gives its parent: inserting text at the caret (or over the selection) from the
 * outside — "Insert a path…" is the one caller today. Goes through the same `applyEdit` every real keystroke
 * does, so it's one undo step and the caret ends up right after what was inserted, exactly like typing it. */
export interface CodeEditorHandle {
  insertAtCursor: (text: string) => void
}

/** Above this many characters, the highlighted copy is redrawn a moment after typing stops rather than on every
 * keystroke (see `useHighlighted` below) — a plain, uncoloured file of any size still types at full speed either
 * way, since the *textarea itself* is never what's slow; only the coloured copy's own recomputation is. */
const HIGHLIGHT_DEBOUNCE_THRESHOLD = 20_000
const HIGHLIGHT_DEBOUNCE_MS = 150

/** The highlighted copy of `value`, recomputed on every change for a short text, or — once it's long enough that a
 * full re-scan on every keystroke would be felt — a moment after the person pauses instead. Reported live as
 * per-keystroke lag on a large file, worse the longer the editor had been open and gone once it was reopened: this
 * is the actual per-keystroke cost that scales with the file's size (`highlight()` re-scanning the *entire* text
 * every time, synchronously, inside the same render the keystroke caused) — not the `onChange`/`onKeyDown`
 * handlers themselves (plain React props, attached once, not reattached per stroke — the browser's own devtools
 * profiler is what actually showed `highlight()` as the time going missing, not a hunch). The undo history
 * (`lib/undoHistory.ts`) retaining up to 500 steps / 16 MB of a big file is a separate, likely contributor to the
 * "gets worse over time, better after reopening" pattern — the more the browser has to keep alive, the more it
 * eventually pauses to collect it — but its bounds are deliberate (documented, tested) and were left alone; only
 * the highlight recomputation, which had no bound on how often it ran, was changed. */
function useHighlighted(value: string, language: Language): string {
  const compute = (text: string) => highlight(text, language) + (text.endsWith('\n') ? ' ' : '')
  const [html, setHtml] = useState(() => compute(value))
  useEffect(() => {
    if (value.length < HIGHLIGHT_DEBOUNCE_THRESHOLD) {
      setHtml(compute(value))
      return
    }
    const timer = setTimeout(() => setHtml(compute(value)), HIGHLIGHT_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [value, language])
  return html
}

/** The one text editor of the app's file views: a `textarea` — so everything a text box does (selection, the clipboard
 * menu, the on-screen keyboard, drafts) stays as it is — with **syntax highlighting** drawn behind it (`lib/highlight.ts`).
 *
 * The highlighted copy of the text sits under the box, which has the same font, padding and wrapping and a transparent
 * text; the box is as tall as its text and the frame around both scrolls, so nothing has to be kept in step but the
 * height. (The layer is a picture: it can't be selected or focused, and screen readers skip it.)
 *
 * **Undo and redo** — two buttons above the text (and Ctrl+Z, Ctrl+Y / Ctrl+Shift+Z) — go through the editor's own history
 * (`lib/undoHistory.ts`), which covers everything that changes the text through `onChange`, the clipboard menu's paste
 * included. A text replaced from outside (a file read again) starts a new history.
 *
 * **Tab and Shift+Tab indent and outdent** (`lib/editorIndent.ts`; `lib/editorSettings.ts` for the settings — a literal
 * tab or a configurable number of spaces, and whether line numbers/wrapping/whitespace show, each a global setting
 * every editor in the app shares). Reported live: Tab used to just move the focus to the next control, because a plain
 * `textarea` doesn't intercept it — the browser's own default action has to be prevented and the indentation inserted
 * by hand, which also means the undo history and the caret position are kept in step exactly as a real keystroke would.
 * **Ctrl+K, 2 / Ctrl+K, 4** insert two or four tab-units at once (a quick multi-level indent), the same way.
 *
 * **A ref gives a caller `insertAtCursor`** (`CodeEditorHandle`, above) — "Insert a path…" (`NoteEditPage.tsx`,
 * `NotesApp.tsx`'s file editor, `FilesTab.tsx`'s) is the one user of it today. */
const CodeEditor = forwardRef<CodeEditorHandle, Props>(function CodeEditor({ value, onChange, fileName, onOpenLink, readOnly, language }, ref) {
  const frameRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const history = useRef<UndoHistory | null>(null)
  if (history.current === null) history.current = new UndoHistory(value)
  const [, redraw] = useReducer((n: number) => n + 1, 0)
  const restoreCaret = useRef<{ start: number; end: number } | null>(null)
  const html = useHighlighted(value, language ?? languageOf(fileName))
  const [settings, setSettings] = useState<EditorSettings | null>(null)
  useEffect(() => subscribeEditorSettings(setSettings), [])

  // The box is as tall as its text (or the frame, when the text is shorter, so a press anywhere in the frame is in the box).
  const fit = () => {
    const input = inputRef.current
    const frame = frameRef.current
    if (!input || !frame) return
    input.style.height = '0px'
    input.style.height = `${Math.max(input.scrollHeight, frame.clientHeight)}px`
  }
  useLayoutEffect(fit, [value])
  // A text that isn't the one the history stands at came from outside: it starts a new history. And after an undo or redo the
  // caret goes where the text it brought back had it.
  useLayoutEffect(() => {
    const h = history.current!
    if (h.current.value !== value) {
      h.reset(value)
      redraw()
    }
    const caret = restoreCaret.current
    if (caret && inputRef.current && inputRef.current.value === value) {
      inputRef.current.setSelectionRange(caret.start, caret.end)
      restoreCaret.current = null
    }
  }, [value])
  const step = (direction: 'undo' | 'redo') => {
    const h = history.current!
    const snapshot = direction === 'undo' ? h.undo() : h.redo()
    if (!snapshot) return
    restoreCaret.current = { start: snapshot.start, end: snapshot.end }
    inputRef.current?.focus()
    onChange(snapshot.value)
    redraw()
  }
  useEffect(() => {
    const frame = frameRef.current
    if (!frame || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(fit)
    observer.observe(frame)
    return () => observer.disconnect()
  }, [])

  // The clipboard menu offers "Open link" for a box that has a handler.
  useEffect(() => {
    const input = inputRef.current
    if (!input || !onOpenLink) return
    editorLinkHandlers.set(input, onOpenLink)
    return () => {
      editorLinkHandlers.delete(input)
    }
  }, [onOpenLink])

  /** Applies a Tab/Shift+Tab edit the same way a real keystroke would: recorded in the undo history, the parent told,
   * and the caret put back where the edit leaves it once the new value has rendered. */
  function applyEdit(edit: { value: string; start: number; end: number }) {
    history.current!.record(edit.value, edit.start, edit.end, Date.now())
    restoreCaret.current = { start: edit.start, end: edit.end }
    onChange(edit.value)
    redraw()
  }

  useImperativeHandle(ref, () => ({
    insertAtCursor(text) {
      const input = inputRef.current
      const start = input?.selectionStart ?? value.length
      const end = input?.selectionEnd ?? value.length
      applyEdit({ value: value.slice(0, start) + text + value.slice(end), start: start + text.length, end: start + text.length })
      input?.focus()
    },
  }))

  const focused = () => document.activeElement === inputRef.current
  useChord(
    '2',
    "Insert 2 tabs' indentation at the caret (or indent the lines selected)",
    () => {
      const input = inputRef.current
      const unit = indentUnit(settings?.tabInsertsSpaces ?? false, settings?.tabSpaceCount ?? 4)
      if (input) applyEdit(applyTab(value, input.selectionStart, input.selectionEnd, unit.repeat(2), false))
    },
    focused,
  )
  useChord(
    '4',
    "Insert 4 tabs' indentation at the caret (or indent the lines selected)",
    () => {
      const input = inputRef.current
      const unit = indentUnit(settings?.tabInsertsSpaces ?? false, settings?.tabSpaceCount ?? 4)
      if (input) applyEdit(applyTab(value, input.selectionStart, input.selectionEnd, unit.repeat(4), false))
    },
    focused,
  )

  const h = history.current!
  // One line-number per `\n`-separated line, as a single block of text sharing the exact font/line-height/top-padding
  // of the two text layers, so line N's number sits beside line N's text — *while lines don't wrap*: a gutter can only
  // show one number per source line, so a line long enough to wrap (when "wrap long lines" is on) pulls every number
  // after it out of step with the text beside it. A known, accepted trade-off of drawing the gutter in plain CSS
  // beside a single native `textarea` rather than measuring each wrapped row's own height.
  const lineCount = value.split('\n').length
  const gutterDigits = Math.max(2, String(lineCount).length)
  return (
    <div className="code-editor-wrap">
      {!readOnly && (
        <div className="code-editor-toolbar">
          <IconButton icon={Undo2} label="Undo (Ctrl+Z)" onClick={() => step('undo')} disabled={!h.canUndo} onMouseDown={(e) => e.preventDefault()} />
          <IconButton icon={Redo2} label="Redo (Ctrl+Y)" onClick={() => step('redo')} disabled={!h.canRedo} onMouseDown={(e) => e.preventDefault()} />
        </div>
      )}
      {/* The clipboard menu's button sits at the corner of the frame, not of the (tall) box. */}
      <div className={`code-editor ${settings?.wrapLines === false ? 'code-editor-nowrap' : ''}`} ref={frameRef} data-text-menu-anchor>
        <div className="code-editor-rows">
          {settings?.lineNumbers !== false && (
            <pre className="code-editor-gutter" aria-hidden="true" style={{ minWidth: `${gutterDigits}ch` }}>
              {Array.from({ length: lineCount }, (_, i) => i + 1).join('\n')}
            </pre>
          )}
          <div className="code-editor-content">
            <pre className={`code-editor-highlight ${settings?.showWhitespace ? 'code-editor-show-whitespace' : ''}`} aria-hidden="true" dangerouslySetInnerHTML={{ __html: html }} />
            <textarea
              ref={inputRef}
              className="code-editor-input"
              value={value}
              readOnly={readOnly}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              onChange={(e) => {
                history.current!.record(e.target.value, e.target.selectionStart, e.target.selectionEnd, Date.now())
                onChange(e.target.value)
                redraw()
              }}
              onKeyDown={(e) => {
                if (readOnly) return
                if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) {
                  e.preventDefault()
                  const unit = indentUnit(settings?.tabInsertsSpaces ?? false, settings?.tabSpaceCount ?? 4)
                  applyEdit(applyTab(value, e.currentTarget.selectionStart, e.currentTarget.selectionEnd, unit, e.shiftKey))
                  return
                }
                if (!(e.ctrlKey || e.metaKey) || e.altKey) return
                const key = e.key.toLowerCase()
                if (key === 'z' && !e.shiftKey) step('undo')
                else if (key === 'y' || (key === 'z' && e.shiftKey)) step('redo')
                else return
                e.preventDefault()
              }}
            />
          </div>
        </div>
      </div>
    </div>
  )
})

export default CodeEditor
