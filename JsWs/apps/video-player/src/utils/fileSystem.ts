import type { FileNode } from '../types'

export const VIDEO_EXTENSIONS = new Set([
  'mp4', 'mkv', 'webm', 'mov', 'avi', 'm4v', 'wmv', 'ogv', 'flv', '3gp', 'ts', 'mts',
])

export function isVideoFile(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  return VIDEO_EXTENSIONS.has(ext)
}

export async function getOrCreateDataFolder(
  root: FileSystemDirectoryHandle,
  relativePath: string,
): Promise<FileSystemDirectoryHandle> {
  const parts = relativePath.split('/').filter(Boolean)
  let current = root
  for (const part of parts) {
    current = await current.getDirectoryHandle(part, { create: true })
  }
  return current
}

export async function buildFileTree(
  dirHandle: FileSystemDirectoryHandle,
  path: string = '',
  skipTopLevelName: string = '',
  depth: number = 0,
): Promise<FileNode[]> {
  if (depth > 8) return []

  const nodes: FileNode[] = []

  for await (const entry of dirHandle.values()) {
    // Skip the data folder at top level
    if (depth === 0 && skipTopLevelName && entry.name === skipTopLevelName) continue

    const entryPath = path ? `${path}/${entry.name}` : entry.name

    if (entry.kind === 'directory') {
      const children = await buildFileTree(
        entry as FileSystemDirectoryHandle,
        entryPath,
        '',
        depth + 1,
      )
      if (children.length > 0) {
        nodes.push({
          name: entry.name,
          path: entryPath,
          kind: 'directory',
          handle: entry as FileSystemDirectoryHandle,
          children,
        })
      }
    } else if (isVideoFile(entry.name)) {
      nodes.push({
        name: entry.name,
        path: entryPath,
        kind: 'file',
        handle: entry as FileSystemFileHandle,
      })
    }
  }

  return nodes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  })
}

export function findNodeByPath(tree: FileNode[], targetPath: string): FileNode | null {
  for (const node of tree) {
    if (node.path === targetPath) return node
    if (node.kind === 'directory' && node.children) {
      const found = findNodeByPath(node.children, targetPath)
      if (found) return found
    }
  }
  return null
}

export async function getFileObjectUrl(handle: FileSystemFileHandle): Promise<string> {
  const file = await handle.getFile()
  return URL.createObjectURL(file)
}
