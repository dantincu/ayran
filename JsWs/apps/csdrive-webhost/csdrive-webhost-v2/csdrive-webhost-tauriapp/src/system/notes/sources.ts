import { invoke } from '@tauri-apps/api/core'
import { invokeWithBytes } from '../../lib/ipcBytes'
import { joinRelative } from '../../lib/localFs'
import {
  type FileRoot,
  listRootDir,
  mkdirRoot,
  readRootFile,
  removeRootPath,
  renameRootPath,
  statRootPath,
  writeRootFile,
} from '../../lib/fileRoots'

/** The file manager works on *sources* — a folder on this device, or a Filen account (through its
 * cache, optionally inside a branch) — through one interface, so listing, opening, editing,
 * copying between them and the rest need no special cases. Paths are relative to the source's
 * root, `/`-separated, with none for the root itself (`''`). */

export interface Entry {
  name: string
  isDirectory: boolean
  size: number | null
  mtimeMs: number | null
  /** Filen: the file's content is in the cache (opening it needs no network). */
  cached?: boolean
  /** Filen, in a branch: `put` (written there) or `mkdir` (made there). */
  changed?: string | null
}

export interface DirListing {
  entries: Entry[]
  /** Filen: when the listing was fetched from the account (ms since 1970). */
  fetchedAt?: number
  /** Filen: it had expired but the account couldn't be reached, so it is shown as it was. */
  stale?: boolean
}

export interface FileSource {
  /** Stable across sessions — what a tab's resource id names (`local:user`, `filen:123`). */
  id: string
  /** `id` plus the branch: two sources with the same key work on the very same files. */
  viewKey: string
  kind: 'local' | 'filen'
  label: string
  /** `force` skips the cache (Filen only). */
  list(path: string, force?: boolean): Promise<DirListing>
  /** Size and modification time of an entry — for sources whose listing doesn't carry them. */
  stat?(path: string): Promise<{ size: number | null; mtimeMs: number | null }>
  read(path: string): Promise<Uint8Array>
  /** Creates or replaces the file; its folder must exist. */
  write(path: string, data: Uint8Array): Promise<void>
  mkdir(path: string): Promise<void>
  remove(path: string, isDirectory: boolean): Promise<void>
  rename(from: string, to: string): Promise<void>
}

function sortEntries(entries: Entry[]): Entry[] {
  return entries.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

export const LOCAL_PREFIX = 'local:'
export const FILEN_PREFIX = 'filen:'

/** A folder on this device: the user folder or one the person picked. */
export function localSource(root: FileRoot): FileSource {
  return {
    id: `${LOCAL_PREFIX}${root.id}`,
    viewKey: `${LOCAL_PREFIX}${root.id}`,
    kind: 'local',
    label: root.label,
    async list(path) {
      const entries = await listRootDir(root, path)
      return {
        entries: sortEntries(entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory, size: null, mtimeMs: null }))),
      }
    },
    async stat(path) {
      const info = await statRootPath(root, path)
      return { size: info.isDirectory ? null : info.size, mtimeMs: info.mtimeMs }
    },
    read: (path) => readRootFile(root, path),
    write: (path, data) => writeRootFile(root, path, data),
    mkdir: (path) => mkdirRoot(root, path),
    remove: (path, isDirectory) => removeRootPath(root, path, isDirectory),
    rename: (from, to) => renameRootPath(root, from, to),
  }
}

// ── Filen, through the cache (`files_cache.rs`) ───────────────────────────────

export interface FilenAccountInfo {
  userId: number
  email: string
}

export interface CacheInfo {
  userId: number
  email: string
  /** Seconds a cached listing/content stays valid; `null`: never expires (available offline). */
  ttlSecs: number | null
  folder: string
}

export interface BranchInfo {
  index: number
  name: string
  createdAt: number
  changes: number
}

export interface BranchChange {
  path: string
  kind: 'put' | 'mkdir' | 'delete'
  isNew: boolean
}

export interface CommitReport {
  committed: boolean
  applied: number
  conflicts: string[]
}

