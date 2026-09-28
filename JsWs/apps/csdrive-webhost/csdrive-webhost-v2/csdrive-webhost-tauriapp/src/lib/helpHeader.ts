/** Tells the Help tab's own header to show itself again — a plain module-level pub/sub, the same shape
 * `system/notes/topBarInfo.ts` uses for Notes' top bar, since the trigger (`App.tsx`'s tab button, pressed while
 * already on the Help tab) and the listener (`HelpHeader`, inside `HelpTab`) are unrelated in the component tree. */

const listeners = new Set<() => void>()

export function showHelpHeader(): void {
  listeners.forEach((fn) => fn())
}

export function subscribeShowHelpHeader(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}
