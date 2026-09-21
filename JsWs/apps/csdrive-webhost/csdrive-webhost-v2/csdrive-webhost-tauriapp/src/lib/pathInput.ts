/** A path typed or pasted into a "Go to a path" box (`components/GoToPathModal.tsx`), turned into its folder names.
 *
 * Either kind of slash separates them, a leading or trailing one (or a doubled one) is ignored, `.` means nothing and
 * quotes around the whole text (what "Copy as path" puts there) are dropped. `..` is refused: a path goes down from
 * where it starts, never up, and a file source would refuse it anyway. */

export type ParsedPath = { ok: true; segments: string[]; query: string | null } | { ok: false; error: string }

export function parsePathInput(text: string): ParsedPath {
  let value = text.trim()
  // A query (`/Projects/001?note`) is set aside from the path, and handed on: a note's address is a path with one.
  let query: string | null = null
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    value = value.slice(1, -1).trim()
  }
  if (/[\r\n]/.test(value)) return { ok: false, error: 'A path is a single line.' }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(value)) return { ok: false, error: 'A path has no control characters.' }
  const cut = value.indexOf('?')
  if (cut >= 0) {
    query = value.slice(cut + 1).split('#')[0]
    value = value.slice(0, cut)
  }
  const segments = value
    .replace(/\\/g, '/')
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s !== '' && s !== '.')
  if (segments.includes('..')) return { ok: false, error: "A path can't contain \"..\"." }
  return { ok: true, segments, query }
}

/** The folder names of `path` (`/a/b`, `a/b`, `` for the top), as they are shown in a "Go to a path" box: with a leading slash. */
export function pathForInput(path: string): string {
  const inner = path.replace(/^\/+/, '')
  return `/${inner}`
}
