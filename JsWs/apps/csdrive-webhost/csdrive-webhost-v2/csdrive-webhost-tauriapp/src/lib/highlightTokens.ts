/** A `highlight()` result (`lib/highlight.ts`), broken into **runs** — the data the editor's own DOM
 * patcher (`lib/runPatchController.ts`) diffs and applies, instead of replacing the whole highlighted copy's
 * `innerHTML` on every change (`components/CodeEditor.tsx`'s own module doc, "Editor performance" in CLAUDE.md).
 *
 * A **run** is a maximal, uniformly-styled slice: plain text (`classes: []`), or text wrapped in one `tok-*` span
 * (`classes: ['tok-string']`), or — the one place `highlight()`'s own output nests — a whitespace character
 * `markWhitespace` wrapped a second time inside an already-coloured span (`classes: ['tok-string', 'tok-ws
 * tok-ws-space']`). `classes` is always the *outer-to-inner* order the real spans would nest in; a leaf run is
 * **never shared across two different real `<span>` elements** the way `highlight()`'s own html would nest them —
 * each run gets its *own*, independently-built chain of wrapper elements (`buildRunNode`) rather than one wrapper
 * holding several runs as children. This is deliberately simpler than mirroring the real nesting tree exactly,
 * and verified safe: every `tok-*` class in `App.css` is a plain `color`/`font-weight`/`text-decoration`/`opacity`
 * rule with no sibling or adjacency selector, and the only element-boundary-sensitive rule (`tok-ws-*`'s own
 * `::before` dot/arrow, one per element) already can't be affected either way, since a whitespace run is always
 * exactly one character and is never merged with a neighbour (see `markWhitespaceRuns` below) — so splitting what
 * would have been one shared wrapper into several sibling wrappers of the same class changes no visible pixel.
 *
 * The one rule carried over from `highlight()` itself: a run list's concatenated `text` must reconstruct the
 * original plain text exactly, character for character — `tokensOf` only ever un-escapes `&amp;`/`&lt;`/`&gt;`
 * back to their characters, never drops or reorders anything. */

export interface Run {
  /** Outer-to-inner wrapper classes; `[]` for a run with no `<span>` of its own. */
  readonly classes: readonly string[]
  readonly text: string
}

/** Parses a `highlight()`-produced html string into its runs — the same tag/entity walk `tokenClassAtOffset`
 * (`lib/highlight.ts`) already does to find one class at one offset, generalised to building the whole run list
 * instead of stopping partway. Assumes `highlight()`'s own shape: every tag is either `<span class="…">` or
 * `</span>` (never anything else — `highlight()` only ever emits those two plus escaped text/entities). */
export function tokensOf(html: string): Run[] {
  const runs: Run[] = []
  const stack: string[] = []
  let buf = ''
  let i = 0
  const flush = () => {
    if (buf !== '') runs.push({ classes: stack.slice(), text: buf })
    buf = ''
  }
  while (i < html.length) {
    if (html[i] === '<') {
      const close = html.indexOf('>', i)
      if (close < 0) break
      const tag = html.slice(i, close + 1)
      const open = /^<span class="([^"]*)">$/.exec(tag)
      if (open) {
        flush()
        stack.push(open[1])
      } else if (tag === '</span>') {
        flush()
        stack.pop()
      }
      i = close + 1
      continue
    }
    if (html[i] === '&') {
      const entity = /^&amp;|^&lt;|^&gt;/.exec(html.slice(i, i + 5))
      if (entity) {
        buf += entity[0] === '&amp;' ? '&' : entity[0] === '&lt;' ? '<' : '>'
        i += entity[0].length
        continue
      }
    }
    buf += html[i]
    i++
  }
  flush()
  return runs
}

function runsEqual(a: Run, b: Run): boolean {
  if (a.text !== b.text || a.classes.length !== b.classes.length) return false
  for (let i = 0; i < a.classes.length; i++) if (a.classes[i] !== b.classes[i]) return false
  return true
}

export interface RunPatch {
  /** How many runs at the start of the old list are unchanged and kept as they are. */
  prefixCount: number
  /** How many runs right after `prefixCount` are removed. */
  deleteCount: number
  /** What replaces them, in order. */
  insertRuns: Run[]
}

