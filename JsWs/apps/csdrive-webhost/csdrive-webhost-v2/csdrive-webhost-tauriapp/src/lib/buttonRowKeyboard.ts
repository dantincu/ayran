import { useEffect } from 'react'
import { fastNavAmount, PAGE_JUMP } from './keyboard'

/** Alt+Shift+J and Alt+J (`docs/features/features.md`'s keyboard-shortcuts item): reaching a page's own top
 * row of icon buttons, and a focused list item's own row of action buttons, from the keyboard — and, once
 * one of them has the focus, moving along it.
 *
 * **A row of buttons is a *real*, natively focusable set of `<button>` elements, unlike a list's own row**
 * (`useListKeyboard`/`kbdItem` in `keyboard.ts`, which draws a *virtual* focus with `[data-kbd-focused]`
 * because a list's own row usually isn't a focusable element itself). That difference is what makes this
 * whole module simple: once a button actually has the browser's own focus, Enter/Space activating it,
 * `:focus-visible` showing it, and screen readers announcing it are the browser's own doing, not this
 * module's — matching "Pressing ENTER while focused on a button will trigger that button's action" for free.
 * So there's no React state here at all, no per-component hook to call: a single `keydown` listener, mounted
 * once (`useButtonRowKeyboard`, called from `ChordHost.tsx` — already "mounted once per page", the exact
 * placement this needs too, admin-app and Notes alike), does everything by asking `document.activeElement`
 * and the DOM directly.
 *
 * **Registered on the *capture* phase — found live to be load-bearing, not a defensive guess.**
 * `useListKeyboard` (`keyboard.ts`) is a second, independent `window`-level `keydown` listener, and the two
 * cooperate only through `e.defaultPrevented`: whichever one calls `preventDefault()` first "wins" a key the
 * other would otherwise also act on too. With both registered on the ordinary *bubble* phase
 * (`addEventListener`'s default), which one runs first for a given page depends on React's own effect-mount
 * order — not something this module can rely on holding one way forever. Live-tested on a real listing page
 * (a toolbar button focused via Alt+Shift+J, a list item already keyboard-focused below it): ArrowDown/
 * ArrowUp/ArrowRight all reached `useListKeyboard`'s own handler and silently moved its `[data-kbd-focused]`
 * marker (ArrowRight even opened the focused folder) while the visibly-focused button never moved — the
 * *opposite* of every key below "winning," which the rest of this module's own design depends on. Capture-
 * phase listeners on `window` always run before *any* bubble-phase listener anywhere in the tree, including
 * another bubble-phase `window` listener, regardless of which one registered first — the one ordering
 * guarantee the DOM event model actually makes. Registering here on capture (the `true` third argument,
 * below) makes this module's own `preventDefault()` calls reliably reach `useListKeyboard`'s own
 * `if (e.defaultPrevented) return` check no matter what else has mounted, closing the whole class of
 * order-dependent fragility the two items below ran straight into, rather than papering over one instance of
 * it (the capture fix alone made both items below's own "unconditional `preventDefault()`" logic actually
 * take effect against the list for the first time — without it, that logic was unreachable whenever the list
 * happened to register first, which is exactly the live failure above).
 *
 * **Finding "a row of buttons".** Three kinds, all plain CSS selectors:
 * - `.row-actions` — a list item's own row of action buttons. Nothing new: `RowActions.tsx` already renders
 *   into exactly this class (or a `<td className="row-actions">`) with no wrapper of its own, so every
 *   existing row-actions instance in the app already qualifies, with no changes to it needed.
 * - `[data-primary-actions]` — a page's *own* main toolbar, marked by hand, one row per page/level (Settings,
 *   say, has several toolbar-like sections; this is the one meant for Alt+Shift+J). A popup modal that was
 *   never marked this way falls back to its first enabled button — most modals have only a couple, so "the
 *   first one" is almost always the sensible one, and marking every modal individually wasn't worth it for
 *   what's usually a two- or three-button dialog.
 * - `[data-secondary-actions]` — **a second, page-specific header below the page's own top one** (asked for
 *   directly: "there are pages in our app where there is a second page-specific top header (mainly our text
 *   editor has its own row of buttons)... [it] should also be navigable in the same fashion the page's top
 *   header"). Today this is only the text editor's own toolbar (`.code-editor-toolbar` in `CodeEditor.tsx`,
 *   `MonacoCodeEditor.tsx` and `MobileCodeMirrorEditor.tsx` — Undo/Redo/Find/etc., sitting directly below the
 *   editor page's own `[data-primary-actions]` header), but the marker is generic for whatever page gets a
 *   second one next. At most one of each per page, so — unlike `.row-actions`, of which a page can have
 *   many — reaching it needs no "which one" logic: **ArrowDown from the primary row jumps to this row's own
 *   first button, and ArrowUp from this row jumps back to the primary row's first button** (below), the one
 *   extra pair of moves "the same fashion" didn't already give it for free (Left/Right/Home/End/PageUp/
 *   PageDown/Escape already apply to *any* row matching `ROW_SELECTOR`, this one included, with no change
 *   needed there).
 *
 * **Two follow-ups, both asked for directly once the above shipped, and both about the same underlying
 * fact: `useListKeyboard`'s own `keydown` listener (`keyboard.ts`) is a second, independent `window`-level
 * listener that only ever skips an event when it's a *typing* target (`isTypingTarget` — text boxes, a
 * `<select>`, `contentEditable`) or an overlay is open, never merely "a button has the focus."** A `<button>`
 * is not a typing target, so with nothing to stop it, the list's own Up/Down/Left/Right happily fires *at
 * the same time* as this module's own, purely by both being plain `window.addEventListener('keydown', ...)`
 * handlers that cooperate only through `e.defaultPrevented` — whichever one calls `preventDefault()` first
 * (registration order decides that) is the one whose own reaction actually "wins."
 * 1. **Up/Down now always call `preventDefault()` the moment focus is in the primary or secondary row** —
 *    before this, the cross-row jump above only called it when it actually found a row to jump *to*;
 *    pressing ArrowDown with no secondary row on screen (or ArrowUp with no primary row — never happens in
 *    practice, but kept symmetric) fell all the way through unclaimed, leaving `e.defaultPrevented` `false`
 *    for whatever ran next. **Left/Right already always called `preventDefault()`** once any row had the
 *    focus (the switch below) and needed no change on their own — but, as the capture-phase paragraph above
 *    explains, "already calls `preventDefault()`" was never enough **by itself**: on a real listing page it
 *    turned out `useListKeyboard` could run *first* and claim the key before this module ever got a look,
 *    for Left/Right exactly as much as for Up/Down. The capture-phase fix and this one are a matched pair —
 *    together they guarantee "Down and Up arrows no longer move across the main list... even when there is
 *    no page-specific header, and the left and right arrows no longer navigate... the list hierarchy" for
 *    every key this module claims, regardless of what else is mounted on the page.
 * 2. **Alt+Shift+J, pressed again while already inside the primary or secondary row it put the focus in,
 *    hands focus back to the list** instead of re-finding and re-focusing the same (or the modal's) row —
 *    the one way back besides Escape, and the more discoverable one, since it's the same key that got you
 *    there. A plain `blur()`, the same action Escape already uses: the list's own `[data-kbd-focused]`
 *    marker was never disturbed by any of this (it's independent React state, not real DOM focus), so
 *    simply giving up the button's own focus is already "refocusing the current item in the main list" —
 *    the very next arrow key reaches the list's own listener with nothing claiming it first. Deliberately
 *    scoped to the primary/secondary rows only, not `.row-actions` — a list item's own action row keeps
 *    today's behavior (Alt+Shift+J from there still jumps to the page's own top row, as always).
 */

