/** Notes' own File Manager and Note Files Explorer ask, by default, before every destructive change
 * (deleting an entry, overwriting one on upload) — see `lib/dialogs.ts`'s `confirm`. Asked for directly
 * (see CLAUDE.md's "Permission prompts" item): instead of a confirmation for every single entry, the
 * *first* one in a folder may instead grant trust to that whole folder (and everything under it, at any
 * depth) for the rest of the session — after which further destructive changes there ask nothing at all.
 *
 * **In memory only, never persisted** — the same lifetime as `prompt_guard`'s own "Prevent this app from
 * showing prompts" flag (CLAUDE.md's "Prompts and windows"): gone the moment the app restarts, so a trust
 * grant can never silently survive past the session it was given in. Keyed by `(sourceId, branch)` *and*
 * the folder's own path, so trusting a folder in the main view never trusts the same-named folder of a
 * branch, or of a different source — a malicious script, or an honest mistake, can't widen a grant beyond
 * the one folder (and its descendants) it was actually given for. */

interface Trusted {
  key: string
  path: string
}

const trusted: Trusted[] = []

function sourceKey(sourceId: string, branch: number | null): string {
  return `${sourceId}::${branch ?? ''}`
}

function underTrusted(key: string, path: string): boolean {
  // An empty `t.path` is the root itself — trusting it must cover every subfolder too, but a root-relative
  // path never actually starts with "/" (there is no leading slash to match against), so the ordinary
  // prefix check below would otherwise never fire for anything but the literal root.
  return trusted.some((t) => t.key === key && (t.path === '' || path === t.path || path.startsWith(`${t.path}/`)))
}

/** Whether destructive changes under this exact folder, in this source/branch, may proceed without asking. */
export function isFolderTrusted(sourceId: string, branch: number | null, path: string): boolean {
  return underTrusted(sourceKey(sourceId, branch), path)
}

/** Grants trust to this folder (and everything under it, at any depth) for the rest of the session. */
export function trustFolder(sourceId: string, branch: number | null, path: string): void {
  const key = sourceKey(sourceId, branch)
  if (!underTrusted(key, path)) trusted.push({ key, path })
}
