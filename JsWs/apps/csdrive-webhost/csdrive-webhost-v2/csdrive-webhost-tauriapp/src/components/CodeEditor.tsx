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
import { RunPatchController } from '../lib/runPatchController'

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
 * **The real pass**, in `highlightWorker.ts`, goes through a `HighlightScheduler` (`lib/highlightScheduler.ts`):
 * it keeps at most one request running in the Worker at a time, so a person typing faster than one full re-scan
 * takes is never queued up behind a growing backlog of stale requests — only the *latest* text is ever waiting,
 * picked up the instant the Worker is free, and the Worker's answer replaces the instant guess the moment it
 * arrives.
 *
 * **Dispatching to that scheduler is itself debounced by `EXACT_DISPATCH_DEBOUNCE_MS`**, asked for directly after
 * a large real file (hundreds of KB) was reported as consistently harder to type in and "bad for the eyes" —
 * not a main-thread stall (the Worker already keeps that off the critical path) but the *sustained* cost of
 * running a full re-scan back to back on every single settled keystroke while someone types continuously: each
 * exact reply also means re-parsing/laying out a large HTML string on the main thread (`setHtml`, or the
 * experimental path's own diff — see `RunPatchController`), which is real, repeated work for a big file even
 * though each individual pass is "only" off the main thread. On a phone this is also squarely a battery
 * question, which is what was actually asked about — a heuristic that decides, per keystroke, whether a
 * re-scan is even *needed* (the first idea floated) was turned down: that would mean mirroring every highlighter's
 * own keyword/escape/boundary rules in a second, approximate form, and a wrong "safe to skip" guess produces a
 * silently stuck wrong colour that nothing afterward self-corrects — a worse failure mode than today's
 * always-eventually-correct Worker pass. Debouncing the *dispatch* instead needs none of that: the approximate,
 * instant stand-in above already makes every keystroke feel immediate regardless of when the exact pass actually
 * runs, so delaying *only* the Worker call — reset on every further keystroke, fired once typing actually pauses
 * for `EXACT_DISPATCH_DEBOUNCE_MS` — cuts how often the whole dispatch → Worker → reply → reparse cycle runs
 * during a sustained burst, with no new correctness surface: a person who never pauses simply keeps seeing the
 * approximate colouring (already correct for the overwhelmingly common case of typing inside the same token) until
 * they do, the same guarantee the scheduler's own coalescing already relies on elsewhere.
 *
 * **The debounce above wasn't the whole story on the same real file, found live while verifying it**: toggling
 * the experimental editor on and off made almost no measurable difference on a real 190 KB markdown transcript,
 * which shouldn't have been true — `RunPatchController.applyApproximate` is specifically the *cheaper*,
 * localised approximate pass. Timing each keystroke directly (`performance.now()` around a real
 * `document.execCommand('insertText', …)`, not a synthetic event) showed why: this hook's own approximate branch
 * — `tokenClassAtOffset` scanning up to the caret, then `escapeHtml`/`markWhitespace` scanning the *entire*
 * value — ran **unconditionally on every keystroke, in both modes**, costing over 100ms by itself on that file,
 * even though in experimental mode its result (`html`) is never actually rendered (`CodeEditor`'s own JSX gives
 * the experimental `<pre>` no `dangerouslySetInnerHTML`) — pure waste sitting in front of the patcher's own,
 * already-cheaper work. **Fixed** by skipping that computation entirely while `experimental` is on, setting
 * `html` to a cheap, merely-identity-changing placeholder instead (a counter) — all it still needs to provide,
 * since nothing reads its *content* in that mode, only the scroll-to-bottom effect below reacting to it having
 * changed at all. The default editor's own cost here is unchanged (and unavoidable without replacing its
 * rendering with the same token-diff approach, which wasn't asked for): it actually renders this string, so
 * nothing here was wasted work for it.
 *
 * **The very first render is still computed synchronously**, on the main thread, exactly as before this change —
 * there's no previous *exact* highlight yet to approximate a caret colour from, and a freshly opened file should
 * show correctly coloured from its first paint, not a flash of plain text while the Worker starts up. Every
 * change after that goes through the Worker.
 *
 * **Also returns `exact`** — the same `{value, language, html}` snapshot kept internally for the caret-colour
 * lookup above, but as reactive state rather than a plain ref, updated *only* when a genuinely new exact result
 * lands (the very first synchronous one, or a Worker reply) — never on an approximate step. The experimental
 * editor's own DOM patcher (`lib/runPatchController.ts`, wired up in `CodeEditor` below) reacts to this
 * separately from `html` itself: it needs to know precisely when a *real* tokenisation is ready to diff
 * against, which `html` alone (updated on both approximate and exact steps) can't tell it. */
function useBackgroundHighlighted(
  value: string,
  language: Language,
  caretOffset: () => number,
  experimental: boolean,
): { html: string; exact: ExactResult } {
  const trailer = (text: string) => (text.endsWith('\n') ? ' ' : '')
  const schedulerRef = useRef<HighlightScheduler<{ text: string; language: Language }, string> | null>(null)
  /** A cheap, ever-changing stand-in for `html` used only while `experimental` is on — see the `useLayoutEffect`
   * below for why the real approximate computation is skipped entirely in that mode. */
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
    // The experimental editor's own DOM patcher (`RunPatchController.applyApproximate`) does its own, already
    // cheaper, localised approximate colouring directly against the managed `<pre>` — this hook's `html` state
    // is never rendered in that mode at all (`CodeEditor`'s own JSX gives the experimental `<pre>` no
    // `dangerouslySetInnerHTML`), so recomputing the exact same full-document escape-and-whitespace-mark here,
    // every keystroke, just to throw the result away was pure, unconditional waste — confirmed live against a
    // real 190 KB file: this one computation alone (`tokenClassAtOffset` scanning up to the caret, `escapeHtml`
    // and `markWhitespace` both scanning the *entire* value) cost upward of 100ms per keystroke, present on
    // *every* keystroke regardless of the exact-dispatch debounce above (which only ever touched the Worker
    // side of this, not this synchronous one) — exactly the "typing is harder on a big file" symptom this was
    // asked about, and the reason the experimental editor measured no faster than the default one on that file
    // before this fix, despite its own patcher being the cheaper design. A placeholder that merely changes
    // identity every time is all `html` still needs to provide here: the scroll-to-bottom effect below keys off
    // it to know an approximate *or* exact pass just landed, never its actual content.
    if (experimental) {
      placeholderTick.current++
      setHtml(String(placeholderTick.current))
    } else {
      const cls = last ? tokenClassAtOffset(last.html, caretOffset()) : null
      const approximate = markWhitespace(cls ? `<span class="${cls}">${escapeHtml(value)}</span>` : escapeHtml(value))
      setHtml(approximate + trailer(value))
    }
    if (dispatchTimer.current !== null) clearTimeout(dispatchTimer.current)
    dispatchTimer.current = setTimeout(() => {
      dispatchTimer.current = null
      schedulerRef.current?.request({ text: value, language })
    }, EXACT_DISPATCH_DEBOUNCE_MS)
  }, [value, language, experimental])

  return { html, exact }
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
  const effectiveLanguage = language ?? languageOf(fileName)
  const caretOffset = () => inputRef.current?.selectionEnd ?? value.length
  const [settings, setSettings] = useState<EditorSettings | null>(null)
  useEffect(() => subscribeEditorSettings(setSettings), [])
  const experimental = settings?.experimentalEditor ?? false
  const { html, exact } = useBackgroundHighlighted(value, effectiveLanguage, caretOffset, experimental)

  /** The experimental editor's own DOM half (`lib/runPatchController.ts`) — one controller per mounted editor,
   * reused across every patch; its own module doc explains why it owns this state independently of React
   * rather than ever re-reading the real DOM. Two effects, not one, each attaching the container itself first
   * (a cheap no-op when it hasn't actually changed): the approximate patch reacts to exactly what the default
   * path's own approximation does (`[value, effectiveLanguage]`), the exact patch only to a genuinely *new*
   * exact result landing (`exact`'s own identity, not `value`) — reading the current `value` inside it, at the
   * moment it runs, is deliberate (see `RunPatchController.applyExact`'s own doc comment on why a reply for an
   * older value must be told apart from one for the current value, not just applied). */
  const runPatchController = useRef<RunPatchController | null>(null)
  if (!runPatchController.current) runPatchController.current = new RunPatchController()
  useLayoutEffect(() => {
    const controller = runPatchController.current!
    controller.attachContainer(experimental ? highlightRef.current : null)
    if (!experimental) return
    controller.applyApproximate(value, exact.html, caretOffset())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, effectiveLanguage, experimental])
  useLayoutEffect(() => {
    const controller = runPatchController.current!
    controller.attachContainer(experimental ? highlightRef.current : null)
    if (!experimental) return
    controller.applyExact(exact.html, exact.value, value)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exact, experimental])

  /** How many visual rows each source line actually occupies once wrapped, and the pixel `line-height` it was
   * measured against — `null` until the first measurement lands (the gutter falls back to one row per line until
   * then, the same thing it always showed before this existed). See `lib/wrappedLineRows.ts`'s own doc comment
   * for why this can't be a character-count calculation and has to measure the real, already-wrapped DOM.
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
  const measureWrappedRows = () => {
    const highlightEl = highlightRef.current
    if (!highlightEl || settings?.wrapLines === false) return
    // A file this long would mean tens of thousands of Range measurements, a real pause rather than the brief
    // background pass this is meant to be — the same kind of size-based safety net `useBackgroundHighlighted`
    // already has for a different reason. Falls back to one row per line, same as before this feature existed.
    if (value.split('\n').length > MAX_LINES_FOR_WRAP_MEASUREMENT) return
    const lineHeightPx = parseFloat(getComputedStyle(highlightEl).lineHeight) || 0
    const rows = computeRowsPerLine(highlightEl, value, lineHeightPx)
    if (rows) setWrapMeasure({ value, rows, lineHeightPx })
  }
  // Deferred (not a `useLayoutEffect`) and off `value`/`settings?.wrapLines` only — not `html`, which also changes
  // for the *approximate* and then the *exact* highlight pass of the very same edit (`useBackgroundHighlighted`):
  // wrapping only depends on the text itself, never on which colour a span is drawn in, so measuring twice for
  // one edit would be pure waste. Measuring is real DOM work (`getBoundingClientRect` forces layout), exactly the
  // kind of thing this file already keeps off a keystroke's own critical path.
  //
  // **Debounced by `WRAP_MEASURE_DEBOUNCE_MS`, not just deferred by one tick** — found live, by CPU-profiling a
  // real 190 KB file while typing a short burst: `getClientRects` (called once per source line by
  // `computeRowsPerLine`, below) was by far the single hottest thing in the whole profile — roughly 80ms per
  // keystroke on that file, dwarfing the cost of highlighting itself (the actual thing item #8's own debounce,
  // `EXACT_DISPATCH_DEBOUNCE_MS` above, was built for) and present identically whether the experimental editor
  // was on or off, since the gutter is unrelated to which one is rendering the text. A plain `setTimeout(fn, 0)`
  // still measures on every settled keystroke during continuous typing (each one gets its own macrotask to run
  // in before the next keystroke's own effect replaces it) — resetting the timer on every further keystroke,
  // the same lever as the Worker dispatch above, means a sustained burst pays this cost once, after it actually
  // stops, not once per keystroke.
  useEffect(() => {
    const id = setTimeout(measureWrappedRows, WRAP_MEASURE_DEBOUNCE_MS)
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
   * update this needs to catch that a plain `[value]` effect wouldn't fire for again. */
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
            {/* Two genuinely different elements, not one re-purposed — `key` forces a clean remount rather than
                React trying to reconcile "has dangerouslySetInnerHTML" into "has none" (or back) on the same
                node across a mode switch. The experimental one is given no children/`dangerouslySetInnerHTML`
                prop at all: only `RunPatchController` (above) ever touches what's inside it — see its own
                module doc for why that's what makes mixing imperative DOM management with React safe here. */}
            {experimental ? (
              <pre
                key="experimental"
                ref={highlightRef}
                className={`code-editor-highlight ${settings?.showWhitespace ? 'code-editor-show-whitespace' : ''}`}
                aria-hidden="true"
              />
            ) : (
              <pre
                key="default"
                ref={highlightRef}
                className={`code-editor-highlight ${settings?.showWhitespace ? 'code-editor-show-whitespace' : ''}`}
                aria-hidden="true"
                dangerouslySetInnerHTML={{ __html: html }}
              />
            )}
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
