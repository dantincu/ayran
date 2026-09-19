import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

export interface TagRecord {
  id: number
  guid: string
  text: string
  fgColor: string
  bgColor: string
}

export interface TabTextSpan {
  text: string
  bold?: boolean
  italic?: boolean
}

export interface TabText {
  firstRow: TabTextSpan[]
  secondRow: TabTextSpan[]
}

export interface TabRecord {
  guid: string
  groupGuid: string
  windowGuid: string
  relativePath: string
  appVersion: number
  resourceId: string
  resourceType: string | null
  /** SVG markup registered by the app for `resourceType`, resolved server-side. */
  icon: string | null
  tabText: TabText | null
  createdAt: number
  tags: TagRecord[]
}

export interface TabGroupRecord {
  guid: string
  windowGuid: string
  createdAt: number
  name: string | null
  tags: TagRecord[]
  tabs: TabRecord[]
}

export interface SecondaryWindowRecord {
  guid: string
  relativePath: string
  createdAt: number
  isOpen: boolean
  tags: TagRecord[]
  tabGroups: TabGroupRecord[]
}

export interface TabInitResponse {
  tabGuid: string
  resourceId: string
}

const EVENT_CHANGED = 'secondary-windows-changed'

export async function listSecondaryWindows(): Promise<SecondaryWindowRecord[]> {
  return invoke<SecondaryWindowRecord[]>('list_secondary_windows')
}

export async function openNewSecondaryWindow(relativePath: string): Promise<SecondaryWindowRecord> {
  return invoke<SecondaryWindowRecord>('open_new_secondary_window', { relativePath })
}

/** Registers a new entry in a group without opening a window for it — open it later with reopenSecondaryWindow. */
export async function addSecondaryWindowEntry(relativePath: string): Promise<SecondaryWindowRecord> {
  return invoke<SecondaryWindowRecord>('add_secondary_window_entry', { relativePath })
}

export async function reopenSecondaryWindow(guid: string, relativePath: string): Promise<void> {
  await invoke('reopen_secondary_window', { guid, relativePath })
}

export async function closeSecondaryWindow(guid: string): Promise<void> {
  await invoke('close_secondary_window', { guid })
}

export async function suspendSecondaryWindow(guid: string): Promise<void> {
  await invoke('suspend_secondary_window', { guid })
}

export async function closeAllSecondaryWindows(relativePath?: string): Promise<void> {
  await invoke('close_all_secondary_windows', { relativePath: relativePath ?? null })
}

export async function suspendAllSecondaryWindows(relativePath?: string): Promise<void> {
  await invoke('suspend_all_secondary_windows', { relativePath: relativePath ?? null })
}

export async function focusSecondaryWindow(guid: string): Promise<void> {
  await invoke('focus_secondary_window', { guid })
}

export function onSecondaryWindowsChanged(callback: () => void): Promise<UnlistenFn> {
  return listen(EVENT_CHANGED, () => callback())
}

/** Tags attached to arbitrary guids — tags aren't tied to windows, so anything with a
 * stable id (e.g. a file-manager root) can carry them. */
export async function listTags(guids: string[]): Promise<TagRecord[]> {
  return invoke<TagRecord[]>('list_tags', { guids })
}

export async function addWindowTag(
  guid: string,
  text: string,
  fgColor: string,
  bgColor: string,
): Promise<TagRecord> {
  return invoke<TagRecord>('add_window_tag', { guid, text, fgColor, bgColor })
}

export async function updateWindowTag(id: number, text: string, fgColor: string, bgColor: string): Promise<void> {
  await invoke('update_window_tag', { id, text, fgColor, bgColor })
}

/** Sets the order of the tags on `guid`. Any of its tags missing from `ids` keep
 * their relative order after the listed ones. */
export async function reorderWindowTags(guid: string, ids: number[]): Promise<void> {
  await invoke('reorder_window_tags', { guid, ids })
}

export async function removeWindowTag(id: number): Promise<void> {
  await invoke('remove_window_tag', { id })
}

