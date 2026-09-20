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

/** How the Notes app takes part in the window manager (see the User Apps / System Apps tabs of the
 * admin-app): each tab it registers is one place in the file manager, its resource id naming the
 * place — `system:notes?s=<source>&b=<branch>&p=<path>&o=<records skipped>` — so that activating the tab later, or
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
}

/** Bumped when the icon set below changes: the backend then asks the page for it again. */
const APP_VERSION = 1

const RESOURCE_TYPES = { local: 'local', filen: 'filen', branch: 'branch' } as const

const svg = (paths: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`

/** The tab icons, by resource type. */
const ICONS: Record<string, string> = {
  local: svg('<line x1="22" x2="2" y1="12" y2="12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/><line x1="6" x2="6.01" y1="16" y2="16"/><line x1="10" x2="10.01" y1="16" y2="16"/>'),
  filen: svg('<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>'),
  branch: svg('<line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>'),
}

export function resourceTypeOf(location: Location): string {
  if (location.sourceId.startsWith('filen:')) return location.branch === null ? RESOURCE_TYPES.filen : RESOURCE_TYPES.branch
  return RESOURCE_TYPES.local
}

export function encodeLocation(location: Location): string {
  const params = new URLSearchParams({ s: location.sourceId, p: location.path })
  if (location.branch !== null) params.set('b', String(location.branch))
  if (location.offset) params.set('o', String(location.offset))
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
  return {
    sourceId,
    branch: params.has('b') && Number.isInteger(branch) ? branch : null,
    path: params.get('p') ?? '',
    ...(offset !== null ? { offset } : {}),
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
let navigateHandler: ((tab: Tab) => void) | null = null
let navigateBuffered: Tab | null = null

function deliverNavigation(tab: Tab): void {
  if (navigateHandler) navigateHandler(tab)
  else navigateBuffered = tab
}

/** Calls `handler` with each tab the user switches to (first, with one that came before this was
 * called). Returns how to stop. */
export function subscribeNavigate(handler: (tab: Tab) => void): () => void {
  navigateHandler = handler
  if (navigateBuffered) {
    const waiting = navigateBuffered
    navigateBuffered = null
    handler(waiting)
  }
  return () => {
    if (navigateHandler === handler) navigateHandler = null
  }
}

/** Registers this page as a tab; null if that isn't possible (e.g. the page isn't in a managed window). */
export async function registerTab(): Promise<Tab | null> {
  try {
    await onResourceIconsRequested(() => ICONS)
    await onTabNavigate((response) => {
      applyCodeSnippets(response.codeSnippets ?? [])
      deliverNavigation({ tabGuid: response.tabGuid, resourceId: response.resourceId })
    })
    const response = await initWindowTab(APP_VERSION, location.href)
    applyCodeSnippets(response.codeSnippets ?? [])
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

/** Tells the window manager which place the tab is at now, and how to label it. Also puts the place
 * in this page's address, so a plain reload comes back to it. */
export async function reportLocation(tab: Tab, location: Location, label: string, branchName: string | null): Promise<void> {
  const query = encodeLocation(location)
  history.replaceState(null, '', `${window.location.pathname}?${query}`)
  const firstRow: TabText['firstRow'] = [{ text: label, bold: true }]
  if (branchName) firstRow.push({ text: ` · ${branchName}`, italic: true })
  const secondRow: TabText['secondRow'] = [{ text: location.path ? `/${location.path}` : '/' }]
  try {
    await updateTabResource(tab.tabGuid, { firstRow, secondRow }, resourceTypeOf(location), `system:notes?${query}`)
  } catch {
    // The tab may have been closed from the window manager meanwhile — nothing to report to.
  }
}
