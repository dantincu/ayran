import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react'
import { Redo2, Undo2 } from 'lucide-react'
import IconButton from './IconButton'
import { UndoHistory } from '../lib/undoHistory'
import { highlight, languageOf, type Language } from '../lib/highlight'
import { HighlightScheduler } from '../lib/highlightScheduler'
import { editorLinkHandlers, type LinkHandler } from '../lib/textLinks'
import { applyTab, indentUnit } from '../lib/editorIndent'
import { subscribeEditorSettings, type EditorSettings } from '../lib/editorSettings'
import { useChord } from '../lib/chords'
import { carryForwardRows, computeRowsPerLine, computeWindowRange, lineAtOffset, lineStartOffsets, type WindowRange } from '../lib/wrappedLineRows'
import { RunPatchController } from '../lib/runPatchController'
import { splitRunsAt, tokensOf } from '../lib/highlightTokens'

/** Above this many lines, the line-number gutter falls back to one row per line (what it always showed before
 * wrapped-row measurement existed) rather than measuring — tens of thousands of `Range` queries would be a real
 * pause, not the brief background pass this is meant to be. */
const MAX_LINES_FOR_WRAP_MEASUREMENT = 20_000
/** The gutter's own fallback row height (one row per line) before a real measurement lands — `.code-editor-gutter`'s
 * font shorthand in App.css is `13px/1.5`, i.e. 13 * 1.5. */
const FALLBACK_LINE_HEIGHT_PX = 19.5
/** How long `useBackgroundHighlighted` waits, after the *last* keystroke, before dispatching the real Worker pass —
 * see that hook's own doc comment for why this exists and why debouncing the dispatch (not the Worker's own run) is
 * the right lever. */
const EXACT_DISPATCH_DEBOUNCE_MS = 200
/** How long the wrapped-row gutter measurement (below, `measureWrappedRows`) waits after the *last* keystroke
 * before actually measuring — found, by CPU-profiling a real 190 KB file, to be the single most expensive thing
 * this editor does per keystroke (see that effect's own doc comment), dwarfing the highlighting cost the debounce
 * above was built for. Same lever, same reasoning: the gutter simply keeps its last-known row spacing (already
 * self-correcting, same "an approximate is fine for a moment" trade used everywhere else in this file) until
 * typing actually pauses. */
const WRAP_MEASURE_DEBOUNCE_MS = 250
/** How many screens' worth of lines, above and below what's actually visible, the virtualized rendering
 * (below) keeps as real DOM — the buffer a normal scroll (or Page Up/Down) consumes before the window has to
 * shift at all. Asked for directly as "3 or so screens." */
const WINDOW_BUFFER_SCREENS = 3

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

/** A genuinely exact (never approximate) highlight result and what it was computed for — see
 * `useBackgroundHighlighted`'s own doc comment for why this is kept separately from the plain `html` string it
 * also returns. */
interface ExactResult {
  value: string
  language: Language
  html: string
}

/** The *exact*, fully re-tokenised highlight of `value` — computed off the main thread, in a Worker, since the
 * DOM rendering itself is `RunPatchController`'s job (`lib/runPatchController.ts`, wired up in `CodeEditor`
 * below): this hook's only remaining responsibility is handing that controller a real, correctly-tokenised html
 * string to diff against, the moment one is ready, and otherwise staying out of the way.
 *
 * Reported live as per-keystroke lag on a large file, worse the longer the editor had been open (the undo
 * history, `lib/undoHistory.ts`, retaining up to 500 steps/16 MB of a big file is a separate, likely contributor
 * to that — but its bounds are deliberate, documented and tested, and were left alone here). The real,
 * synchronous re-scan used to run on the main thread, on every keystroke; moving it into a Worker
 * (`highlightWorker.ts`) keeps that cost off the critical path entirely, through a `HighlightScheduler`
 * (`lib/highlightScheduler.ts`): it keeps at most one request running in the Worker at a time, so a person
 * typing faster than one full re-scan takes is never queued up behind a growing backlog of stale requests — only
 * the *latest* text is ever waiting, picked up the instant the Worker is free.
 *
 * **Dispatching to that scheduler is itself debounced by `EXACT_DISPATCH_DEBOUNCE_MS`**, asked for directly after
 * a large real file (hundreds of KB) was reported as consistently harder to type in and "bad for the eyes" —
 * not a main-thread stall (the Worker already keeps that off the critical path) but the *sustained* cost of
 * running a full re-scan back to back on every single settled keystroke while someone types continuously: each
 * exact reply also means diffing a large result into the DOM (`RunPatchController.applyExact`), which is real,
 * repeated work for a big file even though each individual pass is "only" off the main thread. On a phone this
 * is also squarely a battery question, which is what was actually asked about — a heuristic that decides, per
 * keystroke, whether a re-scan is even *needed* (the first idea floated) was turned down: that would mean
 * mirroring every highlighter's own keyword/escape/boundary rules in a second, approximate form, and a wrong
 * "safe to skip" guess produces a silently stuck wrong colour that nothing afterward self-corrects — a worse
 * failure mode than today's always-eventually-correct Worker pass. Debouncing the *dispatch* instead needs none
 * of that: `RunPatchController`'s own instant, approximate patch (`applyApproximate`, keyed off `value` directly,
 * not off anything this hook returns) already makes every keystroke feel immediate regardless of when the exact
 * pass actually runs, so delaying *only* the Worker call — reset on every further keystroke, fired once typing
 * actually pauses for `EXACT_DISPATCH_DEBOUNCE_MS` — cuts how often the whole dispatch → Worker → reply → reparse
 * cycle runs during a sustained burst, with no new correctness surface: a person who never pauses simply keeps
 * seeing the approximate colouring (already correct for the overwhelmingly common case of typing inside the same
 * token) until they do, the same guarantee the scheduler's own coalescing already relies on elsewhere.
 *
 * **`html` itself is a cheap, merely-identity-changing placeholder, never the actual highlighted markup** — a
 * real, un-abbreviated version of this hook used to also maintain a second, *approximate* html string for a
 * `dangerouslySetInnerHTML`-based rendering path; once that path was removed (`CodeEditor` renders exclusively
 * through `RunPatchController` now, see this file's own module doc), computing it was pure waste — found live,
 * costing upward of 100ms per keystroke on a real 190 KB file, for a result nothing ever read. `html` is kept
 * only because the scroll-to-bottom effect below needs to know *that* an approximate or exact pass just landed,
 * never *what* it contains.
 *
 * **The very first render is still computed synchronously**, on the main thread — there's no previous *exact*
 * highlight yet to diff against, and a freshly opened file should show correctly coloured from its first paint,
 * not a flash of plain text while the Worker starts up. Every change after that goes through the Worker.
 *
 * **Also returns `exact`** — the same `{value, language, html}` snapshot, but as reactive state rather than a
 * plain ref, updated *only* when a genuinely new exact result lands (the very first synchronous one, or a Worker
 * reply) — never on an approximate step. `RunPatchController` reacts to this separately from `html` itself: it
 * needs to know precisely when a *real* tokenisation is ready to diff against, which `html` alone (an identity
 * change on every step, approximate or exact) can't tell it. */
