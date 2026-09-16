import {
  BaseDirectory,
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
} from '@tauri-apps/plugin-fs'
import { appDataDir, join } from '@tauri-apps/api/path'

/** Everything under the app data dir's `user` folder is what the frontend is allowed to touch. */
export const USER_ROOT = 'user'
/** Reserved folder for this app's own metadata (Filen account index, etc.) — hidden from the file manager UI. */
export const RESERVED_CONFIG_DIR = '.csdrive-config'

let cachedAppDataDir: string | null = null

async function getAppDataDir(): Promise<string> {
  if (!cachedAppDataDir) {
    cachedAppDataDir = await appDataDir()
  }
  return cachedAppDataDir
}

function userRelPath(relativePath: string): string {
  const trimmed = relativePath.replace(/^\/+/, '')
  return trimmed ? `${USER_ROOT}/${trimmed}` : USER_ROOT
}

/** Absolute filesystem path for a path relative to the user folder. Used by the sql plugin, which needs a real path. */
export async function userAbsolutePath(relativePath: string): Promise<string> {
  const base = await getAppDataDir()
  const trimmed = relativePath.replace(/^\/+/, '')
  return trimmed ? join(base, USER_ROOT, ...trimmed.split('/')) : join(base, USER_ROOT)
}

export async function listUserDir(relativePath: string): Promise<DirEntry[]> {
  const entries = await readDir(userRelPath(relativePath), { baseDir: BaseDirectory.AppData })
  return entries
    .filter((e) => !(relativePath === '' && e.name === RESERVED_CONFIG_DIR))
    .sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
      return a.name.localeCompare(b.name)
    })
}

export async function statUserPath(relativePath: string): Promise<FileInfo> {
  return stat(userRelPath(relativePath), { baseDir: BaseDirectory.AppData })
}

export async function userPathExists(relativePath: string): Promise<boolean> {
  return exists(userRelPath(relativePath), { baseDir: BaseDirectory.AppData })
}

export async function readUserTextFile(relativePath: string): Promise<string> {
  return readTextFile(userRelPath(relativePath), { baseDir: BaseDirectory.AppData })
}

export async function writeUserTextFile(relativePath: string, content: string): Promise<void> {
  return writeTextFile(userRelPath(relativePath), content, { baseDir: BaseDirectory.AppData })
}

export async function readUserFile(relativePath: string): Promise<Uint8Array> {
  return readFile(userRelPath(relativePath), { baseDir: BaseDirectory.AppData })
}

export async function writeUserFile(relativePath: string, data: Uint8Array): Promise<void> {
  return writeFile(userRelPath(relativePath), data, { baseDir: BaseDirectory.AppData })
}

export async function mkdirUser(relativePath: string): Promise<void> {
  return mkdir(userRelPath(relativePath), { baseDir: BaseDirectory.AppData, recursive: true })
}

export async function removeUserPath(relativePath: string, recursive: boolean): Promise<void> {
  return remove(userRelPath(relativePath), { baseDir: BaseDirectory.AppData, recursive })
}

export async function renameUserPath(fromRelative: string, toRelative: string): Promise<void> {
  return rename(userRelPath(fromRelative), userRelPath(toRelative), {
    oldPathBaseDir: BaseDirectory.AppData,
    newPathBaseDir: BaseDirectory.AppData,
  })
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
