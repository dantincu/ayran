/** The experimental editor's own DOM half (`CodeEditor.tsx`'s "Experimental code editor" setting,
 * `editorSettings.ts`): applies a `RunPatch` (`highlightTokens.ts`) to a real `<pre>`'s children directly,
 * instead of the default path's one `dangerouslySetInnerHTML` write per change. React is told nothing about
 * this `<pre>`'s *children* at all (no `dangerouslySetInnerHTML`, no JSX children) — only this controller ever
 * touches them, which is the one thing that makes mixing imperative DOM management with React safe: React never
 * tries to reconcile a subtree it was never given anything to reconcile.
 *
 * Keeps its own `liveValue`/`liveRuns`/`liveNodes` — never re-reads them from the DOM (there is nothing to
 * "trust the structure of" here: the DOM *is* exactly what the last patch put there, by construction, so there
 * is nothing to re-derive) — and every patch keeps all three in lockstep, so the next patch always diffs against
 * what is genuinely on screen right now. */

import { classAtOffset, diffRuns, markWhitespaceRuns, splitRunsAt, tokensOf, type Run } from './highlightTokens'

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
  /** `null` means "nothing live yet" — a fresh container (just mounted, or the experimental setting was just
   * turned on) with nothing patched into it. Treated the same as an empty previous value by both `apply*`
   * methods below, not as a special case: there is no meaningful "old" content to diff against, so the next
   * patch degrades to building the whole thing fresh, exactly like a genuine full replace would. */
  private liveValue: string | null = null
  private liveRuns: Run[] = []
  private liveNodes: Node[] = []
  /** Avoids re-tokenising the *same* exact html on every approximate step in a row (the common case: several
   * keystrokes land before the Worker's next reply) — keyed by reference-cheap string equality, not identity,
   * since the exact html itself is what's compared against on the next call. */
  private tokenCache: { html: string; runs: Run[] } | null = null

  /** Call every render with whatever the currently-rendered managed `<pre>` is (`null` while not in experimental
   * mode). A different element than last time — the setting was just turned on, the component just mounted, or
   * switching platforms swapped which `<pre>` is live — drops all live state, so the next apply starts from a
   * clean slate rather than trying to patch an element it never actually wrote to. */
  attachContainer(container: HTMLElement | null): void {
    if (container === this.container) return
    this.container = container
    this.liveValue = null
    this.liveRuns = []
    this.liveNodes = []
  }

  private tokensOfCached(html: string): Run[] {
    if (this.tokenCache?.html === html) return this.tokenCache.runs
    const runs = tokensOf(html)
    this.tokenCache = { html, runs }
    return runs
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

  /** The instant, approximate patch for one keystroke — the experimental path's counterpart to the default
   * path's "wrap the *whole* current text in one flat colour" guess (`CodeEditor.tsx`'s `useBackgroundHighlighted`):
   * here, only the character span the edit actually touched is replaced (approximated with the caret's own
   * colour, read from `lastExactHtml` exactly as the default path already does) — everything before and after
   * that span is kept as the real, already-correct nodes already on screen, untouched. This is what removes
   * both the full-subtree DOM replace *and* the brief whole-document colour flash the default path's own
   * approximation causes on every single keystroke (confirmed live, below). */
  applyApproximate(newValue: string, lastExactHtml: string, caretOffset: number): void {
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
    const cls = classAtOffset(this.tokensOfCached(lastExactHtml), caretOffset)
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
   * loses the latest one — replaces it properly once *it* resolves instead; this one is simply dropped. */
  applyExact(html: string, forValue: string, currentValue: string): void {
    if (!this.container || forValue !== currentValue) return
    const runs = this.tokensOfCached(html)
    if (this.liveValue === null) this.rebuild(forValue, runs)
    else this.patch(forValue, runs)
  }
}
