import { invoke } from '@tauri-apps/api/core'
import { invokeWithBytes } from '../../lib/ipcBytes'
import { copyFile } from '../../lib/fs'
import { openFileAsWebApp } from '../../lib/secondaryWindows'
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
  writeRootFileFrom,
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
  /** Filen: the file is locked against caching — its cached copy is never refreshed, expired or cleared. */
  locked?: boolean
  /** Filen, in a branch: `put` (written there), `mkdir` (made there) or `checkout` (taken into the
   * branch without being changed). */
  changed?: string | null
}

/** Which version of a Filen file someone has been working on: whether it existed, and its size and
 * modification time. */
export interface FileVersion {
  exists: boolean
  size: number | null
  mtimeMs: number | null
}

/** What asking Filen itself about a file found. */
export interface VersionCheck {
  /** Filen has the very version that was being worked on. */
  upToDate: boolean
  /** When it hasn't: what happened to it, in words. */
  problem: string | null
  /** How Filen has the file now. */
  current: FileVersion
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
  /** Filen: the branch this works in, or `null` for the account itself. */
  branch?: number | null
  /** `force` skips the cache (Filen only). */
  list(path: string, force?: boolean): Promise<DirListing>
  /** Size and modification time of an entry — for sources whose listing doesn't carry them. */
  stat?(path: string): Promise<{ size: number | null; mtimeMs: number | null }>
  read(path: string): Promise<Uint8Array>
  /** Creates or replaces the file; its folder must exist. */
  write(path: string, data: Uint8Array): Promise<void>
  /** Copies a `File` from the device's file chooser in, sent on piece by piece so a big one is never
   * held whole. Without it, the caller reads the file and uses `write`. */
  writeFromFile?(path: string, file: File): Promise<void>
  /** Hands the file to the device (see `exportPathToDevice`) — copied on the Rust side, never through
   * the page. Resolves to the name it was saved as. */
  exportFile(path: string, name: string, token: string | null): Promise<string>
  /** A folder on this device: the root id the file commands know it by. */
  rootId?: string
  /** Filen: takes a file from a folder on this device (`root` and `source`, as the file commands
   * name them) without it passing through the page. */
  copyFromLocal?(path: string, root: string, source: string): Promise<void>
  /** Filen: puts a file at `dest` inside a folder on this device, likewise. */
  copyToLocal?(path: string, root: string, dest: string): Promise<void>
  mkdir(path: string): Promise<void>
  remove(path: string, isDirectory: boolean): Promise<void>
  rename(from: string, to: string): Promise<void>

  /** Opens the html or markdown file as a web app (a window of its own, listed under this Notes tab). */
  openAsWebApp?(path: string): Promise<void>

  // Filen only ────────────────────────────────────────────────────────────────
  /** The version of the file as the cache knows it — call it right after opening the file, to know what
   * is being worked on. */
  version?(path: string): Promise<FileVersion>
  /** Asks Filen itself (never the cache) whether the file is still at `base`. */
  checkVersion?(path: string, base: FileVersion): Promise<VersionCheck>
  /** In a branch: bases the file's change on what Filen has now (the person chose to overwrite it). */
  rebase?(path: string): Promise<void>
  /** Locks the file against caching, or unlocks it (see `Entry.locked`). */
  setLocked?(path: string, locked: boolean): Promise<void>
  /** In a branch: takes the file into it without changing it, so it is among the pending changes. */
  checkout?(path: string): Promise<void>
  /** In a branch: lets go of a file that was checked out and never changed. */
  release?(path: string): Promise<void>
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
    rootId: root.id,
    openAsWebApp: async (path) => {
      await openFileAsWebApp({ storage: root.id === 'user' ? 'UserFolder' : 'DeviceFolder', root: root.id, path })
    },
    read: (path) => readRootFile(root, path),
    write: (path, data) => writeRootFile(root, path, data),
    writeFromFile: (path, file) => writeRootFileFrom(root, path, file),
    exportFile: (path, name, token) => invoke<string>('export_local_file', { root: root.id, path, name, token }),
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
  kind: 'put' | 'mkdir' | 'delete' | 'checkout'
  isNew: boolean
}

export interface CommitReport {
  committed: boolean
  applied: number
  conflicts: string[]
}

interface RawVersion {
  exists: boolean
  size: number | null
  mtimeMs: number | null
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

/** How big a piece of a file is read and sent at a time when it goes up to Filen. */
const UPLOAD_PIECE = 4 * 1024 * 1024

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
    branch,
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
    async writeFromFile(path, file) {
      const id = await invoke<string>('filen_cache_upload_begin', { ...target, path: filenPath(path) })
      try {
        for (let at = 0; at < file.size; at += UPLOAD_PIECE) {
          const piece = new Uint8Array(await file.slice(at, at + UPLOAD_PIECE).arrayBuffer())
          await invokeWithBytes('filen_cache_upload_chunk', piece, { id })
        }
        await invoke('filen_cache_upload_finish', { id })
      } catch (e) {
        await invoke('filen_cache_upload_abort', { id }).catch(() => {})
        throw e
      }
    },
    openAsWebApp: async (path) => {
      await openFileAsWebApp({ storage: 'FilenCloud', userId, branch, path: filenPath(path) })
    },
    exportFile: (path, name, token) => invoke<string>('filen_cache_export', { ...target, path: filenPath(path), name, token }),
    copyFromLocal: (path, root, source) => invoke<void>('filen_cache_upload_from_path', { ...target, path: filenPath(path), root, source }),
    copyToLocal: (path, root, dest) => invoke<void>('filen_cache_download_to', { ...target, path: filenPath(path), root, dest }),
    mkdir: (path) => invoke<void>('filen_cache_mkdir', { ...target, path: filenPath(path) }),
    remove: (path) => invoke<void>('filen_cache_rm', { ...target, path: filenPath(path) }),
    rename: (from, to) => invoke<void>('filen_cache_rename', { ...target, from: filenPath(from), to: filenPath(to) }),
    version: (path) => invoke<RawVersion>('filen_cache_version', { ...target, path: filenPath(path) }),
    checkVersion: (path, base) => invoke<VersionCheck>('filen_cache_check_version', { ...target, path: filenPath(path), base }),
    rebase: branch === null ? undefined : (path) => invoke<void>('filen_cache_rebase', { userId, branch, path: filenPath(path) }),
    // A lock is on the account's file, so it is the same whichever branch it is asked from.
    setLocked: (path, locked) => invoke<void>('filen_cache_set_locked', { userId, path: filenPath(path), locked }),
    checkout: branch === null ? undefined : (path) => invoke<void>('filen_cache_checkout', { userId, branch, path: filenPath(path) }),
    release: branch === null ? undefined : (path) => invoke<void>('filen_cache_release', { userId, branch, path: filenPath(path) }),
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
  } else if (from.rootId !== undefined && to.rootId !== undefined) {
    await copyFile(from.rootId, fromPath, to.rootId, toPath) // both on this device: copied on the Rust side
  } else if (from.rootId !== undefined && to.copyFromLocal) {
    await to.copyFromLocal(toPath, from.rootId, fromPath) // read from disk on the Rust side
  } else if (to.rootId !== undefined && from.copyToLocal) {
    await from.copyToLocal(fromPath, to.rootId, toPath) // written to disk on the Rust side
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

