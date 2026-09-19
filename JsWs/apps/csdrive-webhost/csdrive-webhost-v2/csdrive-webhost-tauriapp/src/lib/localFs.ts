import { invoke } from '@tauri-apps/api/core'
import { join } from '@tauri-apps/api/path'
import {
  readDir,
  readFile,
  readTextFile,
  writeFile,
  writeTextFile,
  mkdir,
  remove,
  rename,
  stat,
  exists,
  type DirEntry,
  type FileInfo,
} from './fs'

let cachedUserFolder: string | null = null

/** Absolute path of the user folder, as the backend has it (which follows the data
 * folder's location — default, or relocated from the Settings tab). */
export async function getUserFolder(): Promise<string> {
  if (!cachedUserFolder) {
    cachedUserFolder = await invoke<string>('get_user_folder')
  }
  return cachedUserFolder
}

/** Absolute filesystem path for a path relative to the user folder. */
export async function userAbsolutePath(relativePath: string): Promise<string> {
  const base = await getUserFolder()
  const trimmed = relativePath.replace(/^\/+/, '')
  return trimmed ? join(base, ...trimmed.split('/')) : base
}

export async function listUserDir(relativePath: string): Promise<DirEntry[]> {
  const entries = await readDir(await userAbsolutePath(relativePath))
  return entries
    .sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
      return a.name.localeCompare(b.name)
    })
}

export async function statUserPath(relativePath: string): Promise<FileInfo> {
  return stat(await userAbsolutePath(relativePath))
}

export async function userPathExists(relativePath: string): Promise<boolean> {
  return exists(await userAbsolutePath(relativePath))
}

export async function readUserTextFile(relativePath: string): Promise<string> {
  return readTextFile(await userAbsolutePath(relativePath))
}

export async function writeUserTextFile(relativePath: string, content: string): Promise<void> {
  return writeTextFile(await userAbsolutePath(relativePath), content)
}

export async function readUserFile(relativePath: string): Promise<Uint8Array> {
  return readFile(await userAbsolutePath(relativePath))
}

export async function writeUserFile(relativePath: string, data: Uint8Array): Promise<void> {
  return writeFile(await userAbsolutePath(relativePath), data)
}

export async function mkdirUser(relativePath: string): Promise<void> {
  return mkdir(await userAbsolutePath(relativePath), { recursive: true })
}

export async function removeUserPath(relativePath: string, recursive: boolean): Promise<void> {
  return remove(await userAbsolutePath(relativePath), { recursive })
}

export async function renameUserPath(fromRelative: string, toRelative: string): Promise<void> {
  return rename(await userAbsolutePath(fromRelative), await userAbsolutePath(toRelative))
}

export function joinRelative(...segments: string[]): string {
  return segments
    .map((s) => s.replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/')
}

/** Recursively copies a file or folder to a new location within the user folder. */
export async function copyUserPath(fromRelative: string, toRelative: string): Promise<void> {
  const info = await statUserPath(fromRelative)
  if (info.isDirectory) {
    await mkdirUser(toRelative)
    const children = await listUserDir(fromRelative)
    for (const child of children) {
      await copyUserPath(joinRelative(fromRelative, child.name), joinRelative(toRelative, child.name))
    }
  } else {
    const data = await readUserFile(fromRelative)
    await writeUserFile(toRelative, data)
  }
}

/** Appends " (2)", " (3)", etc. to `name` until it no longer collides with something in `dirRelative`. */
export async function uniqueUserName(dirRelative: string, name: string): Promise<string> {
  if (!(await userPathExists(joinRelative(dirRelative, name)))) return name

  const dotIndex = name.lastIndexOf('.')
  const stem = dotIndex > 0 ? name.slice(0, dotIndex) : name
  const ext = dotIndex > 0 ? name.slice(dotIndex) : ''

  let counter = 2
  let candidate = `${stem} (${counter})${ext}`
  while (await userPathExists(joinRelative(dirRelative, candidate))) {
    counter++
    candidate = `${stem} (${counter})${ext}`
  }
  return candidate
}

export type { DirEntry, FileInfo }
