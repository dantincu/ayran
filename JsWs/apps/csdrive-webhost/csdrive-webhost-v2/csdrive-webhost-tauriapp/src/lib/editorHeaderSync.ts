/** A small, module-level coordination point between an autohiding header's own CSS transition
 * (`useScrollAutohide`) and the code editor's own scroll/resize-driven window-range recomputation that sits
 * below it — asked for directly: "it would be best not to mix hiding/showing the header with rerendering the
 * highlight markup... wait for the header to show/hide before rerendering the highlight markup and vice
 * versa." Both react to the same underlying scroll and resize events (a header collapsing/expanding changes
 * the editor's own `clientHeight`, which the editor's window-range math depends on), so letting them act at
 * the exact same instant risks compounding visual jumpiness the same way CLAUDE.md's "Typing after a fast
 * scroll" fix already found and fixed once, for an unrelated reason.
 *
 * **Deliberately not React state or context**: a transition's own duration is a real-world timer running
 * independently of any render, and at most one header and one editor ever share a page in this app, so a
 * plain module-level flag with a small subscriber list is both cheaper and simpler than routing this through
 * context for a one-to-one relationship. `runAfterHeaderTransition`/`runAfterHighlightRerender` run their
 * callback immediately when the relevant side is already idle — the common case, since both are normally
 * over well before the other side has anything to check. */

/** The header's own CSS transition duration (`max-height`/padding/border/margin, `.editor-top-bar-hidden`
 * and siblings in `App.css`/`notes.css`) — kept here, matched by hand to those rules, so a header's own
 * state-changing `useEffect` (below) knows how long to consider "still transitioning" after `hidden` flips,
 * without needing a real `transitionend` listener on an element this module never gets a ref to. */
export const HEADER_TRANSITION_MS = 250

let headerTransitioning = false
let highlightRerendering = false
const headerIdleListeners = new Set<() => void>()
const highlightIdleListeners = new Set<() => void>()

export function beginHeaderTransition(): void {
  headerTransitioning = true
}

export function endHeaderTransition(): void {
  if (!headerTransitioning) return
  headerTransitioning = false
  const listeners = [...headerIdleListeners]
  headerIdleListeners.clear()
  for (const fn of listeners) fn()
}

export function isHeaderTransitioning(): boolean {
  return headerTransitioning
}

/** Runs `fn` once the header isn't (or is no longer) transitioning — immediately, if it already isn't. */
export function runAfterHeaderTransition(fn: () => void): void {
  if (!headerTransitioning) {
    fn()
    return
  }
  headerIdleListeners.add(fn)
}

export function beginHighlightRerender(): void {
  highlightRerendering = true
}

export function endHighlightRerender(): void {
  if (!highlightRerendering) return
  highlightRerendering = false
  const listeners = [...highlightIdleListeners]
  highlightIdleListeners.clear()
  for (const fn of listeners) fn()
}

export function isHighlightRerendering(): boolean {
  return highlightRerendering
}

/** Runs `fn` once the editor isn't (or is no longer) re-rendering its highlight markup — immediately, if it
 * already isn't (the overwhelmingly common case: `RunPatchController`'s own DOM patches are synchronous and
 * fast, so by the time anything else gets a chance to check, they're almost always already done). */
export function runAfterHighlightRerender(fn: () => void): void {
  if (!highlightRerendering) {
    fn()
    return
  }
  highlightIdleListeners.add(fn)
}
