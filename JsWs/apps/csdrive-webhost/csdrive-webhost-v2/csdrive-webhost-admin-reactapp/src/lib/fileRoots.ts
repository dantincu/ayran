import { readDir, readFile, readTextFile, writeFile, writeTextFile, mkdir, remove, rename, stat, exists } from '@tauri-apps/plugin-fs'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { join } from '@tauri-apps/api/path'
import { getUserFolder, joinRelative } from './localFs'
import {
  deviceExists,
  deviceMkdir,
  deviceReaddir,
  deviceReadFile,
  deviceRename,
  deviceRm,
  deviceStat,
  deviceWriteFile,
  listDeviceRoots,
  pickDeviceRoot,
  removeDeviceRoot,
  type DeviceRoot,
} from './deviceRoots'
import { isMobile } from './platform'

/** A browsable filesystem root. Three kinds, all addressed by a path relative to the root:
 * - `local`: the app's own `user` folder, or (desktop) a folder picked with the native dialog
 *   — real paths, reached through the fs plugin;
 * - `device`: (Android) a folder picked with Android's folder picker — reached through the
 *   backend's `device_*` commands, because it's a content URI, not a path. Remembered
 *   across restarts. */
export interface FileRoot {
  id: string
  label: string
  /** Where a `local` root lives on disk; empty for `device` roots. */
  absolutePath: string
  kind: 'local' | 'device'
}

/** What a folder listing tells about one entry; `size` is there when it comes free with the listing. */
export interface RootEntry {
  name: string
  isDirectory: boolean
  isFile: boolean
  isSymlink: boolean
  size?: number
}

export interface RootStat {
  isDirectory: boolean
  isFile: boolean
  size: number
}

export const USER_ROOT_ID = 'user'

const DEVICE_ID_PREFIX = 'device:'

let cachedUserRoot: FileRoot | null = null

export async function getUserRoot(): Promise<FileRoot> {
  if (!cachedUserRoot) {
    cachedUserRoot = { id: USER_ROOT_ID, label: 'user', absolutePath: await getUserFolder(), kind: 'local' }
  }
  return cachedUserRoot
}

function toFileRoot(device: DeviceRoot): FileRoot {
  return { id: `${DEVICE_ID_PREFIX}${device.id}`, label: device.label, absolutePath: '', kind: 'device' }
}

/** The device folders remembered from earlier sessions (none outside Android). */
export async function loadDeviceRoots(): Promise<FileRoot[]> {
  return (await listDeviceRoots()).map(toFileRoot)
}

/** The id the backend knows a device root by. */
function deviceId(root: FileRoot): string {
  return root.id.slice(DEVICE_ID_PREFIX.length)
}

/** Opens the platform's native folder picker. Desktop: the OS grants this app runtime
 * read/write access to whatever folder (and, recursively, its contents) the user selects;
 * the root lasts for the session. Android: the folder is remembered across restarts. Returns
 * null if the user cancels. */
export async function pickNewRoot(): Promise<FileRoot | null> {
  if (isMobile) {
    const picked = await pickDeviceRoot()
    return picked ? toFileRoot(picked) : null
  }

  const selected = await openDialog({ directory: true, recursive: true, title: 'Choose a folder to browse' })
  if (!selected || Array.isArray(selected)) return null

  const trimmed = selected.replace(/[\\/]+$/, '')
  const label = trimmed.split(/[\\/]/).filter(Boolean).pop() || trimmed
  return { id: `ext:${trimmed}`, label, absolutePath: trimmed, kind: 'local' }
}

/** Stops browsing a root. A device folder is also forgotten by the backend (and Android's
 * access to it given back); nothing inside any folder is touched. */
export async function forgetRoot(root: FileRoot): Promise<void> {
  if (root.kind === 'device') await removeDeviceRoot(deviceId(root))
}

function toAbsolute(root: FileRoot, relativePath: string): Promise<string> {
  const trimmed = relativePath.replace(/^\/+/, '')
  return trimmed ? join(root.absolutePath, ...trimmed.split('/')) : Promise.resolve(root.absolutePath)
}

function relative(relativePath: string): string {
  return relativePath.replace(/^\/+/, '')
}

export async function listRootDir(root: FileRoot, relativePath: string): Promise<RootEntry[]> {
  const entries: RootEntry[] =
    root.kind === 'device'
      ? (await deviceReaddir(deviceId(root), relative(relativePath))).map((e) => ({
          name: e.name,
          isDirectory: e.isDirectory,
          isFile: !e.isDirectory,
          isSymlink: false,
          size: e.size ?? undefined,
        }))
      : await readDir(await toAbsolute(root, relativePath))
  return entries.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

export async function statRootPath(root: FileRoot, relativePath: string): Promise<RootStat> {
  if (root.kind === 'device') {
    const info = await deviceStat(deviceId(root), relative(relativePath))
    return { isDirectory: info.isDirectory, isFile: !info.isDirectory, size: info.size ?? 0 }
  }
  return stat(await toAbsolute(root, relativePath))
}

export async function rootPathExists(root: FileRoot, relativePath: string): Promise<boolean> {
  if (root.kind === 'device') return deviceExists(deviceId(root), relative(relativePath))
  return exists(await toAbsolute(root, relativePath))
}

export async function readRootTextFile(root: FileRoot, relativePath: string): Promise<string> {
  if (root.kind === 'device') return new TextDecoder().decode(await readRootFile(root, relativePath))
  return readTextFile(await toAbsolute(root, relativePath))
}

export async function writeRootTextFile(root: FileRoot, relativePath: string, content: string): Promise<void> {
  if (root.kind === 'device') return writeRootFile(root, relativePath, new TextEncoder().encode(content))
  return writeTextFile(await toAbsolute(root, relativePath), content)
}

export async function readRootFile(root: FileRoot, relativePath: string): Promise<Uint8Array> {
  if (root.kind === 'device') return deviceReadFile(deviceId(root), relative(relativePath))
  return readFile(await toAbsolute(root, relativePath))
}

export async function writeRootFile(root: FileRoot, relativePath: string, data: Uint8Array): Promise<void> {
  if (root.kind === 'device') return deviceWriteFile(deviceId(root), relative(relativePath), data)
  return writeFile(await toAbsolute(root, relativePath), data)
}

export async function mkdirRoot(root: FileRoot, relativePath: string): Promise<void> {
  if (root.kind === 'device') return deviceMkdir(deviceId(root), relative(relativePath))
  return mkdir(await toAbsolute(root, relativePath), { recursive: true })
}

export async function removeRootPath(root: FileRoot, relativePath: string, recursive: boolean): Promise<void> {
  if (root.kind === 'device') return deviceRm(deviceId(root), relative(relativePath))
  return remove(await toAbsolute(root, relativePath), { recursive })
}

export async function renameRootPath(root: FileRoot, fromRelative: string, toRelative: string): Promise<void> {
  if (root.kind === 'device') return deviceRename(deviceId(root), relative(fromRelative), relative(toRelative))
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
