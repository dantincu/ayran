import { parseAyranPath, resolveAyranPath } from './AyranPath';
import { AyranPathType } from '../types/path.types';

export interface LinkResolution {
  /** Expo Router href if this is an in-app link */
  appHref?: string;
  /** External URL if this is an external link */
  externalUrl?: string;
  /** Storage path if this resolves to a file */
  storagePath?: string;
  isNote: boolean;
  isExternal: boolean;
}

/**
 * Resolve an Ayran path string to an Expo Router href or external URL.
 */
export function resolveLink(
  raw: string,
  notebookRootPath: string,
  currentNotePath: string,
  currentDirPath: string,
): LinkResolution {
  const parsed = parseAyranPath(raw);

  if (parsed.type === AyranPathType.External) {
    return { externalUrl: raw, isNote: false, isExternal: true };
  }

  const resolved = resolveAyranPath(parsed, notebookRootPath, currentNotePath, currentDirPath);

  if (resolved.isNote) {
    // Convert storage path to note path relative to notebook root
    const notePath = storagePathToNotePath(resolved.storagePath, notebookRootPath);
    return {
      appHref: `/notes/${encodeURIComponent(notePath)}`,
      storagePath: resolved.storagePath,
      isNote: true,
      isExternal: false,
    };
  } else {
    return {
      appHref: `/files/${encodeURIComponent(resolved.storagePath)}`,
      storagePath: resolved.storagePath,
      isNote: false,
      isExternal: false,
    };
  }
}

function storagePathToNotePath(storagePath: string, notebookRootPath: string): string {
  let path = storagePath;
  if (path.startsWith(notebookRootPath)) {
    path = path.slice(notebookRootPath.length);
  }
  return path.replace(/^\/+/, '');
}

/**
 * Parse an ayran:// URI emitted by the HTML post-processor.
 */
export function parseAyranSchemeUri(uri: string): { storagePath: string; isNote: boolean } | null {
  if (!uri.startsWith('ayran://navigate')) return null;
  try {
    const url = new URL(uri);
    const path = url.searchParams.get('path');
    const isNote = url.searchParams.get('isNote') === 'true';
    if (!path) return null;
    return { storagePath: path, isNote };
  } catch {
    return null;
  }
}
