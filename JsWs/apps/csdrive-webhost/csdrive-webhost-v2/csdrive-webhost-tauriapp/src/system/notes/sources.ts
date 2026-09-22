import { invoke } from '@tauri-apps/api/core'
import { invokeWithBytes } from '../../lib/ipcBytes'
import { copyFile } from '../../lib/fs'
import { notifyFileSaved, openFileAsWebApp, type FileRef } from '../../lib/secondaryWindows'
import { joinRelative } from '../../lib/localFs'
import {
  type FileRoot,
  listRootDir,
  listRootDirDetailed,
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
  /** Filen: its id (uuid) — none for something that only exists in a branch so far. */
  id?: string | null
  name: string
  isDirectory: boolean
  size: number | null
  mtimeMs: number | null
  /** When it was created — a folder of this device where the platform keeps that (a search and a sort can use it); Filen doesn't say. */
  createdMs?: number | null
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

/** The branches of an account or of a folder of this device: one interface for both, so the file manager, its editors and the
 * page for a note treat them the same. `source(branch)` is the same account or folder seen through that branch (`null`: itself). */
export interface BranchApi {
  /** Whose branches these are: `filen:123` or `local:<root id>`. */
  id: string
  list(): Promise<BranchInfo[]>
  create(name: string): Promise<BranchInfo>
  changes(branch: number): Promise<BranchChange[]>
  commit(branch: number, force: boolean): Promise<CommitReport>
  discard(branch: number): Promise<void>
  source(branch: number | null): FileSource
}

export interface DirListing {
  entries: Entry[]
  /** Filen: when the listing was fetched from the account (ms since 1970). */
  fetchedAt?: number
  /** Filen: it had expired but the account couldn't be reached, so it is shown as it was. */
  stale?: boolean
}

/** Where the thumbnails of a Filen account's (or branch's) files are kept, on disk with the cache: a JPEG per version of a
 * file, told by its modification time and size (see `thumbnails.ts`). */
export interface ThumbnailStore {
  get(path: string, mtimeMs: number, size: number): Promise<Uint8Array | null>
  put(path: string, mtimeMs: number, size: number, jpeg: Uint8Array): Promise<void>
}

export interface FileSource {
  /** Stable across sessions — what a tab's resource id names (`local:user`, `filen:123`). */
  id: string
  /** `id` plus the branch: two sources with the same key work on the very same files. */
  viewKey: string
  kind: 'local' | 'filen'
  label: string
  /** The branch this works in, or `null` for the account (Filen) or folder (this device) itself. */
  branch?: number | null
  /** The branches of this source's account or folder — what a branch is made, listed, committed and discarded through (a Filen
   * account and a folder of this device both have them; a scoped source has none of its own). */
  branches?: BranchApi
  /** `force` skips the cache (Filen only). */
  list(path: string, force?: boolean): Promise<DirListing>
  /** A folder of this device: the same, with every entry's size and dates — one call for the whole folder (searching and sorting by
   * size or date need them all; `list` gives names only). A Filen listing has size and modified time already. */
  listDetailed?(path: string): Promise<DirListing>
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
  /** With `rootId`: the folder of that root this source's paths are relative to (a source scoped to a folder inside it,
   * see `scopedSource`) — `''` or absent: the root itself. */
  rootPrefix?: string
  /** Filen: takes a file from a folder on this device (`root` and `source`, as the file commands
   * name them) without it passing through the page. */
  copyFromLocal?(path: string, root: string, source: string): Promise<void>
  /** Filen: puts a file at `dest` inside a folder on this device, likewise. */
  copyToLocal?(path: string, root: string, dest: string): Promise<void>
  mkdir(path: string): Promise<void>
  remove(path: string, isDirectory: boolean): Promise<void>
  rename(from: string, to: string): Promise<void>

  /** The file as the backend names it (which storage, which folder or account, which path). */
  fileRef?(path: string): FileRef
  /** Filen: where its thumbnails are kept (a folder on this device has none: they are made again each session). */
  thumbnails?: ThumbnailStore
  /** Tells the windows that show the file as a web app that it was saved (they reload). */
  notifySaved?(path: string): Promise<void>

  /** Opens the html or markdown file as a web app (a window of its own, listed under this Notes tab). */
  openAsWebApp?(path: string): Promise<void>

  /** What a source that caches can do to the cache of one item — a file, a folder (Filen accounts). `undefined` for a source with no
   * cache. The *soft* refresh needs nothing of the backend (the item is read again the ordinary way: from the cache while it is valid). */
  cache?: {
    /** Fetches the item from Filen again and replaces what the cache holds of it (a locked file refuses). */
    hardRefresh(path: string): Promise<void>
    /** Throws away what the cache holds of it — content, listing, thumbnails (a locked file keeps its frozen copy). */
    clear(path: string): Promise<void>
  }

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

/** The root's guid — its name in the folders the Notes app keeps for it (`files/b/NNN-local-fs@@<guid>`), shown on its pill's menu. */
export const rootGuid = (rootId: string) => invoke<string>('root_guid', { root: rootId })

const slashed = (path: string) => `/${path.replace(/^\/+/, '')}`

/** The branches of a folder of this device (`files_cache/local_branches.rs`): changes that stay in the app's own folder until they
 * are committed to the real one. There is no cache — the folder is always read as it is. */
export function localBranchApi(root: FileRoot): BranchApi {
  return {
    id: `${LOCAL_PREFIX}${root.id}`,
    list: () => invoke<BranchInfo[]>('local_branches', { root: root.id }),
    create: (name) => invoke<BranchInfo>('local_branch_create', { root: root.id, name }),
    changes: (branch) => invoke<BranchChange[]>('local_branch_changes', { root: root.id, branch }),
    commit: (branch, force) => invoke<CommitReport>('local_branch_commit', { root: root.id, branch, force }),
    discard: (branch) => invoke<void>('local_branch_discard', { root: root.id, branch }),
    source: (branch) => localSource(root, branch),
  }
}

/** A folder on this device: the user folder or one the person picked — with `branch`, that branch of it (its changes stay in the
 * branch until it is committed). */
export function localSource(root: FileRoot, branch: number | null = null): FileSource {
  const storage = root.id === 'user' ? 'UserFolder' : 'DeviceFolder'
  const thumbnails: ThumbnailStore = {
    async get(path, mtimeMs, size) {
      const bytes = new Uint8Array(await invoke<ArrayBuffer>('local_thumb_get', { root: root.id, branch, path: slashed(path), mtimeMs, size }))
      return bytes.length > 0 ? bytes : null
    },
    async put(path, mtimeMs, size, jpeg) {
      const fields: Record<string, string> = { root: root.id, path: slashed(path), mtimeMs: String(mtimeMs), size: String(size) }
      if (branch !== null) fields.branch = String(branch)
      await invokeWithBytes('local_thumb_put', jpeg, fields)
    },
  }
  const common = {
    id: `${LOCAL_PREFIX}${root.id}`,
    kind: 'local' as const,
    label: root.label,
    branches: localBranchApi(root),
    thumbnails,
  }
  if (branch === null) {
    const ref = (path: string): FileRef => ({ storage, root: root.id, path })
    return {
      ...common,
      viewKey: `${LOCAL_PREFIX}${root.id}`,
      async list(path) {
        const entries = await listRootDir(root, path)
        return {
          entries: sortEntries(entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory, size: null, mtimeMs: null }))),
        }
      },
      async listDetailed(path) {
        const entries = await listRootDirDetailed(root, path)
        return {
          entries: sortEntries(entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory, size: e.size, mtimeMs: e.mtimeMs, createdMs: e.createdMs }))),
        }
      },
      async stat(path) {
        const info = await statRootPath(root, path)
        return { size: info.isDirectory ? null : info.size, mtimeMs: info.mtimeMs }
      },
      rootId: root.id,
      fileRef: ref,
      notifySaved: (path) => notifyFileSaved(ref(path)),
      openAsWebApp: async (path) => {
        await openFileAsWebApp(ref(path))
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

  // The folder seen through a branch. It isn't "a folder of this device" for the copies that go straight from disk to disk
  // (no `rootId`): what the branch shows isn't on the folder.
  const target = { root: root.id, branch }
  const ref = (path: string): FileRef => ({ storage: 'DeviceFolder', root: `${root.id}~${branch}`, path })
  return {
    ...common,
    viewKey: `${LOCAL_PREFIX}${root.id}#${branch}`,
    branch,
    async list(path) {
      const listing = await invoke<RawListing>('local_branch_list', { ...target, path: slashed(path) })
      return { entries: sortEntries(listing.entries), fetchedAt: listing.fetchedAt, stale: false }
    },
    async read(path) {
      return new Uint8Array(await invoke<ArrayBuffer>('local_branch_read', { ...target, path: slashed(path) }))
    },
    async write(path, data) {
      await invokeWithBytes('local_branch_write', data, { root: root.id, branch: String(branch), path: slashed(path) })
    },
    async writeFromFile(path, file) {
      const id = await invoke<string>('local_branch_upload_begin', { ...target, path: slashed(path) })
      try {
        for (let at = 0; at < file.size; at += UPLOAD_PIECE) {
          const piece = new Uint8Array(await file.slice(at, at + UPLOAD_PIECE).arrayBuffer())
          await invokeWithBytes('fs_upload_chunk', piece, { id })
        }
        await invoke('local_branch_upload_finish', { id })
      } catch (e) {
        await invoke('fs_upload_abort', { id }).catch(() => {})
        throw e
      }
    },
    exportFile: (path, name, token) => invoke<string>('local_branch_export', { ...target, path: slashed(path), name, token }),
    copyFromLocal: (path, fromRoot, source) => invoke<void>('local_branch_put_from_path', { ...target, path: slashed(path), fromRoot, source }),
    copyToLocal: (path, toRoot, dest) => invoke<void>('local_branch_copy_to', { ...target, path: slashed(path), toRoot, dest }),
    mkdir: (path) => invoke<void>('local_branch_mkdir', { ...target, path: slashed(path) }),
    remove: (path) => invoke<void>('local_branch_rm', { ...target, path: slashed(path) }),
    rename: (from, to) => invoke<void>('local_branch_rename', { ...target, from: slashed(from), to: slashed(to) }),
    fileRef: ref,
    notifySaved: (path) => notifyFileSaved(ref(path)),
    openAsWebApp: async (path) => {
      await openFileAsWebApp(ref(path))
    },
    version: (path) => invoke<RawVersion>('local_branch_version', { ...target, path: slashed(path) }),
    checkVersion: (path, base) => invoke<VersionCheck>('local_branch_check_version', { root: root.id, path: slashed(path), base }),
    rebase: (path) => invoke<void>('local_branch_rebase', { ...target, path: slashed(path) }),
    checkout: (path) => invoke<void>('local_branch_checkout', { ...target, path: slashed(path) }),
    release: (path) => invoke<void>('local_branch_release', { ...target, path: slashed(path) }),
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

/** How big a piece of a file is read and sent at a time when it goes up to Filen (or into a branch). */
const UPLOAD_PIECE = 4 * 1024 * 1024

/** The branches of a Filen account. */
export function filenBranchApi(account: FilenAccountInfo): BranchApi {
  const { userId } = account
  return {
    id: `${FILEN_PREFIX}${userId}`,
    list: () => filenCache.branches(userId),
    create: (name) => filenCache.createBranch(userId, name),
    changes: (branch) => filenCache.branchChanges(userId, branch),
    commit: (branch, force) => filenCache.commitBranch(userId, branch, force),
    discard: (branch) => filenCache.discardBranch(userId, branch),
    source: (branch) => filenSource(account, branch),
  }
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
    branch,
    branches: filenBranchApi(account),
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
    fileRef: (path) => ({ storage: 'FilenCloud', userId, branch, path: filenPath(path) }),
    thumbnails: {
      async get(path, mtimeMs, size) {
        const bytes = new Uint8Array(await invoke<ArrayBuffer>('filen_cache_thumb_get', { ...target, path: filenPath(path), mtimeMs, size }))
        return bytes.length > 0 ? bytes : null
      },
      async put(path, mtimeMs, size, jpeg) {
        const fields: Record<string, string> = { userId: String(userId), path: filenPath(path), mtimeMs: String(mtimeMs), size: String(size) }
        if (branch !== null) fields.branch = String(branch)
        await invokeWithBytes('filen_cache_thumb_put', jpeg, fields)
      },
    },
    notifySaved: (path) => notifyFileSaved({ storage: 'FilenCloud', userId, branch, path: filenPath(path) }),
    openAsWebApp: async (path) => {
      await openFileAsWebApp({ storage: 'FilenCloud', userId, branch, path: filenPath(path) })
    },
    cache: {
      hardRefresh: (path) => invoke<void>('filen_cache_hard_refresh', { userId, path: filenPath(path) }),
      clear: (path) => invoke<void>('filen_cache_clear_item', { userId, path: filenPath(path) }),
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

/** `base` seen from the folder `root` inside it: every path is relative to that folder, and nothing above it can be reached — what
 * a note's files explorer works in (the note's `01` folder). `label` is what the folder is called in the listing's breadcrumbs. */
export function scopedSource(base: FileSource, root: string, label: string): FileSource {
  const at = (path: string) => joinRelative(root, path)
  const scoped: FileSource = {
    ...base,
    id: base.id,
    viewKey: `${base.viewKey}@${root}`,
    label,
    list: (path, force) => base.list(at(path), force),
    listDetailed: base.listDetailed ? (path) => base.listDetailed!(at(path)) : undefined,
    read: (path) => base.read(at(path)),
    write: (path, data) => base.write(at(path), data),
    exportFile: (path, name, token) => base.exportFile(at(path), name, token),
    mkdir: (path) => base.mkdir(at(path)),
    remove: (path, isDirectory) => base.remove(at(path), isDirectory),
    rename: (from, to) => base.rename(at(from), at(to)),
    rootPrefix: base.rootId === undefined ? undefined : joinRelative(base.rootPrefix ?? '', root),
    branches: undefined, // the branches are the whole source's, not a folder's
  }
  if (base.stat) scoped.stat = (path) => base.stat!(at(path))
  if (base.writeFromFile) scoped.writeFromFile = (path, file) => base.writeFromFile!(at(path), file)
  if (base.copyFromLocal) scoped.copyFromLocal = (path, rootId, source) => base.copyFromLocal!(at(path), rootId, source)
  if (base.copyToLocal) scoped.copyToLocal = (path, rootId, dest) => base.copyToLocal!(at(path), rootId, dest)
  if (base.openAsWebApp) scoped.openAsWebApp = (path) => base.openAsWebApp!(at(path))
  if (base.notifySaved) scoped.notifySaved = (path) => base.notifySaved!(at(path))
  if (base.fileRef) scoped.fileRef = (path) => base.fileRef!(at(path))
  if (base.thumbnails) {
    const store = base.thumbnails
    scoped.thumbnails = {
      get: (path, mtimeMs, size) => store.get(at(path), mtimeMs, size),
      put: (path, mtimeMs, size, jpeg) => store.put(at(path), mtimeMs, size, jpeg),
    }
  }
  if (base.cache) {
    const cache = base.cache
    scoped.cache = { hardRefresh: (path) => cache.hardRefresh(at(path)), clear: (path) => cache.clear(at(path)) }
  } else scoped.cache = undefined
  if (base.version) scoped.version = (path) => base.version!(at(path))
  if (base.checkVersion) scoped.checkVersion = (path, known) => base.checkVersion!(at(path), known)
  if (base.rebase) scoped.rebase = (path) => base.rebase!(at(path))
  if (base.setLocked) scoped.setLocked = (path, locked) => base.setLocked!(at(path), locked)
  if (base.checkout) scoped.checkout = (path) => base.checkout!(at(path))
  if (base.release) scoped.release = (path) => base.release!(at(path))
  return scoped
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
    await copyFile(from.rootId, joinRelative(from.rootPrefix ?? '', fromPath), to.rootId, joinRelative(to.rootPrefix ?? '', toPath)) // both on this device: copied on the Rust side
  } else if (from.rootId !== undefined && to.copyFromLocal) {
    await to.copyFromLocal(toPath, from.rootId, joinRelative(from.rootPrefix ?? '', fromPath)) // read from disk on the Rust side
  } else if (to.rootId !== undefined && from.copyToLocal) {
    await from.copyToLocal(fromPath, to.rootId, joinRelative(to.rootPrefix ?? '', toPath)) // written to disk on the Rust side
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

