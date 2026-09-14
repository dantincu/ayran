import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

export interface TagRecord {
  id: number
  guid: string
  text: string
  fgColor: string
  bgColor: string
}

export interface SecondaryWindowRecord {
  guid: string
  relativePath: string
  createdAt: number
  isOpen: boolean
  tags: TagRecord[]
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
