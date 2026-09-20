import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import type { CodeSnippet } from './codeSnippets'

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
  /** Written in a monospaced font, like code. */
  mono?: boolean
}

export interface TabText {
  firstRow: TabTextSpan[]
  secondRow: TabTextSpan[]
}

export interface TabRecord {
  guid: string
  /** The title the page gave for its window, if it gave one (the window's title is otherwise made from the first row of `tabText`). */
  appTitle?: string | null
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
  /** The external web sites opened from this tab's page, oldest first. */
  externalPages: ExternalPageRecord[]
  /** The web apps opened from this tab (a Notes tab): files of a folder or a Filen account, each in a window of
   * its own that is listed here — not among the apps. */
  openedApps: OpenedAppRecord[]
}

/** A web app opened from a Notes tab, as listed under that tab. */
export interface OpenedAppRecord {
  /** The window entry's guid — what the window commands (`reopenSecondaryWindow`…) take. */
  guid: string
  kind: WindowKind
  relativePath: string
  /** The file's path in its storage. */
  path: string
  storage: 'UserFolder' | 'DeviceFolder' | 'FilenCloud'
  createdAt: number
  isOpen: boolean
  /** The page's own label (its tab's), once it has given one. */
  tabText: TabText | null
  tags: TagRecord[]
}

/** A file, named the way the Notes app names it (see `open_file_as_web_app`). */
export interface FileRef {
  storage: 'UserFolder' | 'DeviceFolder' | 'FilenCloud'
  /** `DeviceFolder`: the picked folder's root id. */
  root?: string
  /** `FilenCloud`: the account, and the branch (its index) when the file is opened in one. */
  userId?: number
  branch?: number | null
  /** Relative to the root, or — for Filen — a path in the drive. */
  path: string
}

