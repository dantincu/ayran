import { invoke } from '@tauri-apps/api/core'
import { invokeWithBytes } from './ipcBytes'

/** Thin wrappers around the backend's `device_*` commands (see `device_roots.rs`):
 * folders picked with Android's native folder picker, addressed by a root id plus a path
 * relative to that root. Android only — on desktop `listDeviceRoots` is always empty and
 * the rest fail, because folders are picked with the dialog + fs plugins there. */

export interface DeviceRoot {
  id: string
  label: string
}

export interface DeviceEntry {
  name: string
  isDirectory: boolean
  size: number | null
  mtimeMs: number | null
}

/** Opens the native folder picker; resolves to the folder (remembered across restarts)
 * or null if the user cancelled. */
export function pickDeviceRoot(): Promise<DeviceRoot | null> {
  return invoke<DeviceRoot | null>('pick_device_root')
}

export function listDeviceRoots(): Promise<DeviceRoot[]> {
  return invoke<DeviceRoot[]>('list_device_roots')
}

/** Forgets the folder and gives Android its access permission back; nothing inside is touched. */
export async function removeDeviceRoot(rootId: string): Promise<void> {
  await invoke('remove_device_root', { rootId })
}

export function deviceReaddir(rootId: string, path: string): Promise<DeviceEntry[]> {
  return invoke<DeviceEntry[]>('device_readdir', { rootId, path })
}

export function deviceStat(rootId: string, path: string): Promise<DeviceEntry> {
  return invoke<DeviceEntry>('device_stat', { rootId, path })
}

export function deviceExists(rootId: string, path: string): Promise<boolean> {
  return invoke<boolean>('device_exists', { rootId, path })
}

export async function deviceReadFile(rootId: string, path: string): Promise<Uint8Array> {
  return new Uint8Array(await invoke<ArrayBuffer>('device_read_file', { rootId, path }))
}

/** Creates or replaces a file (missing parent folders are created). */
export async function deviceWriteFile(rootId: string, path: string, data: Uint8Array): Promise<void> {
  await invokeWithBytes('device_write_file', data, { rootId, path })
}

export async function deviceMkdir(rootId: string, path: string): Promise<void> {
  await invoke('device_mkdir', { rootId, path })
}

/** Deletes a file, or a folder and everything in it. Permanent — there is no trash. */
export async function deviceRm(rootId: string, path: string): Promise<void> {
  await invoke('device_rm', { rootId, path })
}

/** Renames or moves within the root; never overwrites. */
export async function deviceRename(rootId: string, from: string, to: string): Promise<void> {
  await invoke('device_rename', { rootId, from, to })
}
