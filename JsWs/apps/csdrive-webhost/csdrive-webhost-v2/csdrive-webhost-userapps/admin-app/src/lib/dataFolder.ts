import { invoke } from '@tauri-apps/api/core'

/** Thin wrappers around the CsDrive backend's data-folder relocation commands. */

export interface DataFolderInfo {
  defaultPath: string
  customPath: string | null
  effectivePath: string
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

/** Deletes everything inside the custom data folder, if one is set. */
export async function clearCustomDataFolderContents(): Promise<void> {
  await invoke('clear_custom_data_folder_contents')
}

/** Deletes everything inside the default app-data folder — the `user` folder,
 * `data.db`, and the encrypted data-location pointer file — the same way "clear
 * app data" works from the OS settings. Never touches the custom data folder. */
export async function deleteAppData(): Promise<void> {
  await invoke('delete_app_data')
}