/** Called by an app running inside a secondary window to register one of its
 * resources as a tab. The window is identified implicitly (its own Tauri window
 * label), never sent explicitly — see `secondary_windows::init_window_tab` in Rust.
 * `url` is expected to be the page's own `location.href`; the backend splits it into
 * the window's html-file relative path and a resource id (relative path + query).
 * `resourceType` (optional, can instead — or also — be set later via
 * `updateTabResource`) is the key into this app's icon set; if this is the first
 * time the backend has seen this `appVersion` for this html file, it will emit
 * `request-resource-icons` back at this same window, expecting a reply via
 * `submitResourceIcons`. */
export async function initWindowTab(appVersion: number, url: string, resourceType?: string): Promise<TabInitResponse> {
  return invoke<TabInitResponse>('init_window_tab', { appVersion, url, resourceType: resourceType ?? null })
}

/** Sets (or replaces) the two-line, styled label a tab shows in the window manager,
 * and optionally its resource type (see `initWindowTab`) and/or its resource id —
 * e.g. the app navigated to a different view within the same tab, without opening
 * a new one. Omitting either leaves that field as it was. Only the window that
 * owns the tab may update it. */
export async function updateTabResource(
  tabGuid: string,
  tabText: TabText,
  resourceType?: string,
  resourceId?: string,
): Promise<void> {
  await invoke('update_tab_resource', { tabGuid, tabText, resourceType: resourceType ?? null, resourceId: resourceId ?? null })
}

const EVENT_REQUEST_RESOURCE_ICONS = 'request-resource-icons'

/** Reports this app's icon set in response to a `request-resource-icons` event —
 * a map of resource-type key to SVG markup. The backend figures out which app this
 * is from the calling window, same as `initWindowTab`. */
export async function submitResourceIcons(icons: Record<string, string>): Promise<void> {
  await invoke('submit_resource_icons', { icons })
}

/** Listens for the backend asking this window's app to (re-)report its icon set —
 * fired the first time a given `appVersion` is seen for this html file, and again
 * whenever `appVersion` increases. `getIcons` may be async. */
export function onResourceIconsRequested(getIcons: () => Record<string, string> | Promise<Record<string, string>>): Promise<UnlistenFn> {
  return listen(EVENT_REQUEST_RESOURCE_ICONS, async () => {
    const icons = await getIcons()
    await submitResourceIcons(icons)
  })
}

/** Creates an empty tab group under a window, so tabs have somewhere to move to.
 * Gets a suggestive default name ("Tab Group N") — see `renameTabGroup`. */
export async function createTabGroup(windowGuid: string): Promise<TabGroupRecord> {
  return invoke<TabGroupRecord>('create_tab_group', { windowGuid })
}

/** Renames a tab group. An empty/blank name clears it back to unnamed. */
export async function renameTabGroup(guid: string, name: string): Promise<void> {
  await invoke('rename_tab_group', { guid, name })
}

/** Adds a blank tab to a group — no immediate effect on the corresponding
 * secondary window. Its resource id starts empty and its label starts blank;
 * activating it later (see `activateTab`) tells the web app it's now
 * representing this (possibly still blank) tab, and lets it decide what to show. */
export async function addBlankTab(groupGuid: string): Promise<TabRecord> {
  return invoke<TabRecord>('add_blank_tab', { groupGuid })
}

/** Adds a new tab to the same group as `tabGuid`, copying its resource id (but
 * not its label — the web app fills that in again once activated). */
export async function cloneTab(tabGuid: string): Promise<TabRecord> {
  return invoke<TabRecord>('clone_tab', { tabGuid })
}

/** Makes a tab the one its window's next init request binds to, then makes that
 * window "reopen its web app" (a fresh reload, discarding any in-app navigation
 * state) — opening it first if it was suspended. The web app's own subsequent
 * `initWindowTab` call is told this tab's own resource id (possibly empty, for a
 * tab that's never been used) instead of one derived from its URL, so it can
 * decide what to show for it. */
export async function activateTab(tabGuid: string): Promise<void> {
  await invoke('activate_tab', { tabGuid })
}

/** Moves a tab into a different group — possibly under a different window, as long
 * as that window hosts the same html file (same app). */
export async function moveTabToGroup(tabGuid: string, targetGroupGuid: string): Promise<void> {
  await invoke('move_tab_to_group', { tabGuid, targetGroupGuid })
}
