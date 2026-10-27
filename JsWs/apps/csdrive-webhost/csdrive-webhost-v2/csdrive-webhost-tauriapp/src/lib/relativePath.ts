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

/** `targetFolder` relative to `baseFolder` — `../` segments as needed, both using the no-leading/trailing-
 * slash convention (`''` for the root). Unlike `relativePathFrom` above (built for a *file* target, which
 * keeps its own name past the common prefix), this treats `targetFolder` itself as the thing being related
 * to, since what a notebook's own per-notebook settings reference (a custom-text location, the viewer
 * script's folder) is a folder, not a file relative to some *other* file's own folder. Used so a path
 * written here survives the notebook being moved or copied intact — unlike a path relative to the whole
 * source's own root, which breaks the moment the notebook's own folder moves. */
export function folderRelativeTo(baseFolder: string, targetFolder: string): string {
  const baseParts = baseFolder ? baseFolder.split('/') : []
  const targetParts = targetFolder ? targetFolder.split('/') : []
  let common = 0
  while (common < baseParts.length && common < targetParts.length && baseParts[common] === targetParts[common]) common++
  const up = baseParts.length - common
  return [...Array(up).fill('..'), ...targetParts.slice(common)].join('/')
}

/** The reverse of `folderRelativeTo`: resolves a possibly `../`-prefixed relative path against `baseFolder`,
 * back to a path from the storage's own root. */
export function resolveFolderRelative(baseFolder: string, relative: string): string {
  const parts = [...(baseFolder ? baseFolder.split('/') : []), ...(relative ? relative.split('/') : [])]
  const resolved: string[] = []
  for (const part of parts) {
    if (part === '' || part === '.') continue
    if (part === '..') resolved.pop()
    else resolved.push(part)
  }
  return resolved.join('/')
}
