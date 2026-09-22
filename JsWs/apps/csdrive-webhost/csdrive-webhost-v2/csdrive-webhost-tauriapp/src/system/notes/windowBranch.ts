import { invoke } from '@tauri-apps/api/core'

/** The branch a Notes window works in, **per window**: changing it in one window doesn't change it in another, and a new window
 * starts on the main view (no branch). It is kept in the window's own state (`window_state` in the backend, which goes with the
 * window's entry), one branch per source — the Filen accounts and the folders of this device each have their own.
 *
 * All the tabs of a window share it: a window shows one tab at a time, and a tab switched to takes the branch the window is in
 * (`draftsInTheWay` says when a change of branch would strand what another tab of the window has not saved). */
const KEY = 'notes.branches'

type Branches = Record<string, number>

async function read(): Promise<Branches> {
  try {
    const raw = await invoke<string | null>('get_window_state', { key: KEY })
    const parsed = raw ? JSON.parse(raw) : {}
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    return Object.fromEntries(Object.entries(parsed).filter(([, v]) => typeof v === 'number' && Number.isInteger(v) && v > 0)) as Branches
  } catch {
    return {}
  }
}

/** The branch this window works in for `sourceId` (`null`: the account or folder itself). */
export async function windowBranchOf(sourceId: string): Promise<number | null> {
  return (await read())[sourceId] ?? null
}

/** Makes `branch` the one this window works in for `sourceId`. */
export async function setWindowBranch(sourceId: string, branch: number | null): Promise<void> {
  const all = await read()
  if (branch === null) delete all[sourceId]
  else all[sourceId] = branch
  await invoke('set_window_state', { key: KEY, value: JSON.stringify(all) })
}

/** What another tab of the window has not saved: the file, and the branch it was being edited in. */
export interface UnsavedEdit {
  path: string
  /** Where it was started: a branch's index, or `null` for the account or folder itself. */
  branch: number | null
}

/** Which of these unsaved edits a change of the window's branch to `toBranch` would put in the way: those of a file that is not the
 * same in the two views — one of the views (the branch it was edited in, the one it is going to) changes it. An edit in the branch the
 * window is going to isn't in the way, and neither is one of a file that both views have as the account or folder does.
 *
 * (The change from the main view to a branch that has just been made is not asked about at all — the caller skips this: a new branch
 * starts as the main view, so what another tab has open carries on into it; that is the exception the person asked for.)
 *
 * `changedIn(branch)` says which paths (`/a/b`) the branch has put or deleted. */
export async function draftsInTheWay(
  edits: UnsavedEdit[],
  toBranch: number | null,
  changedIn: (branch: number) => Promise<Set<string>>,
): Promise<UnsavedEdit[]> {
  const known = new Map<number, Set<string>>()
  const changed = async (branch: number) => {
    let paths = known.get(branch)
    if (!paths) {
      paths = await changedIn(branch).catch(() => new Set<string>()) // a branch that is gone changes nothing
      known.set(branch, paths)
    }
    return paths
  }
  const stuck: UnsavedEdit[] = []
  for (const edit of edits) {
    if (edit.branch === toBranch) continue
    const path = `/${edit.path.replace(/^\/+/, '')}`
    const inFrom = edit.branch !== null && (await changed(edit.branch)).has(path)
    const inTo = toBranch !== null && (await changed(toBranch)).has(path)
    if (inFrom || inTo) stuck.push(edit)
  }
  return stuck
}
