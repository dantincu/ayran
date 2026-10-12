import { invoke } from '@tauri-apps/api/core'

/** The text editors' own global settings (`components/CodeEditor.tsx`): wrapping, showing whitespace, line numbers,
 * and how the Tab key indents. One setting each, shared by every editor in the app (the Files tab's and Notes'
 * alike) — stored in `global_settings` like `listPageSize`/`rowActionsCompact`. `subscribeEditorSettings` follows
 * `rowActionsCompact`'s own pattern, so every mounted editor updates the moment a setting changes in Settings, in
 * the same window; other windows pick it up next time they load. */

export interface EditorSettings {
  /** Long lines wrap instead of scrolling sideways. On by default. */
  wrapLines: boolean
  /** Every whitespace character gets a distinct background, and a non-space one (tab, non-breaking space) is also
   * shown as a suggestive symbol — visual only, never copied (`lib/highlight.ts`'s text-content rule still holds:
   * the symbols are drawn by CSS, not inserted into the text). Off by default. */
  showWhitespace: boolean
  /** A gutter of line numbers beside the text. On by default. */
  lineNumbers: boolean
  /** The Tab key inserts this many spaces instead of a literal tab character. Off (a real tab) by default. */
  tabInsertsSpaces: boolean
  /** How many spaces `tabInsertsSpaces` inserts, or how many columns a literal tab is treated as wide for Shift+Tab
   * outdenting either way. */
  tabSpaceCount: number
}

const DEFAULTS: EditorSettings = {
  wrapLines: true,
  showWhitespace: false,
  lineNumbers: true,
  tabInsertsSpaces: false,
  tabSpaceCount: 4,
}

const KEYS = {
  wrapLines: 'editor.wrapLines',
  showWhitespace: 'editor.showWhitespace',
  lineNumbers: 'editor.lineNumbers',
  tabInsertsSpaces: 'editor.tabInsertsSpaces',
  tabSpaceCount: 'editor.tabSpaceCount',
} as const satisfies Record<keyof EditorSettings, string>

async function getBool(key: string, fallback: boolean): Promise<boolean> {
  const value = await invoke<string | null>('get_global_setting', { key })
  return value === null ? fallback : value === '1'
}

async function setBool(key: string, value: boolean): Promise<void> {
  await invoke('set_global_setting', { key, value: value ? '1' : '0' })
}

export async function getEditorSettings(): Promise<EditorSettings> {
  const [wrapLines, showWhitespace, lineNumbers, tabInsertsSpaces, tabSpaceCountRaw] = await Promise.all([
    getBool(KEYS.wrapLines, DEFAULTS.wrapLines),
    getBool(KEYS.showWhitespace, DEFAULTS.showWhitespace),
    getBool(KEYS.lineNumbers, DEFAULTS.lineNumbers),
    getBool(KEYS.tabInsertsSpaces, DEFAULTS.tabInsertsSpaces),
    invoke<string | null>('get_global_setting', { key: KEYS.tabSpaceCount }),
  ])
  const parsedCount = Number(tabSpaceCountRaw)
  const tabSpaceCount = Number.isInteger(parsedCount) && parsedCount > 0 && parsedCount <= 16 ? parsedCount : DEFAULTS.tabSpaceCount
  return { wrapLines, showWhitespace, lineNumbers, tabInsertsSpaces, tabSpaceCount }
}

let current: EditorSettings | null = null
const subscribers = new Set<(settings: EditorSettings) => void>()

/** Sets one setting and tells every subscriber in this window at once (Settings itself, and every mounted editor). */
export async function setEditorSetting<K extends keyof EditorSettings>(key: K, value: EditorSettings[K]): Promise<void> {
  if (key === 'tabSpaceCount') await invoke('set_global_setting', { key: KEYS[key], value: String(value) })
  else await setBool(KEYS[key], value as boolean)
  current = { ...(current ?? (await getEditorSettings())), [key]: value }
  subscribers.forEach((fn) => fn(current!))
}

/** Calls `fn` with the current settings (once loaded) and again every time one changes in this window. */
export function subscribeEditorSettings(fn: (settings: EditorSettings) => void): () => void {
  subscribers.add(fn)
  if (current) fn(current)
  else getEditorSettings().then((settings) => {
    current = settings
    fn(settings)
  })
  return () => {
    subscribers.delete(fn)
  }
}
