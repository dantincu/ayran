import { useCallback, useEffect, useRef, useState } from 'react'

const HIDE_AFTER_PX = 40
const DIRECTION_THRESHOLD_PX = 4
/** How close `scrollTop + clientHeight` must be to `scrollHeight` to count as "pinned at the very bottom" — see
 * the module's own doc comment, "the shake". A couple of px of slack for rounding (a fractional `scrollHeight`,
 * sub-pixel layout), not a real tolerance for "nearly at the bottom". */
const AT_BOTTOM_SLACK_PX = 2

/**
 * Scroll-driven autohide, shared by every collapsing header in the app (the Help tab's own header, Notes' top bar,
 * and an editor page's own header row above its `CodeEditor`). A single `scroll` listener on `document`, in the
 * **capture** phase, sees a `scroll` event fired on *any* element in the page even though `scroll` itself never
 * bubbles — the capturing phase only needs the target to be a descendant of the listening node, not that the event
 * bubbles back up — and `document` is an ancestor of everything, so one listener covers both a page whose own
 * `.tab-content` scrolls (an ordinary long list) *and* a page whose outer area never overflows because it's a
 * fixed-height container with its own nested scrolling region instead (a text editor: a header, then a box that is
 * "as tall as its text" and scrolls internally — see CLAUDE.md's "The file editor"). Each scrolled element's own
 * last `scrollTop` is tracked separately (a `WeakMap`), so switching between scrolling two different areas on the
 * same page (the editor's own box, then — after scrolling it back up — a listing elsewhere) never misreads the
 * direction of the other. Returns `[hidden, show, hide]`: `show()`/`hide()` set it directly, for a caller's own
 * trigger (a button pressed again, an admin-triggered event, a programmatic scroll about to happen) — neither
 * touches scroll position itself.
 *
 * **Also shows itself again when the content that hid it stops overflowing at all** — a `ResizeObserver` on every
 * element it has seen a scroll event from (an editor's text shrinking a lot, a filtered-down list) checks, on every
 * resize, whether that element can still scroll (`scrollHeight > clientHeight`); the moment it can't, there's
 * nothing left for the header to be hidden *from*, so it's shown again rather than staying collapsed until the
 * person happens to scroll up. (A shrink that still leaves the element scrollable, or that also moves `scrollTop`
 * itself, is left to the ordinary scroll handling above — this only catches the case scrolling alone wouldn't.)
 *
 * **The shake, reported live** ("quickly scroll to the end of the editor... makes the entire page shake
 * continuously"): reproduced directly (a `MutationObserver` on the header's own `class`, jumping `.code-editor`'s
 * `scrollTop` straight to its maximum) — five hidden/shown flips inside about 1.5s, every one of them genuinely
 * caused, not imagined. The header sits *outside* the element whose scroll drives it (`.code-editor` is a `flex: 1`
 * sibling below it, not a descendant), but its own box still **grows by exactly the header's collapsed height**
 * the instant the header hides (confirmed live: `clientHeight` measured 568px shown, 628px hidden, a flat 60px —
 * the header's own `max-height` — every time). Scrolled all the way to the bottom, `scrollTop` was already sitting
 * at the *old* maximum (`scrollHeight - clientHeight`, with the header shown); the moment `clientHeight` grows by
 * 60px, that maximum **shrinks** by 60px too, and the browser clamps `scrollTop` down to fit — which fires a
 * genuine `scroll` event, with a negative delta, that this hook's own direction check used to read as "scrolled
 * up" and answer by showing the header again, which shrinks `clientHeight` back down and (since the `max-height`
 * transition animates over 0.25s, not instantly) repeats the whole thing in smaller steps across several frames.
 *
 * **A first fix tried a time-based "ignore scroll events for a bit after we just changed `hidden`" window** — the
 * person's own diagnosis named the right *shape* (something to stop the echo from being read as a real gesture),
 * but no fixed or even sliding duration held up: measured live, the gap between one echo and the next in a burst
 * was as long as ~480ms, so a short window reopened right into the next echo, while a window long enough to
 * survive a whole burst was indistinguishable, by *timing alone*, from someone genuinely continuing to scroll —
 * confirmed live the hard way: it also silently swallowed a real, deliberate scroll-down made shortly after a
 * real scroll-up, because both look identical to a clock with no other information.
 *
 * **The actual fix needs no clock at all**, because the echo has a shape nothing else does: it is a *negative*
 * delta (reads as "scrolled up") that still leaves the element **pinned at its own maximum scroll position**
 * (`top + clientHeight >= scrollHeight`, within [`AT_BOTTOM_SLACK_PX`]) — something a genuine upward scroll, by
 * definition, moves *away from*. So the direction check's "show" branch is skipped specifically when that holds;
 * every other branch (hiding on a real downward scroll, showing on reaching the very top, the resize fallback) is
 * untouched and fires immediately, with no delay and no window to time out of.
 *
 * **Typing itself must not hide or show the header** — asked for directly: the browser's own "keep the caret
 * visible" behaviour scrolls a text editor's box as a line is added past the bottom (or removed from below it),
 * which is a perfectly genuine `scroll` event, correctly directional and nowhere near "pinned at the bottom" the
 * way the shake's own echo is — so neither guard above catches it, and without a further fix every keystroke that
 * happens to cross the viewport's edge would hide (or show) the header exactly as if the person had scrolled on
 * purpose. The one thing that tells a content-driven scroll apart from a person's own gesture is `scrollHeight`
 * itself: typing (or deleting) a line changes the element's *total* content height, where a wheel turn, a
 * scrollbar drag or a Page Up/Down never does — only `scrollTop` moves for those. So each element's own
 * `scrollHeight` is tracked alongside its `scrollTop`, and a scroll event is skipped entirely (no hide, no show,
 * not even the "near the top" branch — `lastTop`/`lastHeight` are still updated, so the *next* genuine gesture's
 * delta is still measured from the right place) whenever `scrollHeight` itself has changed since the last event.
 * **The one case this must still catch — asked for in the same breath — is already a different mechanism**: the
 * `ResizeObserver` above fires independently of any `scroll` event at all, the moment typing shrinks the content
 * below the viewport's own height (nothing left to be hidden *from*), and is untouched by this guard.
 */
