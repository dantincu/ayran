import { invoke } from '@tauri-apps/api/core'
import { invokeWithBytes } from './ipcBytes'

/** The file commands (`fs_commands.rs`), with the shapes of the fs plugin they replaced. Every call
 * names a **root** — `user` for the user folder, or the id of a folder the person picked — and a
 * `path` *relative* to it (`/`-separated, `''` for the root itself). The backend judges it with its
 * own scope (`fs_scope.rs`) — the user folder and the folders the person picked, nothing else — so
 * an out-of-scope path is an error, not a silent no-op. A window never learns a real path. */

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

export function readDir(root: string, path: string): Promise<DirEntry[]> {
  return invoke<DirEntry[]>('fs_read_dir', { root, path })
}

/** An entry of a folder with its size and dates, all in one call (see `readDirDetailed`). */
export interface DirEntryDetailed extends DirEntry {
  /** A file's size; `null` for a folder. */
  size: number | null
  mtimeMs: number | null
  /** When it was created, where the platform keeps that. */
  createdMs: number | null
}

/** The entries of a folder with their sizes and dates, in one call for the whole folder — what searching and sorting a listing need. */
export function readDirDetailed(root: string, path: string): Promise<DirEntryDetailed[]> {
  return invoke<DirEntryDetailed[]>('fs_read_dir_detailed', { root, path })
}

export function stat(root: string, path: string): Promise<FileInfo> {
  return invoke<FileInfo>('fs_stat', { root, path })
}

export function exists(root: string, path: string): Promise<boolean> {
  return invoke<boolean>('fs_exists', { root, path })
}

export async function readFile(root: string, path: string): Promise<Uint8Array> {
  return new Uint8Array(await invoke<ArrayBuffer>('fs_read_file', { root, path }))
}

export async function readTextFile(root: string, path: string): Promise<string> {
  return new TextDecoder().decode(await readFile(root, path))
}

/** Creates or replaces the file; its folder must exist (see `mkdir`). */
export async function writeFile(root: string, path: string, data: Uint8Array): Promise<void> {
  await invokeWithBytes('fs_write_file', data, { root, path })
}

export function writeTextFile(root: string, path: string, content: string): Promise<void> {
  return writeFile(root, path, new TextEncoder().encode(content))
}

export async function mkdir(root: string, path: string, options?: { recursive?: boolean }): Promise<void> {
  await invoke('fs_mkdir', { root, path, recursive: options?.recursive ?? false })
}

/** Deletes a file, a link (never what it points to) or a folder — with its contents only if `recursive`. */
export async function remove(root: string, path: string, options?: { recursive?: boolean }): Promise<void> {
  await invoke('fs_remove', { root, path, recursive: options?.recursive ?? false })
}

/** Renames or moves an entry within a root. */
export async function rename(root: string, from: string, to: string): Promise<void> {
  await invoke('fs_rename', { root, from, to })
}

/** Copies a file — within a root or into another — on the backend's side, never through the page. */
export async function copyFile(fromRoot: string, from: string, toRoot: string, to: string): Promise<void> {
  await invoke('fs_copy', { fromRoot, from, toRoot, to })
}

/** How big a piece of a file is read and sent at a time. */
const UPLOAD_PIECE = 4 * 1024 * 1024

/** Puts a `File` from the device's file chooser at `path` inside `root` (creating or replacing it; its
 * folder must exist), sending it in pieces so a big one is never held whole — in the page or in the
 * backend. The file appears only when the last piece is in. */
export async function uploadFile(root: string, path: string, file: File): Promise<void> {
  const id = await invoke<string>('fs_upload_begin', { root, path })
  try {
    for (let at = 0; at < file.size; at += UPLOAD_PIECE) {
      const piece = new Uint8Array(await file.slice(at, at + UPLOAD_PIECE).arrayBuffer())
      await invokeWithBytes('fs_upload_chunk', piece, { id })
    }
    await invoke('fs_upload_finish', { id })
  } catch (e) {
    await invoke('fs_upload_abort', { id }).catch(() => {})
    throw e
  }
}

/** Where a root really is. **Only the admin-app may ask** (to show the person which folder it is);
 * every other window is refused — web apps never see a real path. */
export function rootRealPath(root: string): Promise<string> {
  return invoke<string>('fs_root_path', { root })
}
