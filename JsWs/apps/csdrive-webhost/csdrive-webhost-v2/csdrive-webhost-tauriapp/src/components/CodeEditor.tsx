import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react'
import { Redo2, Undo2 } from 'lucide-react'
import IconButton from './IconButton'
import { UndoHistory } from '../lib/undoHistory'
import { escapeHtml, highlight, languageOf, markWhitespace, tokenClassAtOffset, type Language } from '../lib/highlight'
import { HighlightScheduler } from '../lib/highlightScheduler'
import { editorLinkHandlers, type LinkHandler } from '../lib/textLinks'
import { applyTab, indentUnit } from '../lib/editorIndent'
import { subscribeEditorSettings, type EditorSettings } from '../lib/editorSettings'
import { useChord } from '../lib/chords'
import { computeRowsPerLine } from '../lib/wrappedLineRows'

/** Above this many lines, the line-number gutter falls back to one row per line (what it always showed before
 * wrapped-row measurement existed) rather than measuring — tens of thousands of `Range` queries would be a real
 * pause, not the brief background pass this is meant to be. */
const MAX_LINES_FOR_WRAP_MEASUREMENT = 20_000
/** The gutter's own fallback row height (one row per line) before a real measurement lands — `.code-editor-gutter`'s
 * font shorthand in App.css is `13px/1.5`, i.e. 13 * 1.5. */
const FALLBACK_LINE_HEIGHT_PX = 19.5

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
  /** The topmost visible *source* line changed (1-based; throttled to at most once per animation frame) — the
   * note editor's own half of mirror-scroll (`NoteEditPage.tsx`). Still approximate while "wrap long lines" is on
   * (a plain `scrollTop / lineHeight` division doesn't know a line long enough to wrap occupies more than one
   * visual row) — unlike the line-number gutter, which now measures this exactly (`lib/wrappedLineRows.ts`),
   * mirror-scroll's own use is looser (which source line is roughly at the top of a *different* window, not a
   * pixel-perfect position) and wasn't asked to be fixed, so it keeps the cheaper approximation. */
  onVisibleLineChange?: (line: number) => void
  /** Ctrl+Alt+arrows/PageUp/PageDown were pressed in the box — the note editor's own keyboard-driven scroll of
   * its syncing web app (`NoteEditPage.tsx`), independent of `onVisibleLineChange`/mirror-scroll. Generic here
   * (CodeEditor only reports the key combination; what it does with it is the caller's business), the same as
   * `onOpenLink`. */
  onScrollNudge?: (direction: 'up' | 'down' | 'pageUp' | 'pageDown') => void
}

/** What a ref to `CodeEditor` gives its parent: inserting text at the caret (or over the selection) from the
 * outside — "Insert a path…" is the one caller today. Goes through the same `applyEdit` every real keystroke
 * does, so it's one undo step and the caret ends up right after what was inserted, exactly like typing it. */
export interface CodeEditorHandle {
  insertAtCursor: (text: string) => void
}

