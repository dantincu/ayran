/** The shortest relative path from `fromFolder` (the folder of the file being edited, relative to some root, no
 * leading/trailing slash — `''` is the root) to `targetPath` (a file, same convention) — `../` segments as
 * needed, never a leading `./` (a file in the same folder is just its own name). Used by "Insert a path…"
 * (`InsertPathModal.tsx`, `system/notes/InsertPathModal.tsx`) to write a markdown-style relative link from the
 * file being edited to wherever the explorer picked. */
export function relativePathFrom(fromFolder: string, targetPath: string): string {
  const fromParts = fromFolder ? fromFolder.split('/') : []
  const targetParts = targetPath.split('/')
  const targetDirParts = targetParts.slice(0, -1)
  let common = 0
  while (common < fromParts.length && common < targetDirParts.length && fromParts[common] === targetDirParts[common]) common++
  const up = fromParts.length - common
  return [...Array(up).fill('..'), ...targetParts.slice(common)].join('/')
}

/** `targetPath` as an absolute path — from `root` when given (a folder, same convention as `relativePathFrom`;
 * "notebook root" for a note editor, per the notes strategy), or from the storage's own root otherwise. A target
 * that isn't under `root` at all (a sibling notebook, say) falls back to the storage root rather than refusing:
 * there's no meaningful "notebook-relative" address for it. */
export function absolutePathFrom(targetPath: string, root: string | null): string {
  if (root && (targetPath === root || targetPath.startsWith(`${root}/`))) {
    return `/${targetPath.slice(root.length + 1)}`
  }
  return `/${targetPath}`
}
