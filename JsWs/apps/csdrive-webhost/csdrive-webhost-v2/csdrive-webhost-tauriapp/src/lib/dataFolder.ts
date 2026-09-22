import { invoke } from '@tauri-apps/api/core'
import { closeAllSecondaryWindows } from './secondaryWindows'
import { closeAllDatabases } from './sqlite'
import { wipeAllBrowserStorage } from './storageInspector'

/** Thin wrappers around the CsDrive backend's data-folder relocation commands. */

export interface DataFolderInfo {
  defaultPath: string
  customPath: string | null
  effectivePath: string
  /** False only on iOS, which has no folder-picking dialog of any kind yet. */
  canRelocate: boolean
  /** Whether picking a new folder (or wiping data) can restart the app itself afterward: true on
   * desktop only. Independent of `canRelocate` — Android can do the first without the second. */
  canRestart: boolean
}

export async function getDataFolderInfo(): Promise<DataFolderInfo> {
  return invoke<DataFolderInfo>('get_data_folder_info')
}

/** Opens a native folder picker; resolves to the picked path, or null if cancelled.
 * Does not move any files — takes effect on the next app restart. */
export async function pickAndSetCustomDataFolder(): Promise<string | null> {
  return invoke<string | null>('pick_and_set_custom_data_folder')
}

/** Reverts to the default data folder. Does not move any files. */
export async function resetDataFolderToDefault(): Promise<void> {
  await invoke('reset_data_folder_to_default')
}

/** Closes everything this app itself could be holding open inside the data
 * folder before it gets wiped, in the order that matters: every open secondary
 * window first (closing one can itself trigger further tab/database activity, so
 * nothing downstream may be touched until they're gone — the Rust command this
 * precedes waits for them to actually finish closing, not just requests it), then
 * any SQLite connections the SQLite tab has open on files under
 * `user/`, then this app's own browser storage (IndexedDB/localStorage/
 * sessionStorage — the same wipe the Storage tab's own button performs). Doesn't
 * touch `data.db` itself — only the Rust command that follows can reach that. */
async function prepareForDataWipe(): Promise<void> {
  await closeAllSecondaryWindows()
  await closeAllDatabases()
  await wipeAllBrowserStorage()
}

/** Deletes everything inside the custom data folder, if one is set. */
export async function clearCustomDataFolderContents(): Promise<void> {
  await prepareForDataWipe()
  await invoke('clear_custom_data_folder_contents')
}

/** Deletes everything inside the default app-data folder — the `user` folder,
 * `data.db`, and the encrypted data-location pointer file — the same way "clear
 * app data" works from the OS settings. Never touches the custom data folder. */
export async function deleteAppData(): Promise<void> {
  await prepareForDataWipe()
  await invoke('delete_app_data')
}
