import { readDir, writeFile, type DirEntry } from './fs'

/** The user folder — the root named `user` — through the file commands (see `fs.ts`); paths are
 * relative to it. */
const USER = 'user'

export async function listUserDir(relativePath: string): Promise<DirEntry[]> {
  const entries = await readDir(USER, relativePath.replace(/^\/+/, ''))
  return entries.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

export async function writeUserFile(relativePath: string, data: Uint8Array): Promise<void> {
  return writeFile(USER, relativePath.replace(/^\/+/, ''), data)
}

export function joinRelative(...segments: string[]): string {
  return segments
    .map((s) => s.replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/')
}
