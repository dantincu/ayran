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
  tabText: TabText | null
  createdAt: number
  tags: TagRecord[]
}

export interface TabGroupRecord {
  guid: string
  windowGuid: string
  createdAt: number
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

export async function addWindowTag(
  guid: string,
  text: string,
  fgColor: string,
  bgColor: string,
): Promise<TagRecord> {
  return invoke<TagRecord>('add_window_tag', { guid, text, fgColor, bgColor })
}

export async function removeWindowTag(id: number): Promise<void> {
  await invoke('remove_window_tag', { id })
}

/** Called by an app running inside a secondary window to register one of its
 * resources as a tab. The window is identified implicitly (its own Tauri window
 * label), never sent explicitly — see `secondary_windows::init_window_tab` in Rust.
 * `url` is expected to be the page's own `location.href`; the backend splits it into
 * the window's html-file relative path and a resource id (relative path + query). */
export async function initWindowTab(appVersion: number, url: string): Promise<TabInitResponse> {
  return invoke<TabInitResponse>('init_window_tab', { appVersion, url })
}

/** Sets (or replaces) the two-line, styled label a tab shows in the window manager.
 * Only the window that owns the tab may update it. */
export async function updateTabResource(tabGuid: string, tabText: TabText): Promise<void> {
  await invoke('update_tab_resource', { tabGuid, tabText })
}

/** Creates an empty tab group under a window, so tabs have somewhere to move to. */
export async function createTabGroup(windowGuid: string): Promise<TabGroupRecord> {
  return invoke<TabGroupRecord>('create_tab_group', { windowGuid })
}

/** Moves a tab into a different group — possibly under a different window, as long
 * as that window hosts the same html file (same app). */
export async function moveTabToGroup(tabGuid: string, targetGroupGuid: string): Promise<void> {
  await invoke('move_tab_to_group', { tabGuid, targetGroupGuid })
}
