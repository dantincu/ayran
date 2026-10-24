import { useCallback, useEffect, useRef, useState } from 'react'
import { beginHeaderTransition, endHeaderTransition, HEADER_TRANSITION_MS, runAfterHighlightRerender } from './editorHeaderSync'

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
 *
 * **Coordinated with the editor's own highlight re-render, asked for directly** (`lib/editorHeaderSync.ts`):
 * every actual flip of `hidden` — never a call that would leave it unchanged — first asks
 * `runAfterHighlightRerender` to hold off if `CodeEditor`'s own `RunPatchController` work is mid-flight (almost
 * never true in practice, since those DOM patches are synchronous and fast, but asked for as the "vice versa"
 * half), then, once the state genuinely changes, brackets the CSS transition it's about to trigger with
 * `beginHeaderTransition`/a timed `endHeaderTransition` — so `CodeEditor`'s own scroll-driven window-range
 * work (`handleScroll`) can defer *its* read of `clientHeight` until the header's own `max-height` transition
 * has actually finished moving it, rather than reading a value mid-animation and computing a window that gets
 * silently superseded a moment later when the transition settles.
 *
 * **Reported live, specifically on Monaco (the desktop default editor since this app started offering a
 * third-party one): "the top header and editor header no longer hide when scrolling down."** Confirmed live,
 * not assumed: a diagnostic capture-phase listener installed directly on `document`, scrolling Monaco's own
 * content a real, confirmed amount (the first visible line changed), recorded **zero** native `scroll`
 * events anywhere in the page. Monaco doesn't scroll its content the way every other scrollable region in
 * this app does — no real element has its `scrollTop` changed and `overflow: auto`; it renders at a fixed
 * position and translates the *content* itself, managing its own virtual scroll position entirely in JS
 * (`editor.getScrollTop()`/`onDidScrollChange`), which is exactly why it never had to reimplement Page Up/
 * Down the way this app's own editor once did, and exactly why this delegation-based hook — built around
 * "any element's native `scroll` event bubbles to a capture-phase listener on `document`, so nothing has to
 * wire a scrolling widget to whichever header happens to be above it" — never sees it. **CodeMirror (the
 * mobile default) is unaffected**: its own `.cm-scroller` is a real, native `overflow: auto` element,
 * confirmed still firing ordinary `scroll` events.
 *
 * **Fixed by giving Monaco a second way in, not by abandoning the delegation design**: `reportVirtualScroll`
 * (exported below) dispatches a plain `CustomEvent` on `document` — the hook listens for it exactly the way
 * it already listens for a real `scroll` event, so `MonacoCodeEditor.tsx`'s own `onDidScrollChange` needs no
 * prop, no context and no direct reference to whichever header happens to be mounted above it (there can be
 * more than one — `NotesTopBar` and an editor page's own header both react independently): it just calls a
 * plain exported function with the numbers Monaco already computes (`getScrollTop`/`getScrollHeight`/
 * `getLayoutInfo().height`), the same way a real element firing a native `scroll` event would, keeping the
 * "nothing has to be wired to anything" property this whole module exists for. The editor's own host element
 * is used as the stable identity key (`WeakMap`) a real DOM scroll event's `target` would be, so a Monaco
 * instance's own scroll history runs through the exact same `decideScroll` as any other element's — the
 * "pinned at the bottom" and "content height changed, this is typing" guards included, with no second copy
 * of either to keep in sync.
 *
 * **A scroll inside an open popup (`Modal`) must never toggle the page's own header, asked for directly**:
 * the person scrolls a long list or a big text box *inside* a modal, and that scroll — bubbling to this
 * same capture-phase `document` listener, since `scroll` reaches it regardless of which element it actually
 * fired on — used to be read as if the page behind the modal had scrolled, hiding or showing its header for
 * no reason connected to what the person was actually looking at. `.modal-overlay` (`components/Modal.tsx`)
 * is the one marker every popup already renders, so `onScroll`/`onVirtualScroll` simply skip a target that
 * has one as an ancestor (`Element.closest`) — not just skipping the hide/show decision but never recording
 * its `scrollTop`/`scrollHeight` or starting to `ResizeObserver` it either, since none of that bookkeeping
 * means anything for an element whose scroll was never meant to drive this header in the first place. A
 * modal that later closes leaves no residue: its own content is normally unmounted with it, and even if the
 * identical element were somehow reused outside a modal afterward, the first scroll event on it would just
 * seed `lastTop`/`lastHeight` fresh, exactly as any newly-seen element already does.
 *
 * **"The header only shows back when scrolling up near the start of the page — scroll a bit further and
 * scrolling up stops bringing it back," reported live.** Confirmed live, not guessed, by installing a
 * diagnostic listener directly on `document` and dumping every real `scroll` event's own `scrollTop`/
 * `scrollHeight` across one ordinary scroll gesture — and the real trace was far stranger than "a single
 * collapse taking a while to settle": both `scrollTop` *and* `scrollHeight` were oscillating back and forth,
 * tick after tick, for the entire gesture (one real run: `hiddenNow` flipping `true`/`false`/`true`/`false`
 * across more than twenty consecutive events, `scrollTop` wandering up and down by tens of pixels with no
 * net direction), not settling toward a single collapse the way "the shake" above does. **This is the exact
 * same class of problem as "the shake," just triggered a different way**: the header sits directly *above*
 * the rest of `.tab-panel`'s content in the document, and CSS **scroll anchoring** — on by default, the
 * browser's own "keep whatever's on screen from jumping when something *above* the viewport changes size"
 * feature — actively adjusts `scrollTop` to compensate every time the header's own collapse/expand changes
 * its height, which is itself a real `scroll` event this hook reads as a genuine gesture; reacting to it by
 * flipping `hidden` again changes the header's height *again*, which the browser then compensates for
 * *again* — a self-sustaining feedback loop with no reason to ever stop on its own. The original
 * `height === lastH` guard (above, built for "typing") only ever *happened* to dampen this by accident — most
 * individual ticks in the oscillation have a different `scrollHeight` than the one before, so most of them
 * got silently dropped — which is exactly why the symptom looked like "sometimes works, sometimes doesn't"
 * rather than a visible shake: enough of the oscillation's own noise was being swallowed to usually settle
 * quietly, just not reliably, and not in the person's actual intended direction.
 *
 * **A fix was first tried at the guard itself** — bypassing `height === lastH` for a time after a flip was
 * requested, on the reasoning that *our own* known collapse/expand shouldn't trip a check meant for
 * *unexplained* height changes. This was a real, measurable improvement in isolation (a scripted trial —
 * reset, scroll down, a short randomized delay, scroll up, repeat — went from 8 failures in 15 attempts down
 * to 3 with one version of it) but, tested further, made the *oscillation itself* measurably worse (up to 7
 * failures in 15) once the bypass window was widened to close that gap: letting more of the guard's own
 * events through meant letting more of the oscillation's own self-reinforcing noise through too — treating
 * the guard's accidental damping as if it were the problem, when the problem was the oscillation it was
 * (imperfectly) damping in the first place.
 *
 * **`overflow-anchor: none` on `.tab-content` (`App.css`) removes the oscillation itself** — the same
 * property `markdown.rs`'s own standalone bootstrap script already sets, for the identical reason, on a
 * completely different page (see CLAUDE.md's "A note opened as a web app..."). With it, a header's own
 * collapse/expand no longer perturbs `scrollTop` at all, confirmed live by re-running the same diagnostic
 * trace from the "reported live" paragraph above: what used to be 16–24+ chaotic events per gesture dropped
 * to 3 clean ones, with `scrollTop` moving in one direction and settling, not wandering. This doesn't reopen
 * "the shake" above, which is a different scrolling region (`.code-editor`, not `.tab-content`) with its own,
 * already-correct `pinnedAtBottom` protection — nor does it change what `overflow-anchor` does for genuine,
 * person-driven scrolling, which this property was never involved in to begin with.
 *
 * **This CSS fix alone is *not* sufficient, and an early "0 failures in 15" result claiming otherwise was
 * wrong — caught by testing a more realistic pattern, not by further inspection of the oscillation itself.**
 * The scripted trial that first measured 0/15 reset aggressively to the top between attempts and used a short,
 * randomized delay — exactly the shape the oscillation itself needed to be provoked, but not the shape of an
 * ordinary person scrolling down, pausing to read, then scrolling back up without ever returning to the top.
 * A second trial built for that realistic shape (scroll down ~600px, a genuine ~600ms pause, scroll back up
 * ~600px, repeated without resetting) found the CSS fix alone still failed **5 times in 15** — a real,
 * separate gap the oscillation's own elimination never touched. Tracing one failing trial down to individual
 * events found the actual mechanism: with the oscillation gone, each scroll gesture now produces exactly
 * *one* native `scroll` event, not a stream of momentum ticks — so `lastHeight` for the target is never
 * updated between the down-scroll (while the header is shown) and the up-scroll (after the header's own
 * collapse transition has finished and settled `clientHeight` at its new, smaller value). The up-scroll event
 * is therefore *always* the first opportunity this hook has to observe the post-collapse height, no matter
 * how long the person paused first — 600ms, 3 seconds, a minute — because nothing else ever walks
 * `lastHeight` forward in between. A **time-based** guard (bypass the strict `height === lastH` check for a
 * window after a flip was requested) can never correctly bound this: the "staleness" here isn't about
 * *recency*, it's about there being no intermediate observation at all, at any duration. This was tried twice
 * and failed both times for exactly that reason — first as a widened bypass window on the oscillation case
 * above (made the oscillation itself worse, see "A fix was first tried at the guard itself"), and again,
 * restored alongside this CSS fix, as a dedicated synchronous ref-based grace period (`recentlyToggledUntil`,
 * 400ms) aimed specifically at this realistic pattern — re-measured at **still 5/15**, identical to the CSS
 * fix alone, because 400ms (or any fixed duration) has no bearing on whether an intermediate event ever fired.
 *
 * **The actual fix is the directional-consistency check in `decideScroll`** (`consistentWithOwnRequest`,
 * driven by the `lastRequestedHidden` ref in `useScrollAutohide`, both below): instead of asking "has enough
 * time passed since we last changed `hidden`," it asks "does this height change match the direction *we*
 * would expect from our own last request" — shorter after we asked to hide, taller after we asked to show.
 * This needs no timing assumption at all, because it's judged from what was requested, not when. Verified
 * live, with the time-based ref removed entirely: 0 failures in 15 attempts on the original adversarial
 * (reset-to-top, short randomized delay) trial, 0/15 and then 0/30 on the realistic (600ms pause, no reset)
 * trial, and 0/6 on a trial using a deliberate 3-second pause specifically to confirm the fix's own
 * time-independence (a time-based guard of any practical duration would have failed this one by construction).
 * **Re-verified against Monaco's own editor header specifically** (a sibling-element case, not
 * `.tab-content`'s own child-content case — see `reportVirtualScroll`'s own doc comment below): 0/10 on a
 * scroll-down-pause-scroll-up trial and 0/12 on a trial that never returns to the top, descending further
 * into the document on every pass — the exact "works near the start, breaks further down" shape originally
 * reported, reproduced and confirmed fixed through the virtual-scroll bridge directly, since this harness
 * could not reliably give Monaco's own input surface real OS focus to drive it through genuine wheel/keyboard
 * input (see CLAUDE.md's own recurring notes on WebView2 focus quirks for exactly this class of limitation). */
const VIRTUAL_SCROLL_EVENT = 'csdrive-virtual-scroll'
interface VirtualScrollDetail {
  key: object
  top: number
  height: number
  clientHeight: number
}

/** Reports a scroll that never fires a real DOM `scroll` event — Monaco, see the module doc's own "reported
 * live" paragraph above. `key` is any stable per-instance identity (the editor's own host element is a
 * natural choice); `top`/`height`/`clientHeight` are the same three numbers a native `scroll` event's
 * `target` would otherwise be read from. */
export function reportVirtualScroll(key: object, top: number, height: number, clientHeight: number): void {
  document.dispatchEvent(new CustomEvent<VirtualScrollDetail>(VIRTUAL_SCROLL_EVENT, { detail: { key, top, height, clientHeight } }))
}

function decideScroll(
  target: object,
  top: number,
  height: number,
  clientHeight: number,
  lastTop: WeakMap<object, number>,
  lastHeight: WeakMap<object, number>,
  setHidden: (value: boolean) => void,
  lastRequestedHidden: boolean | null,
): void {
  const last = lastTop.get(target) ?? 0
  const lastH = lastHeight.get(target) ?? height
  // A height change is also trusted — not just an exact match — when it moved in the direction *we ourselves*
  // would expect from our own last request: shorter after asking to hide, taller after asking to show. See the
  // module doc's own "a scroll-up could stop working past a certain point" paragraph for why a *time*-based
  // version of this (bypass the guard for a fixed window after a flip) isn't enough: nothing else ever updates
  // `lastHeight` for this target between scroll events, so the first event *after* our own transition has
  // fully settled is also the first chance to ever observe the new height — however long that transition
  // itself took, and regardless of how long the person then paused before scrolling again. Checking the
  // *direction* instead of a *duration* needs no timing assumption at all: it's correct the instant our own
  // request explains what changed, no matter when that request was made. For a target where the header isn't
  // actually part of what's being measured (`.editor-top-bar` beside `.code-editor`, siblings, not
  // parent/child — unlike `.tab-content`, which contains `.help-header` as a sibling of the very content it
  // measures), this is harmless and inert: nothing about our own requests ever moves that target's height in
  // the first place, so a *genuine*, unexplained change (typing) never happens to line up with whichever
  // direction we last asked for, and the original strict guard still applies to it as before.
  const consistentWithOwnRequest = lastRequestedHidden === true ? height <= lastH : lastRequestedHidden === false ? height >= lastH : false
  if (height === lastH || consistentWithOwnRequest) {
    const delta = top - last
    const pinnedAtBottom = top + clientHeight >= height - AT_BOTTOM_SLACK_PX
    if (top <= HIDE_AFTER_PX) setHidden(false)
    else if (delta > DIRECTION_THRESHOLD_PX) setHidden(true)
    else if (delta < -DIRECTION_THRESHOLD_PX && !pinnedAtBottom) setHidden(false)
  }
  lastTop.set(target, top)
  lastHeight.set(target, height)
}

export function useScrollAutohide(): [boolean, () => void, () => void] {
  const [hidden, setHiddenState] = useState(false)
  const lastTop = useRef(new WeakMap<object, number>())
  const lastHeight = useRef(new WeakMap<object, number>())
  const observer = useRef<ResizeObserver | null>(null)
  // A flip gated behind `runAfterHighlightRerender` is deferred, not dropped — but by the time it's finally
  // applied the *next* scroll/resize tick may have already made a different decision moot or stale, so each
  // deferred call is tagged with the generation it was requested in and silently skipped if a newer one has
  // since been requested — the same "only the latest matters" shape `HighlightScheduler` already uses for an
  // unrelated reason.
  const generation = useRef(0)
  // Set synchronously, the instant a flip is *requested* — not deferred to whenever `runAfterHighlightRerender`
  // and React's own update eventually apply it, which isn't guaranteed to happen within the same tick for an
  // update triggered from a native, non-React-managed `scroll` event. `decideScroll` reads this to tell its
  // own self-inflicted height changes apart from an unexplained one (see its own doc comment) — tracking
  // *what we last asked for*, not *when*, since there's no reliable duration to time that check against.
  const lastRequestedHidden = useRef<boolean | null>(null)
  const setHidden = useCallback((value: boolean) => {
    lastRequestedHidden.current = value
    const myGeneration = ++generation.current
    runAfterHighlightRerender(() => {
      if (generation.current !== myGeneration) return
      setHiddenState((prev) => {
        if (prev === value) return prev
        beginHeaderTransition()
        window.setTimeout(endHeaderTransition, HEADER_TRANSITION_MS)
        return value
      })
    })
  }, [])
  const show = useCallback(() => setHidden(false), [setHidden])
  const hide = useCallback(() => setHidden(true), [setHidden])

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
      // A scroll that happened inside an open popup is never this header's business — see the module doc's
      // own "A scroll inside an open popup" paragraph above.
      if (target.closest('.modal-overlay')) return
      // A target seen for the first time defaults to 0, not its current position: every scrollable region in
      // this app starts at the top when it mounts, so this gives the very *first* scroll event a real delta
      // too — the same thing the original, single-target implementation got for free by reading `scrollTop`
      // once at mount, before any scrolling had happened (defaulting to `top` itself instead left the first
      // event's delta always 0, silently swallowing the first scroll gesture on any newly-seen element —
      // found live). Only a *real* `Element` gets the "auto show again once it stops overflowing" fallback —
      // a virtual-scroll report (below) skips it: Monaco's own host element's `scrollHeight`/`clientHeight`
      // never actually differ (it renders its content via its own internal transform, not native overflow),
      // so observing it would misfire the fallback on every layout change.
      if (!lastTop.current.has(target)) observer.current?.observe(target)
      decideScroll(target, target.scrollTop, target.scrollHeight, target.clientHeight, lastTop.current, lastHeight.current, setHidden, lastRequestedHidden.current)
    }
    // The same decision, for a scroll that never fires a native DOM event at all (`reportVirtualScroll`,
    // above) — dispatched on `document` directly, so no capture phase is needed to see it.
    function onVirtualScroll(e: Event) {
      const { key, top, height, clientHeight } = (e as CustomEvent<VirtualScrollDetail>).detail
      if (key instanceof Element && key.closest('.modal-overlay')) return
      decideScroll(key, top, height, clientHeight, lastTop.current, lastHeight.current, setHidden, lastRequestedHidden.current)
    }
    document.addEventListener('scroll', onScroll, { capture: true, passive: true })
    document.addEventListener(VIRTUAL_SCROLL_EVENT, onVirtualScroll)
    return () => {
      document.removeEventListener('scroll', onScroll, true)
      document.removeEventListener(VIRTUAL_SCROLL_EVENT, onVirtualScroll)
      observer.current?.disconnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return [hidden, show, hide]
}
