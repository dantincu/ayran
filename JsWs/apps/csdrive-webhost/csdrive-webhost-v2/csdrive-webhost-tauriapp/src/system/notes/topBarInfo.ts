/** What `NotesTopBar` shows besides its buttons: the current tab's `topBarHtml`/`topBarHidden` (see
 * `secondaryWindows.ts`'s `TabInitResponse` and `updateTabResource`, and CLAUDE.md's "The top bar").
 * A tiny module-level store, not React state, because the two things that produce this data —
 * `tabs.ts`'s `registerTab`/`onTabNavigate` handling and its `report*` functions — sit well above
 * `NotesTopBar` in the tree and have no other reason to hold a ref to it. */

export interface TopBarInfo {
  html: string
  hidden: boolean
}

let current: TopBarInfo | null = null
const subscribers = new Set<(info: TopBarInfo) => void>()

/** Called whenever a `TabInitResponse` arrives (`registerTab`, a `tab-navigate` event): replaces both fields. */
export function setTopBarInfo(info: TopBarInfo): void {
  current = info
  subscribers.forEach((fn) => fn(info))
}

/** Called after `updateTabResource` — only the markup could have changed, not whether the bar is hidden. */
export function setTopBarHtml(html: string): void {
  if (!current || current.html === html) return
  current = { ...current, html }
  subscribers.forEach((fn) => fn(current!))
}

/** `NotesTopBar`'s hook: called once with the latest info if there is one already, then on every change. */
export function subscribeTopBarInfo(fn: (info: TopBarInfo) => void): () => void {
  subscribers.add(fn)
  if (current) fn(current)
  return () => {
    subscribers.delete(fn)
  }
}
