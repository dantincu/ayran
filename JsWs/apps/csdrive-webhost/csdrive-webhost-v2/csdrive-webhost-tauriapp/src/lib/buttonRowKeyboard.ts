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
 * **Finding "a row of buttons".** Two kinds, both plain CSS selectors:
 * - `.row-actions` — a list item's own row of action buttons. Nothing new: `RowActions.tsx` already renders
 *   into exactly this class (or a `<td className="row-actions">`) with no wrapper of its own, so every
 *   existing row-actions instance in the app already qualifies, with no changes to it needed.
 * - `[data-primary-actions]` — a page's *own* main toolbar, marked by hand, one row per page/level (Settings,
 *   say, has several toolbar-like sections; this is the one meant for Alt+Shift+J). A popup modal that was
 *   never marked this way falls back to its first enabled button — most modals have only a couple, so "the
 *   first one" is almost always the sensible one, and marking every modal individually wasn't worth it for
 *   what's usually a two- or three-button dialog.
 */

const ROW_SELECTOR = '.row-actions, [data-primary-actions]'

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

      // Alt+Shift+J: the page's (or the open modal's) own top row.
      if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'j') {
        e.preventDefault()
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

      // From here on, only keys that move *within* a row of buttons that already has the focus matter.
      const row = currentRow()
      if (!row) return
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
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}
