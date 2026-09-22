import {
  initWindowTab,
  onResourceIconsRequested,
  onTabNavigate,
  updateTabResource,
  type TabText,
} from '../../lib/secondaryWindows'
import { applyCodeSnippets } from '../../lib/codeSnippets'
import { validOffset } from '../../lib/pagedPosition'
import { invoke } from '@tauri-apps/api/core'
import { resourceIs } from './userActionScope'

/** How the Notes app takes part in the window manager (see the User Apps / System Apps tabs of the
 * admin-app): each tab it registers is one place in the file manager, its resource id naming the
 * place — `system:notes?s=<source>&b=<branch>&p=<path>&o=<records skipped>&e=<file being edited>` — so that activating the tab later, or
 * cloning it, brings the same place back. */

export interface Location {
  /** `local:user`, `local:<picked folder's root id>`, `filen:<userId>` */
  sourceId: string
  /** The Filen branch (its index) being worked in, or null for the account itself. */
  branch: number | null
  /** Relative to the source's root, `/`-separated; `''` is the root. */
  path: string
  /** How many records of the folder's listing were skipped (see lib/pagedPosition.ts) — not a page
   * number, which would mean other records under another page size. Absent: the start. */
  offset?: number
  /** The file open in the editor, as a path relative to the source's root; absent: none. Part of the place,
   * so the tab shows that it is being edited, and activating or reloading it opens the editor again. */
  edit?: string
}

/** Bumped when the icon set below changes: the backend then asks the page for it again. */
const APP_VERSION = 4

const RESOURCE_TYPES = {
  local: 'local',
  filen: 'filen',
  branch: 'branch',
  editing: 'editing',
  home: 'home',
  notebooks: 'notebooks',
  settings: 'settings',
  notes: 'notes',
  noteEdit: 'noteedit',
  noteFiles: 'notefiles',
} as const

/** What a Notes tab shows: the home page, the page for managing notebooks, or the file manager (at a place; `null`: where
 * it was last). The resource id names it: `system:notes?v=home`, `system:notes?v=notebooks`, or — for the file manager —
 * the place's query (see `encodeLocation`). A tab that names nothing shows the home page. */
export type Place =
  | { view: 'home' }
  | { view: 'notebooks' }
  | { view: 'settings' }
  | { view: 'files'; location: Location | null }
  /** The notes in a notebook's root folder or in a note's short folder (`folder`, relative to the source's root). */
  | { view: 'notes'; sourceId: string; folder: string }
  /** The dedicated page for editing a note's markdown. */
  | { view: 'noteEdit'; sourceId: string; folder: string }
  /** The explorer of a note's files (its `01` folder), at `path` inside it. */
  | { view: 'noteFiles'; sourceId: string; folder: string; path: string }

/** The place a resource id (or a page's query string) names, if it names one. */
export function decodePlace(resourceId: string): Place | null {
  const query = resourceId.includes('?') ? resourceId.slice(resourceId.indexOf('?') + 1) : ''
  const view = new URLSearchParams(query).get('v')
  if (view === 'home') return { view: 'home' }
  if (view === 'notebooks') return { view: 'notebooks' }
  if (view === 'settings') return { view: 'settings' }
  const params = new URLSearchParams(query)
  const sourceId = params.get('s')
  const folder = params.get('f')
  if (sourceId && folder !== null) {
    if (view === 'notes') return { view: 'notes', sourceId, folder }
    if (view === 'noteEdit') return { view: 'noteEdit', sourceId, folder }
    if (view === 'noteFiles') return { view: 'noteFiles', sourceId, folder, path: params.get('p') ?? '' }
  }
  const location = decodeLocation(resourceId)
  return location ? { view: 'files', location } : null
}

