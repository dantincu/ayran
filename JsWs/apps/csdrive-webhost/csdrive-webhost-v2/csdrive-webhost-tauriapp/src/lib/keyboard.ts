import { useEffect, useRef } from 'react'

/** Keyboard support shared by the admin-app and the system apps: the shortcuts, and keyboard
 * navigation of lists. See "Keyboard" in CLAUDE.md for the whole list of keys. */

/** Ctrl (Cmd on a Mac) plus a letter, and nothing else held. */
export function isShortcut(e: KeyboardEvent, letter: string): boolean {
  return (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === letter
}

/** Opens the list of the admin-app's tabs (admin-app only). */
export const TAB_SWITCHER_LETTER = 'k'
/** Opens the page list of a paginated list ("go to page"). */
export const PAGE_LIST_LETTER = 'g'

/** The name of a shortcut as it is written in tooltips. */
export function shortcutLabel(letter: string): string {
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
  return `${mac ? '⌘' : 'Ctrl+'}${letter.toUpperCase()}`
}

const NON_TEXT_INPUTS = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file', 'image'])

/** Whether the keys typed at `target` are for the thing being typed in — a text box, a menu — and so
 * not for list navigation. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  return tag === 'INPUT' && !NON_TEXT_INPUTS.has((target as HTMLInputElement).type)
}

/** A dialog, the editor or a popover is open: the page behind it doesn't take navigation keys. */
export function overlayOpen(): boolean {
  return document.querySelector('.modal-overlay, .editor-overlay, .page-popover') !== null
}

/** How far PageUp / PageDown move. */
const PAGE_JUMP = 10

export interface ListKeyboard {
  /** How many items the list has (all of them, not just the page on screen). */
  count: number
  /** The focused item, or -1 for none. */
  focused: number
  setFocused: (index: number) => void
  /** Right arrow: go into the focused item (open the folder, the window, the tab…). */
  onOpen?: (index: number) => void
  /** Left arrow: go up to the parent. */
  onParent?: () => void
  /** Enter: the focused item's own action (a tab is shown, a site's window comes to the front…); without
   * it Enter does what Right does. Not heard while a button or link has the focus — Enter presses that. */
  onActivate?: (index: number) => void
  /** Off while something else owns the keys (a list being sorted, another list on top). */
  enabled?: boolean
}

/** Arrow-key navigation of a list, for the page it is used on: Up/Down move the focus by one,
 * Home/End go to the first/last item, PageUp/PageDown move it by 10, Left goes to the parent and Right
 * into the focused item. The keys are heard on the whole window, so no element has to be focused
 * first — except that a text box, a menu or an open dialog keeps its own keys.
 *
 * The list marks the focused row with kbdItem; the row is scrolled into view here. */
export function useListKeyboard(options: ListKeyboard) {
  const latest = useRef(options)
  latest.current = options

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const { count, focused, setFocused, onOpen, onParent, onActivate, enabled } = latest.current
      if (enabled === false || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return
      if (isTypingTarget(e.target) || overlayOpen()) return
      const from = Math.max(focused, 0)
      let next: number
      switch (e.key) {
        case 'ArrowDown':
          next = focused < 0 ? 0 : focused + 1
          break
        case 'ArrowUp':
          next = focused < 0 ? 0 : focused - 1
          break
        case 'Home':
          next = 0
          break
        case 'End':
          next = count - 1
          break
        case 'PageDown':
          next = from + PAGE_JUMP
          break
        case 'PageUp':
          next = from - PAGE_JUMP
          break
        case 'ArrowLeft':
          if (onParent) {
            e.preventDefault()
            onParent()
          }
          return
        case 'ArrowRight':
          if (onOpen && focused >= 0 && focused < count) {
            e.preventDefault()
            onOpen(focused)
          }
          return
        case 'Enter': {
          const act = onActivate ?? onOpen
          if (!act || focused < 0 || focused >= count) return
          if (e.target instanceof HTMLElement && e.target.closest('button, a, summary, [role="button"]')) return
          e.preventDefault()
          act(focused)
          return
        }
        default:
          return
      }
      if (count === 0) return
      e.preventDefault()
      setFocused(Math.min(count - 1, Math.max(0, next)))
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  useEffect(() => {
    if (options.focused >= 0) document.querySelector('[data-kbd-focused]')?.scrollIntoView({ block: 'nearest' })
  }, [options.focused])
}

/** What a list item takes to be the keyboard-focused one (drawn by [data-kbd-focused] in App.css);
 * pressing the mouse on it moves the focus there, so the keys carry on from where the person clicked. */
export function kbdItem(focused: number, index: number, setFocused: (index: number) => void) {
  return {
    'data-kbd-focused': index === focused ? '' : undefined,
    onMouseDown: () => setFocused(index),
  }
}
