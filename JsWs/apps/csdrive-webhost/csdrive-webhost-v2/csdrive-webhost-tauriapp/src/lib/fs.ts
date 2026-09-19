import { invoke } from '@tauri-apps/api/core'
import { invokeWithBytes } from './ipcBytes'

/** The file commands (`fs_commands.rs`), with the shapes of the fs plugin they replaced. Every path
 * is absolute and is judged by the backend's own scope (`fs_scope.rs`) — the user folder and the
 * folders the person picked, nothing else — so an out-of-scope path is an error, not a silent no-op. */

export interface DirEntry {
  name: string
  isDirectory: boolean
  isFile: boolean
  isSymlink: boolean
}

export interface FileInfo {
  isFile: boolean
  isDirectory: boolean
  isSymlink: boolean
  size: number
  /** Last modified, in milliseconds since 1970. */
  mtimeMs: number | null
}

export function readDir(path: string): Promise<DirEntry[]> {
  return invoke<DirEntry[]>('fs_read_dir', { path })
}

export function stat(path: string): Promise<FileInfo> {
  return invoke<FileInfo>('fs_stat', { path })
}

export function exists(path: string): Promise<boolean> {
  return invoke<boolean>('fs_exists', { path })
}

export async function readFile(path: string): Promise<Uint8Array> {
  return new Uint8Array(await invoke<ArrayBuffer>('fs_read_file', { path }))
}

export async function readTextFile(path: string): Promise<string> {
  return new TextDecoder().decode(await readFile(path))
}

/** Creates or replaces the file; its folder must exist (see `mkdir`). */
export async function writeFile(path: string, data: Uint8Array): Promise<void> {
  await invokeWithBytes('fs_write_file', data, { path })
}

export function writeTextFile(path: string, content: string): Promise<void> {
  return writeFile(path, new TextEncoder().encode(content))
}

export async function mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
  await invoke('fs_mkdir', { path, recursive: options?.recursive ?? false })
}

/** Deletes a file, a link (never what it points to) or a folder — with its contents only if `recursive`. */
export async function remove(path: string, options?: { recursive?: boolean }): Promise<void> {
  await invoke('fs_remove', { path, recursive: options?.recursive ?? false })
}

export async function rename(from: string, to: string): Promise<void> {
  await invoke('fs_rename', { from, to })
}
