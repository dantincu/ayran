/** The editor's own DOM half (`CodeEditor.tsx`): applies a `RunPatch` (`highlightTokens.ts`) to a real `<pre>`'s
 * children directly, rather than a single `dangerouslySetInnerHTML` write per change — this is what removes the
 * flicker a full subtree replace causes on every keystroke (this used to be an opt-in setting, off by default,
 * until it became the editor's only rendering mechanism — `CodeEditor.tsx`'s own module doc has the history).
 * React is told nothing about this `<pre>`'s *children* at all (no `dangerouslySetInnerHTML`, no JSX children) —
 * only this controller ever touches them, which is the one thing that makes mixing imperative DOM management
 * with React safe: React never tries to reconcile a subtree it was never given anything to reconcile.
 *
 * Keeps its own `liveValue`/`liveRuns`/`liveNodes` — never re-reads them from the DOM (there is nothing to
 * "trust the structure of" here: the DOM *is* exactly what the last patch put there, by construction, so there
 * is nothing to re-derive) — and every patch keeps all three in lockstep, so the next patch always diffs against
 * what is genuinely on screen right now. */

import { classAtOffset, diffRuns, markWhitespaceRuns, splitRunsAt, type Run } from './highlightTokens'

function buildRunNode(run: Run): Node {
  let node: Node = document.createTextNode(run.text)
  for (let i = run.classes.length - 1; i >= 0; i--) {
    const span = document.createElement('span')
    span.className = run.classes[i]
    span.appendChild(node)
    node = span
  }
  return node
}

export class RunPatchController {
  private container: HTMLElement | null = null
  /** `null` means "nothing live yet" — a fresh container (just mounted) with nothing patched into it. Treated
   * the same as an empty previous value by both `apply*` methods below, not as a special case: there is no
   * meaningful "old" content to diff against, so the next patch degrades to building the whole thing fresh,
   * exactly like a genuine full replace would. */
  private liveValue: string | null = null
  private liveRuns: Run[] = []
  private liveNodes: Node[] = []

  /** Call every render with whatever the currently-rendered managed `<pre>` is. A different element than last
   * time — the component just mounted, or switching platforms swapped which `<pre>` is live — drops all live
   * state, so the next apply starts from a clean slate rather than trying to patch an element it never actually
   * wrote to. */
  attachContainer(container: HTMLElement | null): void {
    if (container === this.container) return
    this.container = container
    this.resetLiveState()
  }

  /** Drops all live state without touching the container element itself — `attachContainer` only does this
   * when the element genuinely changes, but the editor's own virtualized window (`CodeEditor.tsx`) can shift to
   * a differently-positioned slice of the document while the *same* `<pre>` stays mounted throughout. Diffing
   * the old window's slice against the new one would find almost nothing in common even for a one-line scroll
   * (the two slices are offset, not merely appended-to), so there's no reason to try: the next `apply*` call
   * degrades straight to a full rebuild, exactly as it already does for a fresh container — cheap precisely
   * because a window's own content is bounded in size, unlike the document it's a slice of. */
  resetLiveState(): void {
    this.liveValue = null
    this.liveRuns = []
    this.liveNodes = []
  }

  private rebuild(value: string, runs: Run[]): void {
    const container = this.container
    if (!container) return
    while (container.firstChild) container.removeChild(container.firstChild)
    const nodes = runs.map(buildRunNode)
    for (const node of nodes) container.appendChild(node)
    this.liveValue = value
    this.liveRuns = runs
    this.liveNodes = nodes
  }

  private patch(value: string, candidateRuns: Run[]): void {
    const container = this.container
    if (!container) return
    const diff = diffRuns(this.liveRuns, candidateRuns)
    const insertNodes = diff.insertRuns.map(buildRunNode)
    // Captured before removing anything: removing nodes *before* this one in the list never moves it, so it
    // stays a valid insertion point (or `null`, meaning "append at the end") throughout.
    const anchor = this.liveNodes[diff.prefixCount + diff.deleteCount] ?? null
    for (let i = 0; i < diff.deleteCount; i++) container.removeChild(this.liveNodes[diff.prefixCount + i])
    for (const node of insertNodes) container.insertBefore(node, anchor)
    this.liveNodes = [...this.liveNodes.slice(0, diff.prefixCount), ...insertNodes, ...this.liveNodes.slice(diff.prefixCount + diff.deleteCount)]
    this.liveValue = value
    this.liveRuns = candidateRuns
  }