/** An external web site opened from a tab's page: not a tab, a child of the tab that asked for it. */
export interface ExternalPageRecord {
  guid: string
  /** The tab whose page asked for it — it stays under that tab. */
  tabGuid: string
  windowGuid: string
  /** Where it was opened, and where it is now (it may have redirected, or been navigated). */
  initialUrl: string
  url: string
  /** The page's title, when it has one. */
  title: string | null
  createdAt: number
  isOpen: boolean
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

/** Which set a window belongs to: a web app from the user folder, or one of the app's own
 * system apps (Notes...). The two sets are listed, opened and closed separately. */
export type WindowKind = 'user' | 'system'

export interface SecondaryWindowRecord {
  guid: string
  kind: WindowKind
  /** The html file (user apps) or `system:<id>` (system apps). */
  relativePath: string
  createdAt: number
  isOpen: boolean
  tags: TagRecord[]
  tabGroups: TabGroupRecord[]
}

/** The Filen account (and branch) a page was opened from. */
export interface FilenOrigin {
  accountId: number
  email: string
  /** The name of the branch it was opened in, when it was opened in one. */
  branch: string | null
}

export interface TabInitResponse {
  tabGuid: string
  resourceId: string
  /** The page's own path: from the user folder for a web app, `system:<id>` for a system app, the path in
   * the drive for a file opened from Filen. */
  relativePath: string
  /** Who opened the page (the value is an enum member's name): the admin-app itself, or Notes' file manager. */
  openedBy: 'AdminApp' | 'NotesApp'
  /** Where the file is: the user folder, a folder the person picked on the device, Filen's cloud storage, or
   * — for a system app — this app itself. */
  storage: 'UserFolder' | 'DeviceFolder' | 'FilenCloud' | 'Bundled'
  /** When `storage` is `FilenCloud`: the account, and the branch if there is one. */
  filen?: FilenOrigin | null
  /** What every page should apply (see `codeSnippets.ts`). */
  codeSnippets?: CodeSnippet[]
}

const EVENT_CHANGED = 'secondary-windows-changed'

export interface SystemAppInfo {
  id: string
  name: string
  /** What its windows store as their relative path (`system:notes`). */
  relativePath: string
}

/** The system apps that ship with this app (a fixed list — there is no way to add one). */
export async function listSystemApps(): Promise<SystemAppInfo[]> {
  return invoke<SystemAppInfo[]>('list_system_apps')
}

export async function listSecondaryWindows(kind: WindowKind): Promise<SecondaryWindowRecord[]> {
  return invoke<SecondaryWindowRecord[]>('list_secondary_windows', { kind })
}

/** `relativePath` is the html file for a user app, the app's id (or `system:<id>`) for a system app. */
export async function openNewSecondaryWindow(kind: WindowKind, relativePath: string): Promise<SecondaryWindowRecord> {
  return invoke<SecondaryWindowRecord>('open_new_secondary_window', { kind, relativePath })
}

/** Registers a new entry in a group without opening a window for it — open it later with reopenSecondaryWindow. */
export async function addSecondaryWindowEntry(kind: WindowKind, relativePath: string): Promise<SecondaryWindowRecord> {
  return invoke<SecondaryWindowRecord>('add_secondary_window_entry', { kind, relativePath })
}

export async function reopenSecondaryWindow(guid: string): Promise<void> {
  await invoke('reopen_secondary_window', { guid })
}

/** Closes a window: the window goes away *and so does its entry* in the list (with its tab groups and
 * tabs). It works on a suspended window too — that is how one is removed. Compare
 * `suspendSecondaryWindow`, which closes only the window itself and keeps the entry. */
export async function closeSecondaryWindow(guid: string): Promise<void> {
  await invoke('close_secondary_window', { guid })
}

/** Suspends a window: only the actual window is closed; its entry, tab groups and tabs stay in the list,
 * and `reopenSecondaryWindow` brings it back. */
export async function suspendSecondaryWindow(guid: string): Promise<void> {
  await invoke('suspend_secondary_window', { guid })
}

/** Closes every window of the kind (all kinds when omitted; or, with `relativePath`, of that one app). */
export async function closeAllSecondaryWindows(kind?: WindowKind, relativePath?: string): Promise<void> {
  await invoke('close_all_secondary_windows', { kind: kind ?? null, relativePath: relativePath ?? null })
}

export async function suspendAllSecondaryWindows(kind?: WindowKind, relativePath?: string): Promise<void> {
  await invoke('suspend_all_secondary_windows', { kind: kind ?? null, relativePath: relativePath ?? null })
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

/** Called by a page, as it loads, to **bind itself to its tab**. The admin-app has already made the
 * tab (a window's tabs are created there — when the window is opened, or with "new tab"/"clone"),
 * so this never creates one: it finds the one made for this page — or, when the page is just
 * reloading, the tab its window is showing — and answers with it. To *add* another tab from the
 * page, use `addWindowTab`. The window is identified implicitly (its own Tauri window
 * label), never sent explicitly — see `secondary_windows::init_window_tab` in Rust.
 * `url` is the page's own address plus, if it likes, a query string of its own choosing; the backend splits it
 * into the window's html-file relative path and a resource id (relative path + query). A page never changes its
 * own address (it can't — see `FROZEN_ADDRESS_INIT_SCRIPT` in Rust), so the query is only a way of saying which
 * resource this tab shows; on a reload the answer carries the resource id the window manager stored.
 * `resourceType` (optional, can instead — or also — be set later via
 * `updateTabResource`) is the key into this app's icon set; if this is the first
 * time the backend has seen this `appVersion` for this html file, it will emit
 * `request-resource-icons` back at this same window, expecting a reply via
 * `submitResourceIcons`. */
export async function initWindowTab(appVersion: number, url: string, resourceType?: string): Promise<TabInitResponse> {
  return invoke<TabInitResponse>('init_window_tab', { appVersion, url, resourceType: resourceType ?? null })
}

/** Called by a page to **add another tab** to the list — a second document, a new view. It takes what
 * `initWindowTab` takes (the page's own `location.href`, the resource type) and answers with the same
 * data. The new tab is placed next to the one the window is showing and becomes the window's current
 * tab (the page is showing it now), so a reload of the page binds to it. This is the only request with
 * which a page creates a tab. */
export async function addWindowTab(appVersion: number, url: string, resourceType?: string): Promise<TabInitResponse> {
  return invoke<TabInitResponse>('add_window_tab', { appVersion, url, resourceType: resourceType ?? null })
}

const EVENT_TAB_NAVIGATE = 'tab-navigate'

/** Listens for the user switching to a tab of this window while it is open: the backend sends the same
 * data `initWindowTab` answers with — `{ tabGuid, resourceId, codeSnippets }`, the tab's own stored
 * resource id (empty for a tab that has never been used) — and the app shows that tab *in place*.
 * Every app gets it, system or user, and the page is never reloaded for it, so an app that has
 * several tabs must handle it. (A window that isn't open is opened instead, and the response of its
 * page's `initWindowTab` says which tab it is.)
 *
 * **Start listening before calling `initWindowTab`** (`await` this first), so no event can be missed. */
export function onTabNavigate(callback: (tab: TabInitResponse) => void): Promise<UnlistenFn> {
  // On this window, not the global `listen`: that one also hears events sent to *other* windows.
  return getCurrentWebviewWindow().listen<TabInitResponse>(EVENT_TAB_NAVIGATE, (event) => callback(event.payload))
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
  appTitle?: string,
): Promise<void> {
  await invoke('update_tab_resource', {
    tabGuid,
    tabText,
    appTitle: appTitle ?? null,
    resourceType: resourceType ?? null,
    resourceId: resourceId ?? null,
  })
}

/** **Notes only.** Opens an html or markdown file as a web app, in a window of its own that is listed under the
 * Notes tab that asked. The page can then open others next to itself with `openRelatedWebApp`. Resolves to the
 * new window's guid. */
export async function openFileAsWebApp(file: FileRef): Promise<string> {
  return invoke<string>('open_file_as_web_app', { file })
}

/** For a page that was opened from Notes: opens another file next to its own (`path` is relative to the page's),
 * listed under the same Notes tab. */
export async function openRelatedWebApp(path: string): Promise<string> {
  return invoke<string>('open_related_web_app', { path })
}

// ── External web sites ────────────────────────────────────────────────────────

/** Asks to open an external web site (http/https) in a window of this app. Nothing opens until the
 * person has answered an OS native box that shows the address; only one such box shows at a time, and
 * a request made while one is up is refused (this rejects) — requests are never queued. Resolves to the
 * request's id; the answer comes as an `external-site-response` event (see `onExternalSite`), and the
 * site — listed in the window manager under the tab this page is showing, not as a tab — reports its
 * address and title with `external-site-changed` events and its window closing with
 * `external-site-closed`. */
export async function openExternalSite(url: string): Promise<string> {
  return invoke<string>('open_external_site', { url })
}

export interface ExternalSiteResponse {
  requestId: string
  url: string
  /** The person said yes, and the site's window is open. */
  confirmed: boolean
  /** The site that was opened (it names it in the later events). */
  pageGuid: string | null
  /** Why it wasn't opened, when the person said yes but it couldn't be. */
  error: string | null
}

export interface ExternalSiteChange {
  pageGuid: string
  /** Where the site is now, and where it was opened. */
  url: string
  initialUrl: string
  /** The page's title, once it has one. */
  title: string | null
}

export interface ExternalSiteHandlers {
  onResponse?: (response: ExternalSiteResponse) => void
  onChanged?: (change: ExternalSiteChange) => void
  onClosed?: (pageGuid: string) => void
}

/** Listens for what happens to the external web sites this window asked for — on this window only, like
 * `onTabNavigate`. Start listening before calling `openExternalSite`. Returns how to stop. */
export async function onExternalSite(handlers: ExternalSiteHandlers): Promise<UnlistenFn> {
  const window = getCurrentWebviewWindow()
  const stops = await Promise.all([
    window.listen<ExternalSiteResponse>('external-site-response', (e) => handlers.onResponse?.(e.payload)),
    window.listen<ExternalSiteChange>('external-site-changed', (e) => handlers.onChanged?.(e.payload)),
    window.listen<{ pageGuid: string }>('external-site-closed', (e) => handlers.onClosed?.(e.payload.pageGuid)),
  ])
  return () => stops.forEach((stop) => stop())
}

/** Opens a listed site's window again, at the address it was at (no box: the person asked, here). */
export async function reopenExternalSite(guid: string): Promise<void> {
  await invoke('reopen_external_site', { guid })
}

export async function focusExternalSite(guid: string): Promise<void> {
  await invoke('focus_external_site', { guid })
}

/** **Suspends** the site: only its window is closed; the entry stays in the list, as suspended. (Suspending
 * the window of the tab it was opened from does this to all its sites.) */
export async function suspendExternalSite(guid: string): Promise<void> {
  await invoke('suspend_external_site', { guid })
}

/** **Closes** the site: its window is closed and its entry is removed from the list. (Closing its tab,
 * deleting the tab's group or closing the tab's window does this to all its sites.) */
export async function closeExternalSite(guid: string): Promise<void> {
  await invoke('close_external_site', { guid })
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

/** Deletes a tab group with its tabs (and the tags on all of them). If one of the tabs is the one an open
 * window is showing, that window is suspended. */
export async function deleteTabGroup(groupGuid: string): Promise<void> {
  await invoke('delete_tab_group', { groupGuid })
}

/** Closes a tab (deleting it, and its tags). If it is the tab an open window is showing, that window
 * is suspended; closing any other tab leaves windows alone. */
export async function closeTab(tabGuid: string): Promise<void> {
  await invoke('close_tab', { tabGuid })
}

/** Moves a tab into a different group — possibly under a different window, as long
 * as that window hosts the same html file (same app). */
export async function moveTabToGroup(tabGuid: string, targetGroupGuid: string): Promise<void> {
  await invoke('move_tab_to_group', { tabGuid, targetGroupGuid })
}
