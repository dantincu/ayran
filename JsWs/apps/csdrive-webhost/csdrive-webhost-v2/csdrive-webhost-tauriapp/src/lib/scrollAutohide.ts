import { useCallback, useEffect, useRef, useState } from 'react'

const HIDE_AFTER_PX = 40
const DIRECTION_THRESHOLD_PX = 4

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
 */
export function useScrollAutohide(): [boolean, () => void, () => void] {
  const [hidden, setHidden] = useState(false)
  const lastTop = useRef(new WeakMap<Element, number>())
  const observer = useRef<ResizeObserver | null>(null)
  // Stable identities (`setHidden` itself is stable, so wrapping it once is enough) — callers that pass `show`/`hide`
  // as a `useEffect` dependency (subscribing to an external "show it again" trigger) must not resubscribe every render.
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
      // A target seen for the first time defaults to 0, not its current position: every scrollable region in this
      // app starts at the top when it mounts, so this gives the very *first* scroll event a real delta too — the
      // same thing the original, single-target implementation got for free by reading `scrollTop` once at mount,
      // before any scrolling had happened (defaulting to `top` itself instead left the first event's delta always
      // 0, silently swallowing the first scroll gesture on any newly-seen element — found live).
      const last = lastTop.current.get(target) ?? 0
      const delta = top - last
      if (top <= HIDE_AFTER_PX) setHidden(false)
      else if (delta > DIRECTION_THRESHOLD_PX) setHidden(true)
      else if (delta < -DIRECTION_THRESHOLD_PX) setHidden(false)
      lastTop.current.set(target, top)
    }
    document.addEventListener('scroll', onScroll, { capture: true, passive: true })
    return () => {
      document.removeEventListener('scroll', onScroll, true)
      observer.current?.disconnect()
    }
  }, [])

  return [hidden, show, hide]
}
