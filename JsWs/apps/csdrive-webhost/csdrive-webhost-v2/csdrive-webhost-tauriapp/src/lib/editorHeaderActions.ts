import { useCallback, useRef, useState } from 'react'

/** Reserved for the title even when the trailing action buttons share its line — enough for a handful of
 * characters plus the ellipsis CSS gives it, never zero (a zero reservation would let the actions group
 * claim the whole row and squeeze the title out of existence instead of dropping to its own line). */
const TITLE_MIN_WIDTH = 60
/** Matches `.notes-page-header`'s own `gap: 8px` — one gap before the actions group and one before it,
 * whichever of the two (leading button, title) actually precedes it on the shared line. */
const ROW_GAP = 8
/** Matches `.editor-header-actions`'s own `gap: 6px`, for the same reason as `ROW_GAP` above: summing the
 * actions group's own children needs the same spacing CSS puts between them. */
const ACTIONS_GAP = 6

/** Whether an editor-page header's own trailing action buttons (`Back, title, [... these]`) share the
 * header's one row with its leading "Back" button and title, or drop to a row of their own — decided from
 * their *actual* measured width, not a guessed breakpoint, since how many buttons a given host has varies
 * (four for the Files tab's own editor, ten for `NoteEditPage`'s own once the User Action pair and the
 * note's own web-app buttons are counted). See CLAUDE.md's "...title should stay on the same line..." for
 * the full design — this hook is the "is there room" half of it; the width-based "never wrap above a wide
 * breakpoint" half is a plain CSS media query, not logic a hook needs to know about.
 *
 * **Callback refs, not `useRef` + a `useLayoutEffect(..., [])`** — a real bug, found live before this ever
 * shipped: every one of the three hosts conditionally renders `null` (or an equivalent "not ready yet"
 * state) until its own sources finish loading, so the header — and the refs this hook needs — doesn't exist
 * on the component's *first* render at all. A one-time, empty-deps `useLayoutEffect` runs exactly once,
 * right after that first commit, and never again — so it would permanently capture `null` refs and never
 * get a second chance once the header actually mounts on a later render. A callback ref doesn't have this
 * problem: React calls it the moment the DOM node it's attached to actually appears (or disappears),
 * whichever render that happens to be, so the `ResizeObserver` gets set up exactly when there's something
 * real to observe.
 *
 * **The actions group's own natural width is the sum of its children's own widths, never a measurement of
 * the group's own box** (`scrollWidth`/`offsetWidth`) — a second bug, also found live before shipping: once
 * `.editor-header-actions-wrap` (`App.css`) pushes the group to its own full-width row via `flex-basis:
 * 100%`, the group's own box is *stretched* to that row's full width regardless of how little its content
 * actually needs, so its own `scrollWidth` would then read the row's width, not the buttons' — a measurement
 * that changes the moment `wrap` becomes true, purely as a *side effect* of acting on that very value, which
 * is exactly the shape of a feedback loop. Each individual child (an `IconButton`, the "unsaved changes"
 * span, `CacheMenu`) keeps its own natural size regardless of how wide its *parent's* box happens to be
 * (nothing here stretches a child to fill leftover space), so summing `child.offsetWidth` is stable in every
 * state the group can be in — shared with the title, pushed to its own row, or that row's own buttons
 * further wrapped among themselves as the last resort. */
export function useEditorHeaderActionsWrap() {
  const leadingRef = useRef<HTMLButtonElement>(null)
  const headerElRef = useRef<HTMLDivElement | null>(null)
  const actionsElRef = useRef<HTMLDivElement | null>(null)
  const roRef = useRef<ResizeObserver | null>(null)
  const [wrap, setWrap] = useState(false)

  const recompute = useCallback(() => {
    const header = headerElRef.current
    const actions = actionsElRef.current
    if (!header || !actions) return
    const leadingWidth = leadingRef.current?.offsetWidth ?? 0
    const available = header.clientWidth - leadingWidth - ROW_GAP
    const children = Array.from(actions.children) as HTMLElement[]
    const actionsNaturalWidth = children.reduce((sum, el, i) => sum + el.offsetWidth + (i > 0 ? ACTIONS_GAP : 0), 0)
    setWrap(actionsNaturalWidth + TITLE_MIN_WIDTH + ROW_GAP > available)
  }, [])

  // Re-(dis)arms the one shared `ResizeObserver` from whichever of the two callback refs fires last — each
  // only disconnects an observer it itself created, so a `headerRef` remount doesn't tear down an observer
  // `actionsRef` is still relying on, and vice versa.
  const armIfReady = useCallback(() => {
    if (roRef.current) {
      roRef.current.disconnect()
      roRef.current = null
    }
    const header = headerElRef.current
    const actions = actionsElRef.current
    if (!header || !actions) return
    recompute()
    const ro = new ResizeObserver(recompute)
    ro.observe(header)
    ro.observe(actions)
    roRef.current = ro
  }, [recompute])

  const headerRef = useCallback(
    (node: HTMLDivElement | null) => {
      headerElRef.current = node
      armIfReady()
    },
    [armIfReady],
  )
  const actionsRef = useCallback(
    (node: HTMLDivElement | null) => {
      actionsElRef.current = node
      armIfReady()
    },
    [armIfReady],
  )

  return { headerRef, leadingRef, actionsRef, wrap }
}
