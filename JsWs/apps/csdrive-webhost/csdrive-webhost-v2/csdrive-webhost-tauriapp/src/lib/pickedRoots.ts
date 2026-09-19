import { invoke } from '@tauri-apps/api/core'

/** Thin wrappers around the backend's folder-picker commands (see `picked_roots.rs`): Android's
 * own folder picker (`FolderPicker.kt`), which browses the real filesystem, and the memory of what
 * was picked (kept across restarts on both platforms). A picked folder is only ever known here by
 * its **root id** (a random string; pass it as `root` to the file commands) and its own name — the
 * real path never reaches a window. */

export interface PickedRoot {
  /** Names the folder to the file commands (`fs_*`, `sqlite_load`). Opaque. */
  id: string
  /** The folder's own name, for showing. */
  label: string
}

/** Opens the folder picker; resolves to the chosen folder (already usable with the fs commands,
 * and remembered across restarts) or null if the person cancelled. */
export function pickFolder(): Promise<PickedRoot | null> {
  return invoke<PickedRoot | null>('pick_folder')
}

export function listPickedRoots(): Promise<PickedRoot[]> {
  return invoke<PickedRoot[]>('list_picked_roots')
}

/** Stops remembering the folder and takes it out of what the app may use, at once; nothing inside
 * it is touched. */
export async function removePickedRoot(id: string): Promise<void> {
  await invoke('remove_picked_root', { id })
}
