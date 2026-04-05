import * as FileSystem from 'expo-file-system/legacy'
import type { FileNode } from '../types'

const SAF = FileSystem.StorageAccessFramework

export const VIDEO_EXTENSIONS = new Set([
  'mp4', 'mkv', 'webm', 'mov', 'avi', 'm4v', 'wmv', 'ogv', 'flv', '3gp', 'ts', 'mts',
])

export function isVideoFile(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  return VIDEO_EXTENSIONS.has(ext)
}

// Extract the display name from a SAF content URI.
// SAF URIs look like:
//   content://authority/tree/primary%3AMovies/document/primary%3AMovies%2Fvideo.mp4
// After decoding the document segment is like "primary:Movies/video.mp4"
// and we want "video.mp4".
function getNameFromUri(uri: string): string {
  const decoded = decodeURIComponent(uri)
  const docPart = decoded.split('/document/').pop() ?? decoded
  const lastSegment = docPart.split('/').pop() ?? docPart
  return lastSegment.split(':').pop() ?? lastSegment
}

// SAF document URIs don't expose isDirectory reliably via getInfoAsync.
// The only reliable check is attempting to list the URI as a directory.
async function checkIsDirectory(uri: string): Promise<boolean> {
  try {
    await SAF.readDirectoryAsync(uri)
    return true
  } catch {
    return false
  }
}

export async function buildFileTree(
  dirUri: string,
  relativePath: string,
  depth: number,
  onSkip?: (path: string, err: Error) => void,
): Promise<FileNode[]> {
  if (depth > 8) return []

  let childUris: string[]
  try {
    childUris = await SAF.readDirectoryAsync(dirUri)
  } catch {
    return []
  }

  const nodes: FileNode[] = []

  for (const childUri of childUris) {
    const name = getNameFromUri(childUri)
    if (!name || name.startsWith('.')) continue

    const entryPath = relativePath ? `${relativePath}/${name}` : name

    try {
      const isDir = await checkIsDirectory(childUri)

      if (isDir) {
        const children = await buildFileTree(childUri, entryPath, depth + 1, onSkip)
        if (children.length > 0) {
          nodes.push({ name, path: entryPath, uri: childUri, kind: 'directory', children })
        }
      } else if (isVideoFile(name)) {
        nodes.push({ name, path: entryPath, uri: childUri, kind: 'file' })
      }
    } catch (e) {
      onSkip?.(entryPath, e instanceof Error ? e : new Error(String(e)))
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
