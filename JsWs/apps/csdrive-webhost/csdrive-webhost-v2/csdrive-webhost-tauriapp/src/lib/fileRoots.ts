import { copyFile, readDir, readDirDetailed, readFile, writeFile, uploadFile, mkdir, remove, rename, stat, exists, rootRealPath, type DirEntry, type DirEntryDetailed, type FileInfo } from './fs'
import { joinRelative } from './localFs'
import { listPickedRoots, pickFolder, removePickedRoot, type PickedRoot } from './pickedRoots'

/** A browsable filesystem root: either the app's own `user` folder, or a folder the user picked with
 * a native folder picker (the OS dialog on desktop, ours on Android). Everything below is addressed
 * by a path relative to the root, through the backend's file commands, which are told the root by
 * its `id`. Nothing here knows where the folder really is. */
export interface FileRoot {
  /** `user`, or the opaque id of a picked folder. */
  id: string
  label: string
}

/** What a folder listing tells about one entry. */
export type RootEntry = DirEntry & { size?: number }

export const USER_ROOT_ID = 'user'

const USER_ROOT: FileRoot = { id: USER_ROOT_ID, label: 'user' }

export async function getUserRoot(): Promise<FileRoot> {
  return USER_ROOT
}

function toFileRoot(picked: PickedRoot): FileRoot {
  return { id: picked.id, label: picked.label }
}

/** The folders picked in earlier sessions (the backend remembers them and allows them again at startup). */
export async function loadSavedRoots(): Promise<FileRoot[]> {
  return (await listPickedRoots()).map(toFileRoot)
}

/** Opens a native folder picker (the OS dialog on desktop, ours on Android); the backend then allows
 * the app to read and write whatever folder — and, recursively, its contents — the user selects, and
 * remembers it. Returns null if the user cancels. */
export async function pickNewRoot(): Promise<FileRoot | null> {
  const picked = await pickFolder()
  return picked ? toFileRoot(picked) : null
}

/** Stops browsing a root and forgets it: the backend takes it out of what the app may use, at once.
 * Nothing inside the folder is touched. (The user folder can't be forgotten.) */
export async function forgetRoot(root: FileRoot): Promise<void> {
  if (root.id !== USER_ROOT_ID) await removePickedRoot(root.id)
}

/** Where the root really is, for showing the person. **Admin-app only** — anywhere else this fails,
 * and callers fall back to the label. */
export async function realPathOf(root: FileRoot): Promise<string | null> {
  try {
    return await rootRealPath(root.id)
  } catch {
    return null
  }
}

const relative = (path: string) => path.replace(/^\/+/, '')

export async function listRootDir(root: FileRoot, relativePath: string): Promise<RootEntry[]> {
  const entries: RootEntry[] = await readDir(root.id, relative(relativePath))
  return entries.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

/** The folder's entries with size and dates (created, modified) — one call for the folder, for searching and sorting. Unsorted. */
export async function listRootDirDetailed(root: FileRoot, relativePath: string): Promise<DirEntryDetailed[]> {
  return readDirDetailed(root.id, relative(relativePath))
}

export async function statRootPath(root: FileRoot, relativePath: string): Promise<FileInfo> {
  return stat(root.id, relative(relativePath))
}

export async function rootPathExists(root: FileRoot, relativePath: string): Promise<boolean> {
  return exists(root.id, relative(relativePath))
}

export async function readRootTextFile(root: FileRoot, relativePath: string): Promise<string> {
  return new TextDecoder().decode(await readRootFile(root, relativePath))
}

export async function writeRootTextFile(root: FileRoot, relativePath: string, content: string): Promise<void> {
  return writeRootFile(root, relativePath, new TextEncoder().encode(content))
}

export async function readRootFile(root: FileRoot, relativePath: string): Promise<Uint8Array> {
  return readFile(root.id, relative(relativePath))
}

export async function writeRootFile(root: FileRoot, relativePath: string, data: Uint8Array): Promise<void> {
  return writeFile(root.id, relative(relativePath), data)
}

/** Puts a `File` from the device's file chooser into the root, in pieces (see `uploadFile`). */
export async function writeRootFileFrom(root: FileRoot, relativePath: string, file: File): Promise<void> {
  return uploadFile(root.id, relative(relativePath), file)
}

export async function mkdirRoot(root: FileRoot, relativePath: string): Promise<void> {
  return mkdir(root.id, relative(relativePath), { recursive: true })
}

export async function removeRootPath(root: FileRoot, relativePath: string, recursive: boolean): Promise<void> {
  return remove(root.id, relative(relativePath), { recursive })
}

export async function renameRootPath(root: FileRoot, fromRelative: string, toRelative: string): Promise<void> {
  return rename(root.id, relative(fromRelative), relative(toRelative))
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
    await copyFile(root.id, relative(fromRelative), root.id, relative(toRelative))
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