interface RawListing {
  entries: Entry[]
  fetchedAt: number
  stale: boolean
}

const filenPath = (path: string) => `/${path.replace(/^\/+/, '')}`

export const filenCache = {
  account: (userId: number) => invoke<CacheInfo>('filen_cache_account', { userId }),
  setInterval: (userId: number, ttlSecs: number | null) => invoke<void>('filen_cache_set_interval', { userId, ttlSecs }),
  clear: (userId: number) => invoke<void>('filen_cache_clear', { userId }),
  branches: (userId: number) => invoke<BranchInfo[]>('filen_cache_branches', { userId }),
  createBranch: (userId: number, name: string) => invoke<BranchInfo>('filen_cache_create_branch', { userId, name }),
  branchChanges: (userId: number, branch: number) => invoke<BranchChange[]>('filen_cache_branch_changes', { userId, branch }),
  commitBranch: (userId: number, branch: number, force: boolean) =>
    invoke<CommitReport>('filen_cache_commit_branch', { userId, branch, force }),
  discardBranch: (userId: number, branch: number) => invoke<void>('filen_cache_discard_branch', { userId, branch }),
}

/** A Filen account, seen through the cache; with `branch`, a branch of it (changes stay in the
 * branch until it is committed). */
export function filenSource(account: FilenAccountInfo, branch: number | null): FileSource {
  const { userId } = account
  const target = { userId, branch }
  return {
    id: `${FILEN_PREFIX}${userId}`,
    viewKey: `${FILEN_PREFIX}${userId}#${branch ?? ''}`,
    kind: 'filen',
    label: account.email,
    async list(path, force) {
      const listing = await invoke<RawListing>('filen_cache_list', { ...target, path: filenPath(path), force: !!force })
      return { entries: sortEntries(listing.entries), fetchedAt: listing.fetchedAt, stale: listing.stale }
    },
    async read(path) {
      return new Uint8Array(await invoke<ArrayBuffer>('filen_cache_read', { ...target, path: filenPath(path) }))
    },
    async write(path, data) {
      const fields: Record<string, string> = { userId: String(userId), path: filenPath(path) }
      if (branch !== null) fields.branch = String(branch)
      await invokeWithBytes('filen_cache_write', data, fields)
    },
    mkdir: (path) => invoke<void>('filen_cache_mkdir', { ...target, path: filenPath(path) }),
    remove: (path) => invoke<void>('filen_cache_rm', { ...target, path: filenPath(path) }),
    rename: (from, to) => invoke<void>('filen_cache_rename', { ...target, from: filenPath(from), to: filenPath(to) }),
  }
}

// ── Working across sources ────────────────────────────────────────────────────

/** Copies a file or folder (with everything in it) from one source to another — or to elsewhere in
 * the same one — by reading and writing, so it works between any two sources. */
export async function copyTree(
  from: FileSource,
  fromPath: string,
  isDirectory: boolean,
  to: FileSource,
  toPath: string,
): Promise<void> {
  if (isDirectory) {
    await to.mkdir(toPath)
    const { entries } = await from.list(fromPath)
    for (const child of entries) {
      await copyTree(from, joinRelative(fromPath, child.name), child.isDirectory, to, joinRelative(toPath, child.name))
    }
  } else {
    await to.write(toPath, await from.read(fromPath))
  }
}

/** `name` with " (2)", " (3)"… added until it isn't among `taken`. */
export function uniqueName(name: string, taken: Iterable<string>): string {
  const used = new Set(Array.from(taken, (n) => n.toLowerCase()))
  if (!used.has(name.toLowerCase())) return name
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let n = 2; ; n++) {
    const candidate = `${stem} (${n})${ext}`
    if (!used.has(candidate.toLowerCase())) return candidate
  }
}

/** Whether `candidate` is `ancestor` or below it. */
export function isSameOrWithin(ancestor: string, candidate: string): boolean {
  return candidate === ancestor || candidate.startsWith(`${ancestor}/`)
}