/** The highlighted copy of `value` — recomputed off the main thread, in a Worker, with an **instant, approximate**
 * stand-in shown the moment a keystroke happens rather than making the keystroke wait for the real result.
 *
 * Reported live as per-keystroke lag on a large file, worse the longer the editor had been open and gone once it
 * was reopened (the undo history, `lib/undoHistory.ts`, retaining up to 500 steps/16 MB of a big file is a
 * separate, likely contributor to that — but its bounds are deliberate, documented and tested, and were left
 * alone here). An earlier fix only changed *when* the expensive, synchronous, main-thread re-scan ran — a pause
 * in typing, debounced — not *where*: a person typing continuously still saw nothing update, since the box's own
 * visible text is the *highlighted copy* drawn underneath it (`CodeEditor`'s own module doc), not the real
 * (transparent) textarea — confirmed live by reading back the actual `color`/`-webkit-text-fill-color` the box
 * is drawn with. Reported again, still happening, with a different fix asked for directly: move the real
 * re-scan off the main thread entirely (`highlightWorker.ts`), and — since a background pass still takes *some*
 * real time, however short — show *something* correctly-ish coloured the instant the keystroke happens rather
 * than nothing at all until the pass finishes.
 *
 * **The instant stand-in**: the moment `value` changes, before the Worker has even been asked, this hook sets
 * the highlighted copy to the *current* text as one single flat colour — `tokenClassAtOffset` (`lib/highlight.ts`)
 * reads which `tok-*` class was open, in the *last exact* highlight, at the caret's own position (so continuing
 * to type inside a string keeps reading in "string colour," inside a comment in "comment colour," and so on) —
 * rather than the correct, fully re-tokenised colouring, which the keystroke is never made to wait for. This is
 * a deliberately cheap, approximate guess (one string scan up to the caret, not a real parse), replaced the
 * moment the real background pass catches up; `markWhitespace` is still applied so "show whitespace" doesn't
 * flicker on or off during the brief window it's showing.
 *
 * **The real pass**, in `highlightWorker.ts`, is asked for on every change via a `HighlightScheduler`
 * (`lib/highlightScheduler.ts`): it keeps at most one request running in the Worker at a time, so a person
 * typing faster than one full re-scan takes is never queued up behind a growing backlog of stale requests —
 * only the *latest* text is ever waiting, picked up the instant the Worker is free, and the Worker's answer
 * replaces the instant guess the moment it arrives.
 *
 * **The very first render is still computed synchronously**, on the main thread, exactly as before this change —
 * there's no previous *exact* highlight yet to approximate a caret colour from, and a freshly opened file should
 * show correctly coloured from its first paint, not a flash of plain text while the Worker starts up. Every
 * change after that goes through the Worker. */
