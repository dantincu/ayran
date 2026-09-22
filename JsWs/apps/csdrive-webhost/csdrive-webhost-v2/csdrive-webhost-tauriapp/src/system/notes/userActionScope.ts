import { invoke } from '@tauri-apps/api/core'

/** Which resource of this Notes window the User Action window was launched from, and when the window leaves it.
 *
 * The User Action window is launched *from* a resource — the Notes tab's resource identifier (a place of Notes, a note's editor…) — and is
 * told about it (`user-action-launched`). When the person goes elsewhere (another place, another note, another tab), what opened it is out
 * of scope and the window is told (`user-action-scope-left`) — once: the window stays open, and what it does about it is the page's own
 * business. Pagination alone (`o=`, the records skipped) is not a change of resource. */

/** What it was launched from, as the window told it (with the position in the listing), and the same without the position. */
let launchedFrom: { id: string; key: string } | null = null
let current = 'system:notes'

/** A resource identifier without what is only how far down a listing the person is. */
export function sameResource(id: string): string {
  const cut = id.indexOf('?')
  if (cut < 0) return id
  const params = new URLSearchParams(id.slice(cut + 1))
  params.delete('o')
  params.sort()
  return `${id.slice(0, cut)}?${params.toString()}`
}

/** The resource identifier of what this window shows now. */
export function currentResource(): string {
  return current
}

/** The window's tab shows `resourceId` now: if the User Action was launched from something else, it is told that it is out of scope. */
export function resourceIs(resourceId: string): void {
  current = resourceId
  if (launchedFrom === null || sameResource(resourceId) === launchedFrom.key) return
  const from = launchedFrom.id
  launchedFrom = null
  invoke('user_action_scope_left', { resourceId: from, now: resourceId }).catch(() => {})
}

/** The User Action was launched from the resource being shown. */
export function launchedNow(): void {
  launchedFrom = { id: current, key: sameResource(current) }
}