function useBackgroundHighlighted(value: string, language: Language): { html: string; exact: ExactResult } {
  const trailer = (text: string) => (text.endsWith('\n') ? ' ' : '')
  const schedulerRef = useRef<HighlightScheduler<{ text: string; language: Language }, string> | null>(null)
  /** A cheap, ever-changing stand-in for `html` — see the module doc above for why the real markup is never
   * computed here at all. */
  const placeholderTick = useRef(0)
  /** The last *exact* (Worker-computed, or the very first synchronous) highlight — what the real `value`/`language`
   * it was computed for were, and the html itself (both to tell "is this still current" and to read a caret colour
   * from while a newer one is on its way). Kept as a ref, not just the `exact` state below, because the layout
   * effect's own "is this already exact and current" check must read the *latest* value synchronously without
   * itself being a reason to re-run (a plain state read inside an effect not listed in its own deps would be
   * stale); `exact` state exists purely so code *outside* this hook can react to "a new one landed." */
  const lastExact = useRef<ExactResult | null>(null)
  /** The pending, debounced dispatch to the Worker — reset on every keystroke, so only the one that's still the
   * latest after `EXACT_DISPATCH_DEBOUNCE_MS` of no further change actually fires. */
  const dispatchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [html, setHtml] = useState(() => {
    const computed = highlight(value, language) + trailer(value)
    lastExact.current = { value, language, html: computed }
    return computed
  })
  const [exact, setExact] = useState<ExactResult>(() => lastExact.current!)

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
        const result = { value: req.text, language: req.language, html: computed }
        lastExact.current = result
        setHtml(computed)
        setExact(result)
      },
    )
    return () => {
      worker.terminate()
      schedulerRef.current = null
      if (dispatchTimer.current !== null) clearTimeout(dispatchTimer.current)
      dispatchTimer.current = null
    }
  }, [])

  useLayoutEffect(() => {
    const last = lastExact.current
    if (last && last.value === value && last.language === language) return // already exact and current
    // `RunPatchController.applyApproximate` does the real, cheap, localised approximate colouring directly
    // against the managed `<pre>` — nothing here ever reads `html`'s own content, only that it changed, so a
    // bare incrementing placeholder is all this needs to provide (see the module doc above for why computing a
    // real approximate string here was pure, measured waste once that was true).
    placeholderTick.current++
    setHtml(String(placeholderTick.current))
    if (dispatchTimer.current !== null) clearTimeout(dispatchTimer.current)
    dispatchTimer.current = setTimeout(() => {
      dispatchTimer.current = null
      schedulerRef.current?.request({ text: value, language })
    }, EXACT_DISPATCH_DEBOUNCE_MS)
  }, [value, language])

  return { html, exact }
}

