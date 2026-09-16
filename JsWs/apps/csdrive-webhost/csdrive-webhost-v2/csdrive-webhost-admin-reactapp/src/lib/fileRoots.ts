import { readDir, readFile, readTextFile, writeFile, writeTextFile, mkdir, remove, rename, stat, exists, type DirEntry, type FileInfo } from '@tauri-apps/plugin-fs'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { appDataDir, join } from '@tauri-apps/api/path'
import { joinRelative, RESERVED_CONFIG_DIR } from './localFs'

/** A browsable filesystem root: either the app's own `user` folder, or an arbitrary
 * folder the user picked via the native folder picker. Everything below is addressed
 * by a path relative to `absolutePath`. */
export interface FileRoot {
  id: string
  label: string
  absolutePath: string
}

export const USER_ROOT_ID = 'user'

let cachedUserRoot: FileRoot | null = null

export async function getUserRoot(): Promise<FileRoot> {
  if (!cachedUserRoot) {
    const base = await appDataDir()
    const absolutePath = await join(base, 'user')
    cachedUserRoot = { id: USER_ROOT_ID, label: 'user', absolutePath }
  }
  return cachedUserRoot
}

/** Opens a native folder picker; the OS grants this app runtime read/write access to
 * whatever folder (and, recursively, its contents) the user selects. Returns null if
 * the user cancels. */
export async function pickNewRoot(): Promise<FileRoot | null> {
  const selected = await openDialog({ directory: true, recursive: true, title: 'Choose a folder to browse' })
  if (!selected || Array.isArray(selected)) return null

  const trimmed = selected.replace(/[\\/]+$/, '')
  const label = trimmed.split(/[\\/]/).filter(Boolean).pop() || trimmed
  const id = `ext:${trimmed}`
  return { id, label, absolutePath: trimmed }
}

function toAbsolute(root: FileRoot, relativePath: string): Promise<string> {
  const trimmed = relativePath.replace(/^\/+/, '')
  return trimmed ? join(root.absolutePath, ...trimmed.split('/')) : Promise.resolve(root.absolutePath)
}

export async function listRootDir(root: FileRoot, relativePath: string): Promise<DirEntry[]> {
  const entries = await readDir(await toAbsolute(root, relativePath))
  return entries
    .filter((e) => !(root.id === USER_ROOT_ID && relativePath === '' && e.name === RESERVED_CONFIG_DIR))
    .sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
      return a.name.localeCompare(b.name)
    })
}

export async function statRootPath(root: FileRoot, relativePath: string): Promise<FileInfo> {
  return stat(await toAbsolute(root, relativePath))
}

export async function rootPathExists(root: FileRoot, relativePath: string): Promise<boolean> {
  return exists(await toAbsolute(root, relativePath))
}

export async function readRootTextFile(root: FileRoot, relativePath: string): Promise<string> {
  return readTextFile(await toAbsolute(root, relativePath))
}

export async function writeRootTextFile(root: FileRoot, relativePath: string, content: string): Promise<void> {
  return writeTextFile(await toAbsolute(root, relativePath), content)
}

export async function readRootFile(root: FileRoot, relativePath: string): Promise<Uint8Array> {
  return readFile(await toAbsolute(root, relativePath))
}

export async function writeRootFile(root: FileRoot, relativePath: string, data: Uint8Array): Promise<void> {
  return writeFile(await toAbsolute(root, relativePath), data)
}

export async function mkdirRoot(root: FileRoot, relativePath: string): Promise<void> {
  return mkdir(await toAbsolute(root, relativePath), { recursive: true })
}

export async function removeRootPath(root: FileRoot, relativePath: string, recursive: boolean): Promise<void> {
  return remove(await toAbsolute(root, relativePath), { recursive })
}

export async function renameRootPath(root: FileRoot, fromRelative: string, toRelative: string): Promise<void> {
  return rename(await toAbsolute(root, fromRelative), await toAbsolute(root, toRelative))
}

/** Recursively copies a file or folder to a new location within the same root. */
export async function copyRootPath(root: FileRoot, fromRelative: string, toRelative: string): Promise<void> {
  const info = await statRootPath(root, fromRelative)
  if (info.isDirectory) {
    await mkdirRoot(root, toRelative)
    const children = await listRootDir(root, fromRelative)
    for (const child of children) {
      await copyRootPath(root, joinRelative(fromRelative, child.name), joinRelative(toRelative, child.name))
    }
  } else {
    const data = await readRootFile(root, fromRelative)
    await writeRootFile(root, toRelative, data)
  }
}

/** Appends " (2)", " (3)", etc. to `name` until it no longer collides with something in `dirRelative`. */
export async function uniqueRootName(root: FileRoot, dirRelative: string, name: string): Promise<string> {
  if (!(await rootPathExists(root, joinRelative(dirRelative, name)))) return name

  const dotIndex = name.lastIndexOf('.')
  const stem = dotIndex > 0 ? name.slice(0, dotIndex) : name
  const ext = dotIndex > 0 ? name.slice(dotIndex) : ''

  let counter = 2
  let candidate = `${stem} (${counter})${ext}`
  while (await rootPathExists(root, joinRelative(dirRelative, candidate))) {
    counter++
    candidate = `${stem} (${counter})${ext}`
  }
  return candidate
}

export type { DirEntry, FileInfo }