export function useScrollAutohide(): [boolean, () => void, () => void] {
  const [hidden, setHidden] = useState(false)
  const lastTop = useRef(new WeakMap<Element, number>())
  const lastHeight = useRef(new WeakMap<Element, number>())
  const observer = useRef<ResizeObserver | null>(null)
  const show = useCallback(() => setHidden(false), [])
  const hide = useCallback(() => setHidden(true), [])

  useEffect(() => {
    observer.current = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const el = entry.target
        if (el.scrollHeight <= el.clientHeight + 1) setHidden(false)
      }
    })
    function onScroll(e: Event) {
      const target = e.target
      if (!(target instanceof Element)) return
      if (!lastTop.current.has(target)) observer.current?.observe(target)
      const top = target.scrollTop
      const height = target.scrollHeight
      // A target seen for the first time defaults to 0, not its current position: every scrollable region in this
      // app starts at the top when it mounts, so this gives the very *first* scroll event a real delta too — the
      // same thing the original, single-target implementation got for free by reading `scrollTop` once at mount,
      // before any scrolling had happened (defaulting to `top` itself instead left the first event's delta always
      // 0, silently swallowing the first scroll gesture on any newly-seen element — found live).
      const last = lastTop.current.get(target) ?? 0
      // The *height* default is the opposite: the current height, not 0 — the first event for a newly-seen
      // element must never read as "the content just changed" (see the module doc's own "typing itself" note).
      const lastH = lastHeight.current.get(target) ?? height
      if (height === lastH) {
        const delta = top - last
        const pinnedAtBottom = top + target.clientHeight >= target.scrollHeight - AT_BOTTOM_SLACK_PX
        if (top <= HIDE_AFTER_PX) setHidden(false)
        else if (delta > DIRECTION_THRESHOLD_PX) setHidden(true)
        else if (delta < -DIRECTION_THRESHOLD_PX && !pinnedAtBottom) setHidden(false)
      }
      lastTop.current.set(target, top)
      lastHeight.current.set(target, height)
    }
    document.addEventListener('scroll', onScroll, { capture: true, passive: true })
    return () => {
      document.removeEventListener('scroll', onScroll, true)
      observer.current?.disconnect()
    }
  }, [])

  return [hidden, show, hide]
}