/** The smallest edit — trim the common prefix, then the common suffix — that turns `oldRuns` into `newRuns`.
 * Not a general (Myers-style) sequence diff: a text editor's own edits are almost always localised (one
 * keystroke, one paste, one find-and-replace), and prefix/suffix trimming finds exactly that minimal changed
 * middle for a localised edit, in time linear in the run count rather than quadratic. A edit that shares
 * nothing with the old text (a different file loaded into the same editor instance) degrades to "delete
 * everything, insert everything" — the same cost a full replace already has today, never worse. */
export function diffRuns(oldRuns: readonly Run[], newRuns: readonly Run[]): RunPatch {
  const maxPrefix = Math.min(oldRuns.length, newRuns.length)
  let prefix = 0
  while (prefix < maxPrefix && runsEqual(oldRuns[prefix], newRuns[prefix])) prefix++
  const maxSuffix = Math.min(oldRuns.length, newRuns.length) - prefix
  let suffix = 0
  while (suffix < maxSuffix && runsEqual(oldRuns[oldRuns.length - 1 - suffix], newRuns[newRuns.length - 1 - suffix])) suffix++
  return { prefixCount: prefix, deleteCount: oldRuns.length - prefix - suffix, insertRuns: newRuns.slice(prefix, newRuns.length - suffix) }
}

/** Splits a run list at an exact character offset into its own text — used to carve "the part of the live runs
 * before/after the edited span" out of what's already on screen, for the *approximate* instant patch (there is
 * no fresh tokenisation to diff against yet, only the edit's own character-level boundaries). Splitting a run
 * that straddles the offset keeps its classes on both halves, only dividing its text. */
export function splitRunsAt(runs: readonly Run[], offset: number): [Run[], Run[]] {
  const left: Run[] = []
  const right: Run[] = []
  let pos = 0
  for (const run of runs) {
    const end = pos + run.text.length
    if (end <= offset) left.push(run)
    else if (pos >= offset) right.push(run)
    else {
      const cut = offset - pos
      left.push({ classes: run.classes, text: run.text.slice(0, cut) })
      right.push({ classes: run.classes, text: run.text.slice(cut) })
    }
    pos = end
  }
  return [left, right]
}

/** The first class in `classAttr` that actually names a colour — `tok-ws` on its own carries none (only
 * `tok-ws-space`/`tok-ws-tab`/`tok-ws-nbsp` are styled); mirrors `tokenClassAtOffset`'s own rule exactly. */
function namedClassOf(classAttr: string): string | null {
  return classAttr.split(/\s+/).find((c) => c.startsWith('tok-') && c !== 'tok-ws') ?? null
}

/** The run colour (`lib/highlight.ts`'s `tokenClassAtOffset`, re-expressed over a run list instead of a raw html
 * string) immediately *before* `offset` — so continuing to type at the caret keeps whatever colour the character
 * to its left had (inside a string stays "string colour", and so on). `null` for `offset <= 0` or plain text. */
export function classAtOffset(runs: readonly Run[], offset: number): string | null {
  if (offset <= 0) return null
  let pos = 0
  for (const run of runs) {
    const end = pos + run.text.length
    if (offset <= end) {
      for (let i = run.classes.length - 1; i >= 0; i--) {
        const named = namedClassOf(run.classes[i])
        if (named) return named
      }
      return null
    }
    pos = end
  }
  return null
}

const WS_KIND: Record<string, string> = { '\t': 'tab', ' ': 'nbsp' }

/** The `markWhitespace`-equivalent for one already-approximated run of text: every space, tab and non-breaking
 * space becomes its own single-character run wearing an extra `tok-ws tok-ws-…` class, same as the real
 * (exact-pass) highlighter does — kept here so the instant approximate patch doesn't visibly un-mark whitespace
 * in the one span it's guessing the colour of, for the brief moment before the Worker's exact pass replaces it.
 * Never merges two adjacent whitespace characters into one run, matching `markWhitespace`'s own one-`::before`-
 * per-element behaviour (`highlight.ts`'s own doc comment). */
export function markWhitespaceRuns(text: string, classes: readonly string[]): Run[] {
  const runs: Run[] = []
  let buf = ''
  const flush = () => {
    if (buf !== '') runs.push({ classes, text: buf })
    buf = ''
  }
  for (const c of text) {
    const kind = WS_KIND[c] ?? (c === ' ' ? 'space' : null)
    if (kind) {
      flush()
      runs.push({ classes: [...classes, `tok-ws tok-ws-${kind}`], text: c })
    } else {
      buf += c
    }
  }
  flush()
  return runs
}
