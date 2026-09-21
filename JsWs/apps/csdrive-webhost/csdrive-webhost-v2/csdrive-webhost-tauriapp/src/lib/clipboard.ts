import { invoke } from '@tauri-apps/api/core'

/** The two clipboards a window of this app can use.
 *
 * - **The OS clipboard**: what the rest of the system sees. Written synchronously through `execCommand` first — reliable in
 *   a desktop webview, where the asynchronous Clipboard API can wait for a permission that never comes when the window
 *   lacks focus — and through the Clipboard API when that isn't possible. Read through the Clipboard API only (the webview
 *   may ask the person to allow it).
 * - **The app's own clipboard** (`internal_clipboard.rs`): one text, kept by the backend and shared by every window of the
 *   admin-app and of the system apps. Nothing copied to it reaches other programs, and the OS clipboard is left alone.
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

export const internalClipboard = {
  /** The text on the app's own clipboard (empty when nothing was copied to it). */
  get: () => invoke<string>('internal_clipboard_get'),
  /** Replaces the text on the app's own clipboard. */
  set: (text: string) => invoke<void>('internal_clipboard_set', { text }),
  /** Empties it. */
  clear: () => invoke<void>('internal_clipboard_clear'),
}