  /** The instant, approximate patch for one keystroke: only the character span the edit actually touched is
   * replaced (approximated with the caret's own colour), while everything before and after that span is kept
   * as the real, already-correct nodes already on screen, untouched. This is what removes both the
   * full-subtree DOM replace *and* the brief whole-document colour flash a cruder "wrap the *whole* current
   * text in one flat colour" guess would cause on every single keystroke (confirmed live, below) — a once-real
   * alternative, now gone (`CodeEditor.tsx`'s own module doc has the history).
   *
   * **Takes `exactRuns` as already-parsed `Run[]`, never an html string** — this controller used to parse (and
   * cache) the last exact html itself (`tokensOfCached`, since removed); once the editor's own rendering became
   * virtualized, the caller (`CodeEditor.tsx`) already has to parse the *full* exact html into runs anyway
   * (memoized on the exact result's own identity — the same caching benefit this controller's own cache used
   * to provide), so this reuses that one parse rather than asking this controller to redundantly parse an html
   * string a second time.
   *
   * **`newValue` is whatever slice the caller wants rendered (the current window's own text) — `exactRuns` and
   * `caretOffset` are deliberately *not* sliced to match it, and stay on the *whole document's* own basis.**
   * This controller has no concept of a "whole document" to slice from, so it never compares the two bases
   * against each other directly — `exactRuns`/`caretOffset` are used *only* for `classAtOffset` below (an
   * internally self-consistent pair, since both already came from the caller's own full exact result), to
   * read a single colour-at-the-caret guess, which is then applied as a flat colour to whatever `middleText`
   * (computed purely from `newValue`'s own, window-relative offsets) turns out to be. Keeping `exactRuns`
   * unsliced here is deliberate, not an oversight: slicing it (`splitRunsAt`, itself an `O(whole document)`
   * walk) would otherwise run on *every* approximate step — every keystroke — the same class of cost already
   * found and removed once this session for a different function (`carryForwardRows`'s own doc comment has
   * the story); `applyExact`, below, is the one place slicing to the window is unavoidable, and it only runs
   * on a debounced exact reply, not every keystroke. */
  applyApproximate(newValue: string, exactRuns: readonly Run[], caretOffset: number): void {
    if (!this.container) return
    const oldValue = this.liveValue ?? ''
    if (this.liveValue !== null && oldValue === newValue) return
    const maxPrefix = Math.min(oldValue.length, newValue.length)
    let prefix = 0
    while (prefix < maxPrefix && oldValue[prefix] === newValue[prefix]) prefix++
    const maxSuffix = Math.min(oldValue.length, newValue.length) - prefix
    let suffix = 0
    while (suffix < maxSuffix && oldValue[oldValue.length - 1 - suffix] === newValue[newValue.length - 1 - suffix]) suffix++
    const oldRuns = this.liveValue === null ? [] : this.liveRuns
    const [left] = splitRunsAt(oldRuns, prefix)
    const [, right] = splitRunsAt(oldRuns, oldValue.length - suffix)
    const middleText = newValue.slice(prefix, newValue.length - suffix)
    const cls = classAtOffset(exactRuns, caretOffset)
    const middleRuns = markWhitespaceRuns(middleText, cls ? [cls] : [])
    const candidate = [...left, ...middleRuns, ...right]
    if (this.liveValue === null) this.rebuild(newValue, candidate)
    else this.patch(newValue, candidate)
  }

  /** A fresh exact result from the Worker, for `forValue` — applied **only** if `forValue` still equals the
   * genuinely current value. A reply for an older text, arriving after further edits already landed (as
   * approximate patches, past it) would otherwise diff against state it was never actually computed from —
   * turning "patch toward what's correct" into "patch toward something stale," which could delete live,
   * already-correct content the newer edits put there (a real corruption, not just a stale colour, found by
   * reasoning through the design before any code existed to reproduce it live: unlike the default path, which
   * only ever shows a self-consistent — if momentarily stale — html string, patching live nodes against a
   * stale diff actively damages state that's already moved on). The newer request — `HighlightScheduler` never
   * loses the latest one — replaces it properly once *it* resolves instead; this one is simply dropped.
   *
   * **`value`/`runs` are the slice to actually render** (the current window's own text and runs, already cut
   * from the full exact result by the caller — see `applyApproximate`'s own doc comment for why this
   * controller no longer parses html itself), kept deliberately apart from `forValue`/`currentValue`, which
   * stay whole-document values: the staleness check above is about whether the *document* has moved on since
   * this exact result was computed, not about which window happens to be showing right now. */
  applyExact(value: string, runs: readonly Run[], forValue: string, currentValue: string): void {
    if (!this.container || forValue !== currentValue) return
    if (this.liveValue === null) this.rebuild(value, [...runs])
    else this.patch(value, [...runs])
  }
}