/** The one text editor of the app's file views: a `textarea` — so everything a text box does (selection, the clipboard
 * menu, the on-screen keyboard, drafts) stays as it is — with **syntax highlighting** drawn behind it (`lib/highlight.ts`).
 *
 * The highlighted copy of the text sits under the box, which has the same font, padding and wrapping and a transparent
 * text; the box is as tall as its text and the frame around both scrolls, so nothing has to be kept in step but the
 * height. (The layer is a picture: it can't be selected or focused, and screen readers skip it.)
 *
 * **The highlighted copy is drawn by patching only the changed run of the DOM on each edit**
 * (`lib/runPatchController.ts`), never by replacing the whole thing with a fresh `dangerouslySetInnerHTML` write —
 * this used to be a second, opt-in rendering mode ("Experimental code editor," off by default) living alongside
 * the simpler full-replace one; once it had proven itself (no flicker, no measured regression), the simpler mode
 * was deleted outright rather than kept as a second, now-pointless code path to maintain — see
 * `useBackgroundHighlighted`'s and `RunPatchController`'s own doc comments for how the two halves (the Worker's
 * exact re-tokenising pass, and the patcher that applies it to the DOM) fit together.
 *
 * **Only a *window* of lines — what's visible plus `WINDOW_BUFFER_SCREENS` screens above and below — is ever
 * real DOM**, for both the highlighted overlay and the line-number gutter: a huge file used to mean one DOM
 * node per token (and one more per whitespace character) for the *entire* file, alive at once, rebuilt in full
 * on the first open and on any width change — a real, previously-documented, unaddressed cost. The real
 * `<textarea>` underneath is **not** windowed — it always holds the whole file (native text rendering has
 * never been the measured bottleneck, and virtualizing it would mean rebuilding native selection/IME/undo
 * continuity from scratch for no measured benefit) — so it alone is what gives the editor its correct, exact
 * overall scroll range; the window just decides how much of *that* range gets a real, colored, numbered copy
 * drawn behind it at any moment. `windowRange` (state, `[startLine, endLine)`) is recomputed from the frame's
 * own scroll position (`handleScroll`, below, with hysteresis so a one-pixel scroll doesn't thrash a rebuild)
 * and, whenever the caret moves outside it (typing, undo/redo, "Insert a path…"), recentred around the caret
 * during render itself (the official React "adjust state during render" pattern — settles before paint, no
 * extra visible frame). The one accepted trade-off, confirmed directly before building this: a wrapped file's
 * own total/scroll height is *approximate* for a stretch never yet scrolled through (lines there are assumed
 * to be one row each until measured for real — `wrapMeasure`'s own doc comment below), self-correcting as it's
 * visited — the same estimate-then-correct trade every virtualized variable-height list makes.
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
  const effectiveLanguage = language ?? languageOf(fileName)
  const caretOffset = () => inputRef.current?.selectionEnd ?? value.length
  const [settings, setSettings] = useState<EditorSettings | null>(null)
  useEffect(() => subscribeEditorSettings(setSettings), [])
  const { html, exact } = useBackgroundHighlighted(value, effectiveLanguage)
  /** The full exact result, parsed into runs *once* per exact update (not per keystroke) — what both
   * `applyApproximate`'s own caret-colour lookup and `applyExact`'s own window-slicing (below) are built from.
   * Memoized on `exact`'s own identity, exactly the caching benefit `RunPatchController`'s own internal cache
   * used to provide before it was removed (see its own doc comment). */
  const fullExactRuns = useMemo(() => tokensOf(exact.html), [exact])

  // `lineStartOffsets` once per render, reused everywhere a line/character conversion is needed below — cheap
  // (a single pass counting `\n`s, no substring allocated for a single line) but there's no reason to pay for
  // it more than once per `value`.
  const lineStarts = useMemo(() => lineStartOffsets(value), [value])
  const lineCount = lineStarts.length

  /** How many visual rows each source line actually occupies once wrapped, and the pixel `line-height` it was
   * measured against — `null` until the first measurement lands (the gutter falls back to one row per line until
   * then, the same thing it always showed before this existed). See `lib/wrappedLineRows.ts`'s own doc comment
   * for why this can't be a character-count calculation and has to measure the real, already-wrapped DOM.
   *
   * **`rows` is a lazily-filled, best-known array, length `lineCount`, defaulting to `1`** — not "fully measured
   * or nothing," since virtualization means only the *current window*'s own lines ever have real DOM to measure
   * against; a line outside it simply hasn't been visited yet. `measureWrappedRows` (below) is what fills it in,
   * a window's worth at a time, carrying the rest forward across an edit via `carryForwardRows` (which correctly
   * *shifts* the off-window portion when lines are inserted or deleted, without needing any DOM at all for that).
   *
   * **Tagged with the exact `value` it was measured against** — reported live ("line numbers show as if there
   * was no wrapped line... the first line spans hundreds of actual lines"), not reproduced in several live
   * attempts, but a real structural gap either way: the measurement is deferred (`setTimeout`, below), so after
   * *any* edit there's a render where `value`/`lineCount` already reflect the new text but `wrapMeasure` still
   * holds whatever was last measured for the *previous* text — a completely different line-start/row-count
   * shape. `gutterRowStarts` used to read `wrapMeasure.rows[i]` regardless, which for that one render reads a
   * stale line's row-count as if it belonged to the current line `i` — exactly capable of producing a wildly
   * wrong offset like "hundreds of rows" for a line that wrapped a lot in the *previous* text (or in a
   * previously open, unrelated file, if this same editor instance is reused across files) but not in the
   * current one. Tagging the measurement with its own `value` and only trusting it when that matches the
   * current `value` closes the gap: during that one render it falls back to the same honest "not measured yet"
   * flat spacing a fresh measurement always starts from, never a mismatched one. */
  const [wrapMeasure, setWrapMeasure] = useState<{ value: string; rows: number[]; lineHeightPx: number } | null>(null)

  /** One line-number per source line, each individually positioned at the pixel row its line actually starts on
   * (`wrapMeasure`) — so a line long enough to wrap (when "wrap long lines" is on) still gets exactly one number,
   * beside its *first* visual row, and the next line's number appears where that next line's text actually is,
   * not immediately after the wrapped one. Reported live: numbering used to assume one row per line always,
   * which is only true while nothing wraps. Falls back to that same one-row-per-line assumption — the base pixel
   * offset is just `index * lineHeightPx` — until the first real measurement lands, or above
   * `MAX_LINES_FOR_WRAP_MEASUREMENT`, or while "wrap long lines" is off (every line is trivially one row then, so
   * there's nothing to measure) — or, for one render right after an edit, while `wrapMeasure` is still the
   * *previous* text's measurement (the `wrapMeasure.value === value` check below; see `wrapMeasure`'s own doc
   * comment for why trusting it regardless of `value` was the real bug).
   *
   * **`settings?.wrapLines === false` always wins, regardless of what `wrapMeasure` holds** — asked for
   * directly: a wrap-based measurement must never leak into the nowrap gutter. `measureWrappedRows` itself
   * already skips measuring while wrap is off, but that alone isn't enough to guarantee this: `settings` starts
   * out `undefined` (not yet loaded), and `undefined !== false`, so a measurement taken in that brief window —
   * genuinely reflecting wrap-like CSS, since the nowrap class also hasn't applied yet — can land in
   * `wrapMeasure` just before `settings` resolves to `wrapLines: false`; nothing afterwards ever clears it (the
   * now-skipped `measureWrappedRows` just leaves it as is), and the plain `wrapMeasure.value === value` check
   * alone would keep trusting it, tagged with a `value` that still matches. Checking the setting here too closes
   * that gap outright, rather than relying on the measurement effect's own early return to happen to starve
   * `wrapMeasure` of ever being asked to update. */
  const rowsForCurrentValue = settings?.wrapLines === false ? null : wrapMeasure?.value === value ? wrapMeasure.rows : null
  const gutterRowStarts = useMemo(() => {
    const lineHeightPx = wrapMeasure?.lineHeightPx ?? FALLBACK_LINE_HEIGHT_PX
    const starts: number[] = []
    let row = 0
    for (let i = 0; i < lineCount; i++) {
      starts.push(row)
      row += rowsForCurrentValue?.[i] ?? 1
    }
    return { starts, lineHeightPx }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowsForCurrentValue, wrapMeasure?.lineHeightPx, lineCount])

  /** The line range currently given real DOM — see the component's own module doc for the full design. Starts
   * covering a *reasonable estimate* of one screen's worth (guessing at the viewport's own size, since the real
   * frame isn't mounted yet at this point) rather than the whole document: the very first render already goes
   * through the same windowed path as every later one, so a huge file's first paint never builds the full,
   * unbounded DOM tree this feature exists to avoid. The mount-time layout effect below corrects this estimate
   * to the frame's own real size immediately, before paint. */
  const [windowRange, setWindowRange] = useState<WindowRange>(() => {
    const estimatedClientHeight = typeof window !== 'undefined' ? window.innerHeight : 800
    return computeWindowRange(0, estimatedClientHeight, FALLBACK_LINE_HEIGHT_PX, lineStarts, WINDOW_BUFFER_SCREENS)
  })

  /** Recentres the window around the caret, during render, whenever `value` changed since the last render and
   * the caret ended up outside the current window — typing, undo/redo, "Insert a path…", anything. The
   * official React "adjust state during render" pattern: React discards this render's own output and
   * immediately re-renders with the corrected `windowRange`, before committing anything or running a single
   * effect, so there's no extra visible frame. Prefers `restoreCaret.current` (the *intended* caret for a
   * programmatic edit still mid-flight) over the real DOM's own `selectionEnd`, which for a programmatic edit
   * hasn't been written yet at this point in the render (that happens in the DOM-sync layout effect, below) and
   * would otherwise still read the *previous* step's caret. */
  const lastRecenterValueRef = useRef(value)
  if (lastRecenterValueRef.current !== value) {
    lastRecenterValueRef.current = value
    const pendingCaret = restoreCaret.current
    const effectiveCaret = pendingCaret ? pendingCaret.start : caretOffset()
    const caretLine = lineAtOffset(lineStarts, effectiveCaret)
    if (caretLine < windowRange.startLine || caretLine >= windowRange.endLine) {
      const clientHeight = frameRef.current?.clientHeight ?? 0
      const lineHeightPx = gutterRowStarts.lineHeightPx
      const caretRow = gutterRowStarts.starts[caretLine] ?? 0
      const synthScrollTop = Math.max(0, caretRow * lineHeightPx - clientHeight / 2)
      setWindowRange(computeWindowRange(synthScrollTop, clientHeight, lineHeightPx, gutterRowStarts.starts, WINDOW_BUFFER_SCREENS))
    }
  }
  const windowStartChar = lineStarts[windowRange.startLine] ?? 0
  const windowEndChar = windowRange.endLine < lineStarts.length ? lineStarts[windowRange.endLine] : value.length

  /** The editor's own DOM half (`lib/runPatchController.ts`) — one controller per mounted editor, reused across
   * every patch; its own module doc explains why it owns this state independently of React rather than ever
   * re-reading the real DOM. Two effects, not one, each attaching the container itself first (a cheap no-op when
   * it hasn't actually changed): the approximate patch reacts to `[value, effectiveLanguage, windowRange]`, the
   * exact patch only to a genuinely *new* exact result landing, or the window shifting (`[exact, windowRange]`) —
   * reading the current `value` inside the approximate one, at the moment it runs, is deliberate (see
   * `RunPatchController.applyExact`'s own doc comment on why a reply for an older value must be told apart from
   * one for the current value, not just applied).
   *
   * **`lastAppliedWindowRef` resets the controller's own live state the moment `windowRange` itself has changed
   * since the last apply** — diffing the old window's slice against a differently-positioned new one would find
   * almost nothing in common anyway (the two are offset, not merely appended-to), so there's no reason to try:
   * the next apply degrades straight to a full rebuild of just the (bounded) window, exactly as `RunPatchController`
   * already does for a brand new container. Shared between both effects, checked and updated by whichever runs
   * first in a given commit, so the reset never happens twice for the same window change. */
  const runPatchController = useRef<RunPatchController | null>(null)
  if (!runPatchController.current) runPatchController.current = new RunPatchController()
  const lastAppliedWindowRef = useRef<WindowRange | null>(null)
  function resetPatcherIfWindowMoved(controller: RunPatchController) {
    const last = lastAppliedWindowRef.current
    if (!last || last.startLine !== windowRange.startLine || last.endLine !== windowRange.endLine) {
      controller.resetLiveState()
      lastAppliedWindowRef.current = windowRange
    }
  }
  useLayoutEffect(() => {
    const controller = runPatchController.current!
    controller.attachContainer(highlightRef.current)
    resetPatcherIfWindowMoved(controller)
    const windowValue = value.slice(windowStartChar, windowEndChar)
    // `fullExactRuns`/`caretOffset()` are deliberately left on the *whole document's* own basis here, not
    // sliced to the window — see `RunPatchController.applyApproximate`'s own doc comment for why slicing them
    // on every keystroke would reintroduce the exact `O(whole file)`-per-keystroke cost this session already
    // found and removed once, for a different function.
    controller.applyApproximate(windowValue, fullExactRuns, caretOffset())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, effectiveLanguage, windowRange])
  useLayoutEffect(() => {
    const controller = runPatchController.current!
    controller.attachContainer(highlightRef.current)
    resetPatcherIfWindowMoved(controller)
    const windowValue = value.slice(windowStartChar, windowEndChar)
    const [, afterWindowStart] = splitRunsAt(fullExactRuns, windowStartChar)
    const [windowExactRuns] = splitRunsAt(afterWindowStart, windowEndChar - windowStartChar)
    controller.applyExact(windowValue, windowExactRuns, exact.value, value)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exact, windowRange])

  /** `full`: discard *every* line's known row count (not just the window's), not only skip reusing it — only
   * ever passed `true` by the frame's own width-change handler (or a line-height mismatch, below), since either
   * can move where *every* line wraps, unchanged text included. An ordinary content edit never needs it. */
  const measureWrappedRows = (full = false) => {
    const highlightEl = highlightRef.current
    if (!highlightEl || settings?.wrapLines === false) return
    // **Nothing ever reads this measurement while the gutter itself isn't shown** — `rowsForCurrentValue`/
    // `gutterRowStarts` (above) are the only consumers of `wrapMeasure`, and both are inside the gutter's own
    // `settings?.lineNumbers !== false` render branch. This check was simply missing until reported live
    // ("it's slower when I disable line numbers altogether too"): every edit still paid for a full wrapped-row
    // measurement pass for a gutter that was never going to be drawn with the result. Checking `wrapLines`
    // alone (above) was never enough, since the two settings are independent: wrapping can stay on while only
    // the *numbers* are turned off.
    if (settings?.lineNumbers === false) return
    // A file this long would mean tens of thousands of Range measurements even for one window's worth, a real
    // pause rather than the brief background pass this is meant to be — the same kind of size-based safety net
    // `useBackgroundHighlighted` already has for a different reason. Falls back to one row per line, same as
    // before this feature existed.
    if (lineCount > MAX_LINES_FOR_WRAP_MEASUREMENT) return
    const lineHeightPx = parseFloat(getComputedStyle(highlightEl).lineHeight) || 0
    if (!lineHeightPx) return
    const previous = wrapMeasure
    const lineHeightChanged = previous !== null && previous.lineHeightPx !== lineHeightPx
    // **The off-window portion is carried forward, never remeasured — only the current window ever gets a
    // fresh `computeRowsPerLine` call, below, and that's *always* a full (not incremental) measurement of
    // whatever's currently in `highlightEl`.** A window is bounded in size by construction, so there's no
    // longer a reason to reuse a *previous* measurement of the same window the way the whole-document version
    // of this function once had to (`carryForwardRows`'s own doc comment has the fuller story, including why
    // this module no longer has an incremental, DOM-measuring variant at all). `carryForwardRows` itself is
    // still essential here, though, for a completely different reason: it's what correctly *shifts* the
    // off-window rows when an edit inserts or deletes lines, using nothing but character comparisons — no DOM,
    // so it works unconditionally, regardless of what is or isn't currently rendered.
    const baseRows =
      full || lineHeightChanged || previous === null
        ? new Array<number>(lineCount).fill(1)
        : previous.value === value
          ? previous.rows
          : carryForwardRows(previous.value, previous.rows, value) ?? new Array<number>(lineCount).fill(1)
    const windowText = value.slice(windowStartChar, windowEndChar)
    const windowRows = computeRowsPerLine(highlightEl, windowText, lineHeightPx)
    if (!windowRows) return
    const rows = baseRows.slice()
    for (let j = 0; j < windowRows.length; j++) rows[windowRange.startLine + j] = windowRows[j]
    setWrapMeasure({ value, rows, lineHeightPx })
  }
  // Deferred (not a `useLayoutEffect`) and off `value`/`settings?.wrapLines`/`windowRange` — not `html`, which
  // also changes for the *approximate* and then the *exact* highlight pass of the very same edit
  // (`useBackgroundHighlighted`): wrapping only depends on the text itself, never on which colour a span is
  // drawn in, so measuring twice for one edit would be pure waste. Measuring is real DOM work
  // (`getBoundingClientRect` forces layout), exactly the kind of thing this file already keeps off a
  // keystroke's own critical path.
  //
  // **Debounced by `WRAP_MEASURE_DEBOUNCE_MS`, not just deferred by one tick** — found live, by CPU-profiling a
  // real 190 KB file while typing a short burst: `getClientRects` (called once per source line by
  // `computeRowsPerLine`) was by far the single hottest thing in the whole profile, dwarfing the cost of
  // highlighting itself (the actual thing item #8's own debounce, `EXACT_DISPATCH_DEBOUNCE_MS` above, was built
  // for) and unrelated to how the text itself gets rendered — the gutter's own cost is entirely independent of
  // that. A plain `setTimeout(fn, 0)` still measures on every settled keystroke during continuous typing (each
  // one gets its own macrotask to run in before the next keystroke's own effect replaces it) — resetting the
  // timer on every further keystroke, the same lever as the Worker dispatch above, means a sustained burst pays
  // this cost once, after it actually stops, not once per keystroke. `windowRange` is in the dependency list so
  // a scroll that shifts the window also schedules a (still debounced — a fast, sustained scroll shouldn't pay
  // this on every tick either) measurement of whatever just came into view.
  useEffect(() => {
    const id = setTimeout(measureWrappedRows, WRAP_MEASURE_DEBOUNCE_MS)
    return () => clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, settings?.wrapLines, settings?.lineNumbers, windowRange])

  // A text that isn't the one the history stands at came from outside (a file re-read, a Filen version check):
  // it starts a new history. Either that, or a *programmatic* edit (Tab, undo/redo, "Insert a path…") is the
  // reason `value` changed — in both cases the DOM's own native text needs to be forced to match, since nothing
  // else will have put it there (an ordinary keystroke's own native insertion needs no such push: see the
  // textarea's own `defaultValue`, below). After that, an undo or redo puts the caret back where the text it
  // brought back had it.
  //
  // **Declared before `fit`'s own effect below, deliberately — `fit()` reads `input.scrollHeight`, the real
  // DOM textarea's own current content height, so it must run *after* this effect has written the new text
  // into that same DOM element, never before.** React runs a component's `useLayoutEffect`s in the order
  // they're declared, so moving this one ahead of `fit`'s is what makes that true. A real, reported bug came
  // from the opposite order (this effect used to be declared *after* `fit`'s): go to the end of a file, type
  // a few lines, Undo, then Redo — the restored lines came back in the `value` state and were visible in the
  // read-only highlighted overlay, but the caret couldn't be moved past where they began. Root cause: for an
  // *ordinary keystroke* the browser already writes the new character into the real, uncontrolled `textarea`
  // natively, synchronously, before any of this ever runs — by the time a deferred `onChange` lands and
  // triggers a render, `input.value` already agrees with `value`, so `fit()` reading `scrollHeight` first was
  // always reading the *correct*, already-current content and the bug stayed invisible. A *programmatic* edit
  // (this is exactly what undo/redo is) has no such prior native write: `value` changes purely in React state,
  // so when `fit()` used to run first, it measured `scrollHeight` against the *stale* DOM text — the box was
  // sized for the content from one step ago, not the one just restored — and only afterward did this effect
  // finally write the real text in, leaving the real `<textarea>` genuinely too short for its own content (a
  // single-line Tab/Insert-a-path edit never changes line count enough for the stale measurement to matter,
  // which is why those were tested extensively elsewhere in this file with no sign of this).
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

  // The box is as tall as its text (or the frame, when the text is shorter, so a press anywhere in the frame is in the box).
  // Declared after the DOM-sync effect above — see its own comment for why that order matters.
  const fit = () => {
    const input = inputRef.current
    const frame = frameRef.current
    if (!input || !frame) return
    input.style.height = '0px'
    input.style.height = `${Math.max(input.scrollHeight, frame.clientHeight)}px`
  }
  useLayoutEffect(fit, [value])

  /** Corrects the window's own initial estimate (above) to the frame's real, just-mounted size — runs once,
   * immediately after the first commit, before paint, so the person never sees the estimate's own window, only
   * the corrected one. Reads `gutterRowStarts` directly from this render's own closure rather than through a
   * ref: nothing could have changed `value`/`settings` between the first render and this effect running (it's
   * mount-only), so there's no staleness to guard against here the way a *later*-firing effect would need to. */
  useLayoutEffect(() => {
    const frame = frameRef.current
    if (!frame) return
    setWindowRange(computeWindowRange(frame.scrollTop, frame.clientHeight, gutterRowStarts.lineHeightPx, gutterRowStarts.starts, WINDOW_BUFFER_SCREENS))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** Keeps the frame scrolled to its own bottom through a highlight update — approximate or exact — when the
   * caret is at (or within a few characters of) the very end of the text and that end is no longer visible.
   * Reported live: appending new lines at the end of a file could leave the view short of them once the
   * Worker's exact pass replaced the approximate one, changing the rendered height a second time — `fit()`
   * above only resizes the box for a `value` change, not for `html` alone, and the browser's own native "keep
   * the caret visible" scroll (confirmed elsewhere in this file to fire for an ordinary keystroke) only ever
   * responds to the keystroke itself, never to a later, asynchronous re-render that changes the rendered
   * height again on its own.
   *
   * **Checks whether the content's own bottom edge is still inside the frame's visible area, not whether the
   * frame's `scrollTop` already equals its maximum** — a first version tried the latter and it didn't work:
   * by the time this effect runs, the browser's own native caret-follow scroll may have *already* nudged
   * `scrollTop` partway toward the new bottom (but not all the way, since it only reacts to the keystroke
   * itself, not to this later update), which already reads as "not exactly at the maximum" even though the
   * person is still, in every meaningful sense, watching the tail of the file — comparing bounding rects
   * instead needs no such exact equality and isn't thrown off by that partial, native-driven nudge. Also
   * avoids a collapsed-`Range` measurement at the caret's own position entirely, which can return a
   * degenerate, all-zero rect at exactly the kind of boundary a file's final line sits on (`lib/wrappedLineRows.ts`'s
   * own doc comment has the full story on that failure mode) — `highlightEl`'s own element-level bounding rect
   * has no such edge case. Gated on the caret being at the end, not just "the content overflows the frame"
   * alone — a file being edited in its *middle*, with its end already scrolled out of view on purpose, would
   * otherwise get yanked down to that end on every keystroke, which isn't what was asked for. Runs after
   * `fit`'s own effect above (declared earlier, so it always resizes first) and keys off `html`, not `value` —
   * `html` changes for *both* the approximate and the exact pass of the same edit, which is exactly the second
   * update this needs to catch that a plain `[value]` effect wouldn't fire for again. Still correct under
   * windowing: the caret is always within the current window by construction, so when it's at the document's
   * own end, the window's own rendered content ends there too, and `highlightEl`'s bottom genuinely reflects
   * it. */
  useLayoutEffect(() => {
    const frame = frameRef.current
    const highlightEl = highlightRef.current
    if (!frame || !highlightEl) return
    if (value.length - caretOffset() > 4) return
    if (highlightEl.getBoundingClientRect().bottom > frame.getBoundingClientRect().bottom) {
      frame.scrollTop = frame.scrollHeight - frame.clientHeight
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [html])
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
  /** The pre-existing `ResizeObserver` effect below is mount-only (`[]` deps, so the observer itself isn't
   * endlessly resubscribed on every render) — which means its callback's own closure over `measureWrappedRows`
   * is frozen at mount. Before virtualization this was already a known, narrow, pre-existing bug (a resize
   * after an edit would remeasure against the *original* `value`, documented and deliberately left alone as
   * out of scope for this feature). Virtualization makes the same stale closure substantially worse: it also
   * freezes `windowRange`/`windowStartChar`/`windowEndChar`/`wrapMeasure` at mount, so a resize *after the
   * window has ever moved* writes its freshly-measured rows at the wrong absolute line indices (or slices a
   * `windowText` that no longer matches what's actually rendered in `highlightEl`, which can make
   * `computeRowsPerLine` return `null` and silently do nothing) — found live: scrolling a huge file away from
   * its mount-time window, then narrowing the frame, left the gutter showing flat one-row-per-line spacing
   * even though the content was visibly wrapping into several rows. A ref holding the *latest* function avoids
   * this without touching the observer's own subscribe/unsubscribe lifecycle (still mount-only, still cheap). */
  const measureWrappedRowsRef = useRef(measureWrappedRows)
  measureWrappedRowsRef.current = measureWrappedRows
  useEffect(() => {
    const frame = frameRef.current
    if (!frame || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      fit()
      // A width change (the window resized, a split pane dragged) can change where every wrapped line now
      // breaks — a height-only change (typing, which `fit()` above already reacts to) can't, and happens far
      // more often, so this is narrowed to width specifically rather than re-measuring on every resize tick.
      // `full`: a width change can move where *every* line wraps, unchanged text included, so every line's
      // known row count — not just the current window's — has to be treated as stale.
      const width = entries[0]?.contentRect.width
      if (width !== undefined && width !== lastFrameWidth.current) {
        lastFrameWidth.current = width
        measureWrappedRowsRef.current(true)
      }
    })
    observer.observe(frame)
    return () => observer.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => () => {
    if (visibleLineRaf.current !== null) cancelAnimationFrame(visibleLineRaf.current)
  }, [])

  /** The scroll frame's own `scroll` event. Two independent things happen here, both reading the frame's own
   * current `scrollTop`/`clientHeight` directly (never throttled for the first, since it's cheap arithmetic —
   * no DOM measurement, no layout, just comparisons against numbers already in hand):
   *
   * 1. **The virtualized window's own hysteresis check**: once the *unbuffered* visible range gets within one
   *    screen of the current window's own edge (the buffer `WINDOW_BUFFER_SCREENS` built in is being eaten
   *    into), recompute a fresh, fully-buffered window from the current scroll position and adopt it. Checking
   *    the remaining margin — not comparing the newly-*desired* window against the current one directly — is
   *    what keeps a one-pixel scroll from thrashing a rebuild of a many-hundred-line window on every tick: right
   *    after adopting a fresh window the margin on both sides is a full `WINDOW_BUFFER_SCREENS` again, so the
   *    next shift only fires after genuinely scrolling most of that buffer away.
   * 2. **Mirror-scroll's own "the editor scrolled" half** (rAF-throttled, unchanged) — `lineHeight` comes from
   *    the box itself (`getComputedStyle` always resolves it to an absolute px value, however it was authored),
   *    matching the gutter's own font/line-height exactly. */
  function handleScroll() {
    const frame = frameRef.current
    if (frame) {
      const lineHeightPx = gutterRowStarts.lineHeightPx
      const windowStartRow = windowRange.startLine <= 0 ? -Infinity : gutterRowStarts.starts[windowRange.startLine]
      const windowEndRow = windowRange.endLine >= lineCount ? Infinity : gutterRowStarts.starts[windowRange.endLine]
      const screenRows = Math.max(1, frame.clientHeight / lineHeightPx)
      const visibleStartRow = frame.scrollTop / lineHeightPx
      const visibleEndRow = visibleStartRow + screenRows
      if (visibleStartRow - windowStartRow < screenRows || windowEndRow - visibleEndRow < screenRows) {
        setWindowRange(computeWindowRange(frame.scrollTop, frame.clientHeight, lineHeightPx, gutterRowStarts.starts, WINDOW_BUFFER_SCREENS))
      }
    }
    if (!onVisibleLineChange || visibleLineRaf.current !== null) return
    visibleLineRaf.current = requestAnimationFrame(() => {
      visibleLineRaf.current = null
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
  const gutterDigits = Math.max(2, String(lineCount).length)
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
            <div className="code-editor-gutter" aria-hidden="true" style={{ minWidth: `calc(${gutterDigits}ch + 16px)` }}>
              {/* Only the current window's own lines get a real `<span>` — see the component's own module doc for
                  why this is safe (each one's `top` already comes from the *full* `gutterRowStarts.starts`, so
                  removing some simply leaves the gaps between them blank, never misplacing the ones that remain). */}
              {Array.from({ length: windowRange.endLine - windowRange.startLine }, (_, j) => {
                const i = windowRange.startLine + j
                return (
                  // A position:absolute child is placed relative to its containing block's *padding* edge, ignoring
                  // that padding for its own offset — so the 8px top offset (matching `.code-editor-highlight`'s
                  // own top padding, App.css) has to be added back here explicitly; `.code-editor-gutter` itself no
                  // longer has any padding of its own left to do this for free.
                  <span key={i} className="code-editor-gutter-number" style={{ top: `${8 + gutterRowStarts.starts[i] * gutterRowStarts.lineHeightPx}px` }}>
                    {i + 1}
                  </span>
                )
              })}
            </div>
          )}
          <div className="code-editor-content">
            {/* No children/`dangerouslySetInnerHTML` prop at all: only `RunPatchController` (above) ever touches
                what's inside this element — see its own module doc for why that's what makes mixing imperative
                DOM management with React safe here. `paddingTop` re-anchors the window's own rendered content to
                the Y position it would actually have in the full, unvirtualized document — the existing fixed
                8px (App.css) plus the pixel height of every line *before* the window, read from the same
                `gutterRowStarts` the gutter's own numbers use, so the two always agree. */}
            <pre
              ref={highlightRef}
              className={`code-editor-highlight ${settings?.showWhitespace ? 'code-editor-show-whitespace' : ''}`}
              aria-hidden="true"
              style={{ paddingTop: 8 + (gutterRowStarts.starts[windowRange.startLine] ?? 0) * gutterRowStarts.lineHeightPx }}
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
