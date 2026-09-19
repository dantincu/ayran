import { invoke } from '@tauri-apps/api/core'

/** Thin wrappers around the backend's folder-picker commands (see `picked_roots.rs`): Android's
 * own folder picker (`FolderPicker.kt`), which hands back real paths, and the memory of what was
 * picked. On desktop `listPickedRoots` is always empty — folders are picked with the native
 * dialog there and last one session. */

export interface PickedRoot {
  path: string
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

/** Stops remembering the folder; nothing inside it is touched. */
export async function removePickedRoot(path: string): Promise<void> {
  await invoke('remove_picked_root', { path })
}