const ROW_SELECTOR = '.row-actions, [data-primary-actions], [data-secondary-actions]'

function buttonsIn(row: Element): HTMLButtonElement[] {
  return Array.from(row.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
}

function focusFirstIn(row: Element | null | undefined) {
  if (row) buttonsIn(row)[0]?.focus()
}

/** The row (if any) the currently-focused element's own button-row navigation belongs to. */
function currentRow(): Element | null {
  const active = document.activeElement
  return active instanceof HTMLElement ? active.closest(ROW_SELECTOR) : null
}

export function useButtonRowKeyboard() {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.defaultPrevented) return

      // Alt+Shift+J: the page's (or the open modal's) own top row — or, pressed again while already in
      // that row or the page's second one, hand focus back to the main list instead (see this module's
      // own doc comment, item 2).
      if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'j') {
        e.preventDefault()
        const already = currentRow()
        if (already && (already.matches('[data-primary-actions]') || already.matches('[data-secondary-actions]'))) {
          ;(document.activeElement as HTMLElement)?.blur()
          return
        }
        const modal = document.querySelector('.modal-overlay')
        const scope = modal ?? document.querySelector('.tab-content')
        const marked = scope?.querySelector('[data-primary-actions]')
        focusFirstIn(marked ?? modal ?? undefined)
        return
      }

      // Alt+J: the keyboard-focused list item's own row of action buttons.
      if (e.altKey && !e.shiftKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'j') {
        const item = document.querySelector('[data-kbd-focused]')
        const row = item?.querySelector('.row-actions')
        if (row) {
          e.preventDefault()
          focusFirstIn(row)
        }
        return
      }

      // From here on, only keys that move *within*, or between, a row of buttons that already has the
      // focus matter.
      const row = currentRow()
      if (!row) return

      // ArrowDown from the page's own top row to its second, page-specific header (the editor's own
      // toolbar, mainly) — and ArrowUp back — the one pair of moves between the two rows that "the same
      // fashion" as the primary row doesn't already give for free (every other key below already applies
      // to both rows alike, since both match `ROW_SELECTOR`). Scoped the same way Alt+Shift+J's own lookup
      // is: the open modal if there is one, else the page's own `.tab-content` — so this only ever jumps
      // between the *one* primary and the *one* secondary row that actually belong to what's on screen.
      if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        const inPrimary = row.matches('[data-primary-actions]')
        const inSecondary = row.matches('[data-secondary-actions]')
        if (inPrimary || inSecondary) {
          // Claimed unconditionally the moment focus is in either row — even a direction with nowhere to
          // go (ArrowUp from the primary row, ArrowDown from the secondary one) is swallowed here, never
          // left for the list's own Up/Down listener to act on instead (this module's own doc comment,
          // item 1).
          e.preventDefault()
          const scope = document.querySelector('.modal-overlay') ?? document.querySelector('.tab-content')
          if (e.key === 'ArrowDown' && inPrimary) focusFirstIn(scope?.querySelector('[data-secondary-actions]'))
          else if (e.key === 'ArrowUp' && inSecondary) focusFirstIn(scope?.querySelector('[data-primary-actions]'))
          return
        }
      }
      const buttons = buttonsIn(row)
      if (buttons.length === 0) return
      const at = Math.max(0, buttons.indexOf(document.activeElement as HTMLButtonElement))

      const fast = fastNavAmount(e)
      if (fast !== null) {
        e.preventDefault()
        buttons[Math.min(buttons.length - 1, Math.max(0, at + fast))]?.focus()
        return
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return
      let next: number
      switch (e.key) {
        case 'ArrowRight':
          next = at + 1
          break
        case 'ArrowLeft':
          next = at - 1
          break
        case 'Home':
          next = 0
          break
        case 'End':
          next = buttons.length - 1
          break
        case 'PageDown':
          next = at + PAGE_JUMP
          break
        case 'PageUp':
          next = at - PAGE_JUMP
          break
        case 'Escape':
          e.preventDefault()
          ;(document.activeElement as HTMLElement)?.blur()
          return
        default:
          return
      }
      e.preventDefault()
      buttons[Math.min(buttons.length - 1, Math.max(0, next))]?.focus()
    }
    // Capture phase (the `true` argument) — see this module's own doc comment for why that's load-bearing,
    // not stylistic: it's what guarantees this handler runs before `useListKeyboard`'s own bubble-phase one,
    // regardless of which of the two mounted first.
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])
}