function useBackgroundHighlighted(value: string, language: Language, caretOffset: () => number): string {
  const trailer = (text: string) => (text.endsWith('\n') ? ' ' : '')
  const schedulerRef = useRef<HighlightScheduler<{ text: string; language: Language }, string> | null>(null)
  /** The last *exact* (Worker-computed, or the very first synchronous) highlight — what the real `value`/`language`
   * it was computed for were, and the html itself (both to tell "is this still current" and to read a caret colour
   * from while a newer one is on its way). */
  const lastExact = useRef<{ value: string; language: Language; html: string } | null>(null)
  const [html, setHtml] = useState(() => {
    const computed = highlight(value, language) + trailer(value)
    lastExact.current = { value, language, html: computed }
    return computed
  })

  useEffect(() => {
    const worker = new Worker(new URL('../lib/highlightWorker.ts', import.meta.url), { type: 'module' })
    schedulerRef.current = new HighlightScheduler<{ text: string; language: Language }, string>(
      (req) =>
        new Promise<string>((resolve) => {
          const onMessage = (e: MessageEvent<string>) => {
            worker.removeEventListener('message', onMessage)
            resolve(e.data)
          }
          worker.addEventListener('message', onMessage)
          worker.postMessage(req)
        }),
      (resultHtml, req) => {
        const computed = resultHtml + trailer(req.text)
        lastExact.current = { value: req.text, language: req.language, html: computed }
        setHtml(computed)
      },
    )
    return () => {
      worker.terminate()
      schedulerRef.current = null
    }
  }, [])

  useLayoutEffect(() => {
    const last = lastExact.current
    if (last && last.value === value && last.language === language) return // already exact and current
    const cls = last ? tokenClassAtOffset(last.html, caretOffset()) : null
    const approximate = markWhitespace(cls ? `<span class="${cls}">${escapeHtml(value)}</span>` : escapeHtml(value))
    setHtml(approximate + trailer(value))
    schedulerRef.current?.request({ text: value, language })
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
const CodeEditor = forwardRef<CodeEditorHandle, Props>(function CodeEditor(
  { value, onChange, fileName, onOpenLink, readOnly, language, onVisibleLineChange, onScrollNudge },
  ref,
) {
  const frameRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const highlightRef = useRef<HTMLPreElement>(null)
  const visibleLineRaf = useRef<number | null>(null)
  const lastVisibleLine = useRef<number | null>(null)
  const history = useRef<UndoHistory | null>(null)
  if (history.current === null) history.current = new UndoHistory(value)
  const [, redraw] = useReducer((n: number) => n + 1, 0)
  const restoreCaret = useRef<{ start: number; end: number } | null>(null)
  /** Set just before a *programmatic* edit (Tab, undo/redo, "Insert a path…") calls `onChange` — the one signal
   * the `[value]` effect below needs to know the DOM's native text must be force-set to match, as opposed to an
   * ordinary keystroke's own deferred `onChange` echo, where the browser has *already* applied the keystroke to
   * the DOM natively and the DOM may by now hold even *more* (further, not-yet-committed) keystrokes than this
   * prop does — forcing it to match the prop in that case would silently erase them. See the module doc comment
   * on why the textarea below is deliberately uncontrolled. */
  const programmaticEditPending = useRef(false)
  const html = useBackgroundHighlighted(value, language ?? languageOf(fileName), () => inputRef.current?.selectionEnd ?? value.length)
  const [settings, setSettings] = useState<EditorSettings | null>(null)
  useEffect(() => subscribeEditorSettings(setSettings), [])

  /** How many visual rows each source line actually occupies once wrapped, and the pixel `line-height` it was
   * measured against — `null` until the first measurement lands (the gutter falls back to one row per line until
   * then, the same thing it always showed before this existed). See `lib/wrappedLineRows.ts`'s own doc comment
   * for why this can't be a character-count calculation and has to measure the real, already-wrapped DOM. */
  const [wrapMeasure, setWrapMeasure] = useState<{ rows: number[]; lineHeightPx: number } | null>(null)
  const measureWrappedRows = () => {
    const highlightEl = highlightRef.current
    if (!highlightEl || settings?.wrapLines === false) return
    // A file this long would mean tens of thousands of Range measurements, a real pause rather than the brief
    // background pass this is meant to be — the same kind of size-based safety net `useBackgroundHighlighted`
    // already has for a different reason. Falls back to one row per line, same as before this feature existed.
    if (value.split('\n').length > MAX_LINES_FOR_WRAP_MEASUREMENT) return
    const lineHeightPx = parseFloat(getComputedStyle(highlightEl).lineHeight) || 0
    const rows = computeRowsPerLine(highlightEl, value, lineHeightPx)
    if (rows) setWrapMeasure({ rows, lineHeightPx })
  }
  // Deferred (not a `useLayoutEffect`) and off `value`/`settings?.wrapLines` only — not `html`, which also changes
  // for the *approximate* and then the *exact* highlight pass of the very same edit (`useBackgroundHighlighted`):
  // wrapping only depends on the text itself, never on which colour a span is drawn in, so measuring twice for
  // one edit would be pure waste. Measuring is real DOM work (`getBoundingClientRect` forces layout), exactly the
  // kind of thing this file already keeps off a keystroke's own critical path.
  useEffect(() => {
    const id = setTimeout(measureWrappedRows, 0)
    return () => clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, settings?.wrapLines])

  // The box is as tall as its text (or the frame, when the text is shorter, so a press anywhere in the frame is in the box).
  const fit = () => {
    const input = inputRef.current
    const frame = frameRef.current
    if (!input || !frame) return
    input.style.height = '0px'
    input.style.height = `${Math.max(input.scrollHeight, frame.clientHeight)}px`
  }
  useLayoutEffect(fit, [value])
  // A text that isn't the one the history stands at came from outside (a file re-read, a Filen version check):
  // it starts a new history. Either that, or a *programmatic* edit (Tab, undo/redo, "Insert a path…") is the
  // reason `value` changed — in both cases the DOM's own native text needs to be forced to match, since nothing
  // else will have put it there (an ordinary keystroke's own native insertion needs no such push: see the
  // textarea's own `defaultValue`, below). After that, an undo or redo puts the caret back where the text it
  // brought back had it.
  useLayoutEffect(() => {
    const h = history.current!
    const externalReset = h.current.value !== value
    if (externalReset) {
      h.reset(value)
      redraw()
    }
    const input = inputRef.current
    if (input && (externalReset || programmaticEditPending.current) && input.value !== value) {
      input.value = value
    }
    programmaticEditPending.current = false
    const caret = restoreCaret.current
    if (caret && input && input.value === value) {
      input.setSelectionRange(caret.start, caret.end)
      restoreCaret.current = null
    }
  }, [value])
  const step = (direction: 'undo' | 'redo') => {
    const h = history.current!
    const snapshot = direction === 'undo' ? h.undo() : h.redo()
    if (!snapshot) return
    programmaticEditPending.current = true
    restoreCaret.current = { start: snapshot.start, end: snapshot.end }
    inputRef.current?.focus()
    onChange(snapshot.value)
    redraw()
  }
  const lastFrameWidth = useRef<number | null>(null)
  useEffect(() => {
    const frame = frameRef.current
    if (!frame || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      fit()
      // A width change (the window resized, a split pane dragged) can change where every wrapped line now
      // breaks — a height-only change (typing, which `fit()` above already reacts to) can't, and happens far
      // more often, so this is narrowed to width specifically rather than re-measuring on every resize tick.
      const width = entries[0]?.contentRect.width
      if (width !== undefined && width !== lastFrameWidth.current) {
        lastFrameWidth.current = width
        measureWrappedRows()
      }
    })
    observer.observe(frame)
    return () => observer.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => () => {
    if (visibleLineRaf.current !== null) cancelAnimationFrame(visibleLineRaf.current)
  }, [])

  /** The scroll frame's own `scroll` event, throttled to at most once per animation frame — mirror-scroll's
   * "the editor scrolled" half. `lineHeight` comes from the box itself (`getComputedStyle` always resolves it to
   * an absolute px value, however it was authored), matching the gutter's own font/line-height exactly. */
  function handleScroll() {
    if (!onVisibleLineChange || visibleLineRaf.current !== null) return
    visibleLineRaf.current = requestAnimationFrame(() => {
      visibleLineRaf.current = null
      const frame = frameRef.current
      const input = inputRef.current
      if (!frame || !input) return
      const lineHeight = parseFloat(getComputedStyle(input).lineHeight) || 20
      const line = Math.min(lineCount, Math.max(1, Math.floor(frame.scrollTop / lineHeight) + 1))
      if (line !== lastVisibleLine.current) {
        lastVisibleLine.current = line
        onVisibleLineChange(line)
      }
    })
  }

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
    programmaticEditPending.current = true
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
  const lineCount = value.split('\n').length
  const gutterDigits = Math.max(2, String(lineCount).length)
  /** One line-number per source line, each individually positioned at the pixel row its line actually starts on
   * (`wrapMeasure`) — so a line long enough to wrap (when "wrap long lines" is on) still gets exactly one number,
   * beside its *first* visual row, and the next line's number appears where that next line's text actually is,
   * not immediately after the wrapped one. Reported live: numbering used to assume one row per line always,
   * which is only true while nothing wraps. Falls back to that same one-row-per-line assumption — the base pixel
   * offset is just `index * lineHeightPx` — until the first real measurement lands, or above
   * `MAX_LINES_FOR_WRAP_MEASUREMENT`, or while "wrap long lines" is off (every line is trivially one row then, so
   * there's nothing to measure). */
  const gutterRowStarts = useMemo(() => {
    const lineHeightPx = wrapMeasure?.lineHeightPx ?? FALLBACK_LINE_HEIGHT_PX
    const starts: number[] = []
    let row = 0
    for (let i = 0; i < lineCount; i++) {
      starts.push(row)
      row += wrapMeasure?.rows[i] ?? 1
    }
    return { starts, lineHeightPx }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wrapMeasure, lineCount])
  return (
    <div className="code-editor-wrap">
      {!readOnly && (
        <div className="code-editor-toolbar">
          <IconButton icon={Undo2} label="Undo (Ctrl+Z)" onClick={() => step('undo')} disabled={!h.canUndo} onMouseDown={(e) => e.preventDefault()} />
          <IconButton icon={Redo2} label="Redo (Ctrl+Y)" onClick={() => step('redo')} disabled={!h.canRedo} onMouseDown={(e) => e.preventDefault()} />
          {/* Reserves room for TextFieldMenu's own clipboard button (and, in Notes, the User Action pair beside it) to sit
              in, instead of floating over the top-right corner of the text — which used to cover whatever happened to be
              rendered there (reported live). */}
          <span className="code-editor-menu-slot" data-text-menu-target />
        </div>
      )}
      {/* The clipboard menu's button sits at the corner of the frame, not of the (tall) box. */}
      <div className={`code-editor ${settings?.wrapLines === false ? 'code-editor-nowrap' : ''}`} ref={frameRef} onScroll={handleScroll} data-text-menu-anchor>
        <div className="code-editor-rows">
          {settings?.lineNumbers !== false && (
            <div className="code-editor-gutter" aria-hidden="true" style={{ minWidth: `${gutterDigits}ch` }}>
              {Array.from({ length: lineCount }, (_, i) => (
                // A position:absolute child is placed relative to its containing block's *padding* edge, ignoring
                // that padding for its own offset — so the 8px top offset (matching `.code-editor-highlight`'s
                // own top padding, App.css) has to be added back here explicitly; `.code-editor-gutter` itself no
                // longer has any padding of its own left to do this for free.
                <span key={i} className="code-editor-gutter-number" style={{ top: `${8 + gutterRowStarts.starts[i] * gutterRowStarts.lineHeightPx}px` }}>
                  {i + 1}
                </span>
              ))}
            </div>
          )}
          <div className="code-editor-content">
            <pre
              ref={highlightRef}
              className={`code-editor-highlight ${settings?.showWhitespace ? 'code-editor-show-whitespace' : ''}`}
              aria-hidden="true"
              dangerouslySetInnerHTML={{ __html: html }}
            />
            <textarea
              ref={inputRef}
              className="code-editor-input"
              // Deliberately *uncontrolled* (`defaultValue`, not `value`): only applies the text at mount. Every
              // later change to `value` is applied to the DOM by hand, in the `[value]` effect above, and only
              // when it's a *programmatic* edit or an external reset (the two cases nothing else would have put
              // into the DOM already) — never for an ordinary keystroke's own deferred `onChange` echo, where
              // the browser already applied that keystroke (and possibly further ones since, not yet committed)
              // to the DOM natively. A plain React-controlled `value` would force-sync the DOM on *every*
              // render regardless of why `value` changed, which is exactly what was silently dropping fast
              // keystrokes before this fix: a later keystroke's own native insertion, still waiting on its own
              // deferred commit, got overwritten back to the earlier (stale) committed value the moment
              // anything re-rendered this component in between.
              defaultValue={value}
              readOnly={readOnly}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              // Deferred to a setTimeout, as every keystroke handler here is (see the module's own doc comment
              // for why): the browser's own native textarea update — what makes a keystroke feel instant — has
              // nothing to do with any of this running synchronously; deferring it just keeps this handler's own
              // work from ever sitting in the same tick as that native update. `e.target`'s own values are read
              // *now*, synchronously, and handed to the deferred callback by value — never re-read from `e`
              // inside it, since a React `SyntheticEvent` shouldn't be trusted to still describe the same thing a
              // tick later, and a fast typist may already have caused a *further* keystroke by then regardless.
              onChange={(e) => {
                const newValue = e.target.value
                const selStart = e.target.selectionStart
                const selEnd = e.target.selectionEnd
                setTimeout(() => {
                  history.current!.record(newValue, selStart, selEnd, Date.now())
                  onChange(newValue)
                  redraw()
                }, 0)
              }}
              // The one exception to "defer everything": a *shortcut* (Tab, the scroll-nudge combination,
              // Ctrl+Z/Y) still decides synchronously whether it was actually hit and, if so, calls
              // `preventDefault()` synchronously too — `preventDefault()` only has any effect while the event is
              // still being dispatched, so it can't itself wait for a setTimeout. Only the *handling* of a
              // shortcut that was hit — the actual edit, scroll or undo/redo step — is deferred, the same as
              // `onChange` above; nothing here does any real work before that deferred callback runs.
              onKeyDown={(e) => {
                if (readOnly) return
                if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) {
                  e.preventDefault()
                  const shiftKey = e.shiftKey
                  const selStart = e.currentTarget.selectionStart
                  const selEnd = e.currentTarget.selectionEnd
                  setTimeout(() => {
                    const unit = indentUnit(settings?.tabInsertsSpaces ?? false, settings?.tabSpaceCount ?? 4)
                    applyEdit(applyTab(value, selStart, selEnd, unit, shiftKey))
                  }, 0)
                  return
                }
                if (onScrollNudge && e.ctrlKey && e.altKey && !e.metaKey && !e.shiftKey) {
                  const direction = { ArrowUp: 'up', ArrowDown: 'down', PageUp: 'pageUp', PageDown: 'pageDown' }[e.key] as
                    | 'up'
                    | 'down'
                    | 'pageUp'
                    | 'pageDown'
                    | undefined
                  if (direction) {
                    e.preventDefault()
                    setTimeout(() => onScrollNudge(direction), 0)
                    return
                  }
                }
                // Plain Page Up/Down (optionally with Shift, to extend the selection the same way Shift+Arrow
                // already does): reported live as scrolling the view but leaving the caret exactly where it was.
                // Root cause, confirmed live: the textarea is sized to fit its *entire* text (`fit()`, above) —
                // nothing is ever clipped inside the box itself, only the `.code-editor` frame around it clips
                // and scrolls — so the browser's own native Page Up/Down, which pages a textarea's own internal
                // scroll and moves the caret along with *that*, finds nothing to page (the box has no overflow
                // of its own) and silently does nothing to the caret; what visibly scrolls is a separate,
                // unrelated browser fallback (paging the nearest scrollable ancestor, found live to be the
                // `.code-editor` frame), which knows nothing about the caret at all. Handled by hand instead:
                // move the caret by one page's worth of *source* lines (the same looser, wrap-unaware
                // approximation `onVisibleLineChange` above already uses and documents) and page the frame by
                // one whole screen — not merely "nudge it until the new line is barely visible": the new caret
                // is computed to sit exactly one page below/above the old one, so a minimal "scroll until
                // visible" would, by construction, land it right back at the edge of the page already on
                // screen (found live: the caret moved correctly, but the view barely shifted) — a real page
                // scroll is what lands it near the top/bottom of a genuinely new page instead.
                if ((e.key === 'PageDown' || e.key === 'PageUp') && !e.ctrlKey && !e.metaKey && !e.altKey) {
                  e.preventDefault()
                  const goingDown = e.key === 'PageDown'
                  const shiftKey = e.shiftKey
                  const selStart = e.currentTarget.selectionStart
                  const selEnd = e.currentTarget.selectionEnd
                  const selectionDirection = e.currentTarget.selectionDirection
                  setTimeout(() => {
                    const input = inputRef.current
                    const frame = frameRef.current
                    if (!input || !frame) return
                    const lines = value.split('\n')
                    const lineHeightPx = parseFloat(getComputedStyle(input).lineHeight) || FALLBACK_LINE_HEIGHT_PX
                    const linesPerPage = Math.max(1, Math.floor(frame.clientHeight / lineHeightPx))
                    // The end that actually moves — the selection's own "focus" end, exactly what a real
                    // Arrow key moves (and collapses to, without Shift).
                    const activeOffset = selectionDirection === 'backward' ? selStart : selEnd
                    const anchorOffset = selectionDirection === 'backward' ? selEnd : selStart
                    let line = 0
                    let acc = 0
                    for (; line < lines.length - 1; line++) {
                      if (acc + lines[line].length >= activeOffset) break
                      acc += lines[line].length + 1
                    }
                    const col = activeOffset - acc
                    const newLine = Math.min(lines.length - 1, Math.max(0, line + (goingDown ? linesPerPage : -linesPerPage)))
                    const newCol = Math.min(col, lines[newLine].length)
                    let newAcc = 0
                    for (let i = 0; i < newLine; i++) newAcc += lines[i].length + 1
                    const newOffset = newAcc + newCol
                    if (shiftKey) {
                      if (newOffset < anchorOffset) input.setSelectionRange(newOffset, anchorOffset, 'backward')
                      else input.setSelectionRange(anchorOffset, newOffset, 'forward')
                    } else {
                      input.setSelectionRange(newOffset, newOffset)
                    }
                    const maxScroll = Math.max(0, frame.scrollHeight - frame.clientHeight)
                    frame.scrollTop = Math.min(maxScroll, Math.max(0, frame.scrollTop + (goingDown ? frame.clientHeight : -frame.clientHeight)))
                  }, 0)
                  return
                }
                if (!(e.ctrlKey || e.metaKey) || e.altKey) return
                const key = e.key.toLowerCase()
                let action: 'undo' | 'redo' | null = null
                if (key === 'z' && !e.shiftKey) action = 'undo'
                else if (key === 'y' || (key === 'z' && e.shiftKey)) action = 'redo'
                if (action === null) return
                e.preventDefault()
                const theAction = action
                setTimeout(() => step(theAction), 0)
              }}
            />
          </div>
        </div>
      </div>
    </div>
  )
})

export default CodeEditor
