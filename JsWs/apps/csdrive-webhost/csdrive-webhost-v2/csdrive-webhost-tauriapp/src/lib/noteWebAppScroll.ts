import { invoke } from '@tauri-apps/api/core'

/** Whether a note's web app, on reload (an autosync, a tab switch back to it, a manual refresh), restores a
 * *partial* scroll position — by the proportion scrolled, not the raw pixel offset — when it wasn't at the
 * bottom. Off by default: the existing, unconditional "stay at the bottom if it was there" behaviour
 * (`markdown.rs`'s own `BOOTSTRAP`) is unaffected either way, and this only ever adds a second case on top
 * of it (item 1 of the todo). **Lives in `global_settings`, not Notes' own app state** — the markdown
 * page's own app id is never `system:notes` (CLAUDE.md's "App state storage": a window only ever reaches
 * its own namespace), so the bootstrap script, which is what actually reads this value, calls
 * `get_global_setting` directly — the same reason `rowActionsCompact.ts` is global and not per-app. Kept as
 * a thin wrapper here, the same shape as that module, purely for the Settings page's own checkbox; the
 * bootstrap script reads the identical key by its own literal string (`markdown.rs`), since it's plain,
 * Rust-generated JS with no access to this TypeScript module. */

const KEY = 'notes.webAppPreservePartialScroll'

export async function getPreservePartialScroll(): Promise<boolean> {
  return (await invoke<string | null>('get_global_setting', { key: KEY })) === '1'
}

export async function setPreservePartialScroll(value: boolean): Promise<void> {
  await invoke('set_global_setting', { key: KEY, value: value ? '1' : '0' })
}
