import { invoke } from '@tauri-apps/api/core'
import { invokeWithBytes } from './ipcBytes'

/** Thin wrappers around the backend's `filen_*` commands. Everything Filen — login,
 * session keys, encryption, network — happens in Rust (`src/filen/` in the tauri
 * crate); this window only ever sees account ids/emails and file metadata/contents.
 * Paths are absolute Filen paths (`/`, `/Folder/file.txt`). User-provided web apps
 * call the same commands (except login/logout, which only this window may). */

export interface FilenAccount {
  userId: number
  email: string
}

export interface FilenEntry {
  /** Filen's own id for the file or folder (its uuid). */
  id: string
  name: string
  isDirectory: boolean
  size: number | null
  mtimeMs: number | null
}

export async function listFilenAccounts(): Promise<FilenAccount[]> {
  return invoke<FilenAccount[]>('filen_list_accounts')
}

export async function loginFilen(params: { email: string; password: string; twoFactorCode?: string }): Promise<FilenAccount> {
  return invoke<FilenAccount>('filen_login', {
    email: params.email,
    password: params.password,
    twoFactorCode: params.twoFactorCode || null,
  })
}

export async function logoutFilen(userId: number): Promise<void> {
  await invoke('filen_logout', { userId })
}

export async function filenReaddir(userId: number, path: string): Promise<FilenEntry[]> {
  return invoke<FilenEntry[]>('filen_readdir', { userId, path })
}

export async function filenStat(userId: number, path: string): Promise<FilenEntry> {
  return invoke<FilenEntry>('filen_stat', { userId, path })
}

export async function filenReadFile(userId: number, path: string): Promise<Uint8Array> {
  return new Uint8Array(await invoke<ArrayBuffer>('filen_read_file', { userId, path }))
}

/** Creates the file, or replaces it if it exists. Its folder must already exist. */
export async function filenWriteFile(userId: number, path: string, data: Uint8Array): Promise<void> {
  await invokeWithBytes('filen_write_file', data, { userId: String(userId), path })
}

/** Creates the folder and any missing folders above it. */
export async function filenMkdir(userId: number, path: string): Promise<void> {
  await invoke('filen_mkdir', { userId, path })
}

/** Moves a file or folder to Filen's trash. */
export async function filenRm(userId: number, path: string): Promise<void> {
  await invoke('filen_rm', { userId, path })
}

/** Renames and/or moves a file or folder. */
export async function filenRename(userId: number, from: string, to: string): Promise<void> {
  await invoke('filen_rename', { userId, from, to })
}
