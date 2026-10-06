import { invoke } from '@tauri-apps/api/core'

/** The two clipboards a window of this app can use.
 *
 * - **The OS clipboard**: what the rest of the system sees. Written synchronously through `execCommand` first — reliable in
 *   a desktop webview, where the asynchronous Clipboard API can wait for a permission that never comes when the window
 *   lacks focus — and through the Clipboard API when that isn't possible. Read (text or an image) through the Clipboard
 *   API only (the webview may ask the person to allow it) — **Android's WebView refuses to read it at all**, text or
 *   image alike, so every reader here throws there; a caller shows that as "use the system's own paste instead".
 * - **The app's own clipboard** (`internal_clipboard.rs`): a *stack* of text entries, kept by the backend and shared by
 *   every window of the admin-app and of the system apps. Nothing copied to it reaches other programs, and the OS
 *   clipboard is left alone. "Copy to it" pushes a new entry on top; "paste from it" peeks the top one without
 *   removing it (so pasting twice pastes the same thing, the way a plain clipboard always has) — `pop` and the
 *   rest of the stack are there for `ClipboardManagerModal.tsx`'s own "manage the app's clipboard" popup.
 */

function copyViaExecCommand(text: string): boolean {
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  // The focused element (a text box the person is in) keeps its selection: focus is put back below.
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null
  document.body.appendChild(textarea)
  textarea.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  document.body.removeChild(textarea)
  active?.focus({ preventScroll: true })
  return ok
}

/** Puts `text` on the OS clipboard. */
export async function copyToOsClipboard(text: string): Promise<void> {
  if (copyViaExecCommand(text)) return
  await navigator.clipboard.writeText(text)
}

/** The text on the OS clipboard. Throws, with something a person can read, when the webview won't say. */
export async function readOsClipboard(): Promise<string> {
  try {
    return await navigator.clipboard.readText()
  } catch {
    throw new Error("The system's clipboard can't be read from here — paste with the system's own command (Ctrl+V, or press and hold in the box) instead.")
  }
}

/** An image read off the OS clipboard (a screenshot, a copied picture): its bytes and a file extension guessed
 * from its MIME type, for a name to save it under. */
export interface ClipboardImage {
  blob: Blob
  ext: string
}

const CLIPBOARD_IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
}

/** The image on the OS clipboard (e.g. a screenshot just taken), or `null` when there is text or nothing there
 * instead. Throws, with something a person can read, when the webview won't say — Android's WebView refuses to
 * read the OS clipboard at all (this module's own doc comment, above), so this always throws there. */
export async function readOsClipboardImage(): Promise<ClipboardImage | null> {
  let items: ClipboardItem[]
  try {
    items = await navigator.clipboard.read()
  } catch {
    throw new Error("The system's clipboard can't be read from here.")
  }
  for (const item of items) {
    const type = item.types.find((t) => t.startsWith('image/'))
    if (!type) continue
    return { blob: await item.getType(type), ext: CLIPBOARD_IMAGE_EXTENSIONS[type] ?? 'bin' }
  }
  return null
}

export const internalClipboard = {
  /** The whole stack, top (most recently pushed) first — for `ClipboardManagerModal.tsx`. */
  list: () => invoke<string[]>('internal_clipboard_list'),
  /** The top entry, or `null` when the stack is empty — a plain "paste": it doesn't remove the entry. */
  peek: () => invoke<string | null>('internal_clipboard_peek'),
  /** Adds a new entry on top — a plain "copy". */
  push: (text: string) => invoke<void>('internal_clipboard_push', { text }),
  /** Removes and returns the top entry, or `null` when the stack is empty. */
  pop: () => invoke<string | null>('internal_clipboard_pop'),
  /** Replaces the whole stack — `ClipboardManagerModal.tsx`'s one write command. */
  setAll: (entries: string[]) => invoke<void>('internal_clipboard_set_all', { entries }),
  /** Empties it entirely. */
  clear: () => invoke<void>('internal_clipboard_clear'),
}