const svg = (paths: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`

/** The tab icons, by resource type. */
const ICONS: Record<string, string> = {
  local: svg('<line x1="22" x2="2" y1="12" y2="12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/><line x1="6" x2="6.01" y1="16" y2="16"/><line x1="10" x2="10.01" y1="16" y2="16"/>'),
  filen: svg('<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>'),
  editing: svg('<path d="M12 20h9"/><path d="M16.376 3.622a1 1 0 0 1 3.002 3.002L7.368 18.635a2 2 0 0 1-.855.506l-2.872.838a.5.5 0 0 1-.62-.62l.838-2.872a2 2 0 0 1 .506-.854z"/>'),
  home: svg('<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
  notebooks: svg('<path d="M2 6h4"/><path d="M2 10h4"/><path d="M2 14h4"/><path d="M2 18h4"/><rect width="16" height="20" x="4" y="2" rx="2"/><path d="M16 2v20"/>'),
  settings: svg('<path d="M20 7h-9"/><path d="M14 17H5"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/>'),
  notes: svg('<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>'),
  noteedit: svg('<path d="M12 20h9"/><path d="M16.376 3.622a1 1 0 0 1 3.002 3.002L7.368 18.635a2 2 0 0 1-.855.506l-2.872.838a.5.5 0 0 1-.62-.62l.838-2.872a2 2 0 0 1 .506-.854z"/>'),
  notefiles: svg('<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>'),
  branch: svg('<line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>'),
}

export function resourceTypeOf(location: Location): string {
  if (location.edit) return RESOURCE_TYPES.editing
  if (location.sourceId.startsWith('filen:')) return location.branch === null ? RESOURCE_TYPES.filen : RESOURCE_TYPES.branch
  return RESOURCE_TYPES.local
}

export function encodeLocation(location: Location): string {
  const params = new URLSearchParams({ s: location.sourceId, p: location.path })
  if (location.branch !== null) params.set('b', String(location.branch))
  if (location.offset) params.set('o', String(location.offset))
  if (location.edit) params.set('e', location.edit)
  return params.toString()
}

/** The location a resource id (or a page's query string) names, if it names one. */
export function decodeLocation(resourceId: string): Location | null {
  const query = resourceId.includes('?') ? resourceId.slice(resourceId.indexOf('?') + 1) : ''
  const params = new URLSearchParams(query)
  const sourceId = params.get('s')
  if (!sourceId) return null
  const branch = Number(params.get('b'))
  const offset = validOffset(Number(params.get('o')))
  const edit = params.get('e')
  return {
    sourceId,
    branch: params.has('b') && Number.isInteger(branch) ? branch : null,
    path: params.get('p') ?? '',
    ...(offset !== null ? { offset } : {}),
    ...(edit ? { edit } : {}),
  }
}

export interface Tab {
  tabGuid: string
  /** What the backend says this tab shows: its own stored resource id when the tab was activated
   * from the window manager, otherwise the one this page's address gave. */
  resourceId: string
}

// The window manager tells this page when the user switches to another tab of the window (the
// `tab-navigate` event). The listener is added before the page registers, so none is missed — but
// the first can arrive before React has mounted anything to receive it, so it waits here.
// Several parts of the page listen (the page that chooses the view, and the file manager inside it): each gets every
// switch. One that came before anybody listened goes to the first to listen.
const navigateHandlers = new Set<(tab: Tab) => void>()
let navigateBuffered: Tab | null = null

function deliverNavigation(tab: Tab): void {
  if (navigateHandlers.size > 0) navigateHandlers.forEach((handler) => handler(tab))
  else navigateBuffered = tab
}

/** Calls `handler` with each tab the user switches to (first, with one that came before anything was
 * listening). Returns how to stop. */
export function subscribeNavigate(handler: (tab: Tab) => void): () => void {
  navigateHandlers.add(handler)
  if (navigateBuffered) {
    const waiting = navigateBuffered
    navigateBuffered = null
    handler(waiting)
  }
  return () => {
    navigateHandlers.delete(handler)
  }
}

/** Registers this page as a tab; null if that isn't possible (e.g. the page isn't in a managed window). */
export async function registerTab(): Promise<Tab | null> {
  try {
    await onResourceIconsRequested(() => ICONS)
    await onTabNavigate((response) => {
      applyCodeSnippets(response.codeSnippets ?? [])
      resourceIs(response.resourceId || 'system:notes')
      deliverNavigation({ tabGuid: response.tabGuid, resourceId: response.resourceId })
    })
    const response = await initWindowTab(APP_VERSION, location.href)
    applyCodeSnippets(response.codeSnippets ?? [])
    resourceIs(response.resourceId || 'system:notes')
    return { tabGuid: response.tabGuid, resourceId: response.resourceId }
  } catch {
    // Unmanaged (or an old backend): the app works the same, it just isn't listed as a tab.
    try {
      applyCodeSnippets(await invoke('get_code_snippets'))
    } catch {
      // Not adjusting the page is better than not showing it.
    }
    return null
  }
}

/** The address of a place of the note pages, as it goes in a resource id. */
export function encodeNotePlace(place: Extract<Place, { view: 'notes' | 'noteEdit' | 'noteFiles' }>): string {
  const params = new URLSearchParams({ v: place.view, s: place.sourceId, f: place.folder })
  if (place.view === 'noteFiles' && place.path) params.set('p', place.path)
  return params.toString()
}

/** Tells the window manager what a note page shows: `title` (a notebook's or a note's), the kind of page, and whether what
 * the page holds has changes that aren't saved. */
export async function reportNotePlace(
  tab: Tab,
  place: Extract<Place, { view: 'notes' | 'noteEdit' | 'noteFiles' }>,
  title: string,
  unsaved = false,
): Promise<void> {
  const what = place.view === 'notes' ? 'Notes' : place.view === 'noteEdit' ? 'Editing the note' : `Files${place.path ? ` · /${place.path}` : ''}`
  const firstRow: TabText['firstRow'] = [{ text: title, bold: true }]
  const secondRow: TabText['secondRow'] = [{ text: what }, ...(unsaved ? [{ text: 'unsaved changes', italic: true }] : [])]
  const type = place.view === 'notes' ? RESOURCE_TYPES.notes : place.view === 'noteEdit' ? RESOURCE_TYPES.noteEdit : RESOURCE_TYPES.noteFiles
  resourceIs(`system:notes?${encodeNotePlace(place)}`)
  try {
    await updateTabResource(tab.tabGuid, { firstRow, secondRow }, type, `system:notes?${encodeNotePlace(place)}`)
  } catch {
    // The tab may have been closed from the window manager meanwhile — nothing to report to.
  }
}

/** Tells the window manager that the tab shows the home page or the page for managing notebooks. */
export async function reportView(tab: Tab, view: 'home' | 'notebooks' | 'settings'): Promise<void> {
  const firstRow: TabText['firstRow'] = [{ text: view === 'home' ? 'Notes' : view === 'settings' ? 'Notes' : 'Notebooks', bold: true }]
  const secondRow: TabText['secondRow'] = [{ text: view === 'home' ? 'Home' : view === 'settings' ? 'Settings' : 'Manage notebooks' }]
  resourceIs(`system:notes?v=${view}`)
  try {
    await updateTabResource(tab.tabGuid, { firstRow, secondRow }, RESOURCE_TYPES[view], `system:notes?v=${view}`)
  } catch {
    // The tab may have been closed from the window manager meanwhile — nothing to report to.
  }
}

/** Tells the window manager which place the tab is at now, and how to label it. (The page's own address
 * never changes — a page can't — so a reload comes back to the place through the resource id the window
 * manager stored, which the page's registration answers with.) */
export async function reportLocation(
  tab: Tab,
  location: Location,
  label: string,
  branchName: string | null,
  /** The file in the editor has changes that aren't saved. */
  unsaved = false,
): Promise<void> {
  const query = encodeLocation(location)
  const firstRow: TabText['firstRow'] = [{ text: label, bold: true }]
  if (branchName) firstRow.push({ text: branchName, italic: true })
  // A tab that is editing a file says so — and whether there is something not saved yet.
  const secondRow: TabText['secondRow'] = location.edit
    ? [{ text: `Editing /${location.edit}`, bold: true }, ...(unsaved ? [{ text: 'unsaved changes', italic: true }] : [])]
    : [{ text: location.path ? `/${location.path}` : '/' }]
  resourceIs(`system:notes?${query}`)
  try {
    await updateTabResource(tab.tabGuid, { firstRow, secondRow }, resourceTypeOf(location), `system:notes?${query}`)
  } catch {
    // The tab may have been closed from the window manager meanwhile — nothing to report to.
  }
}
