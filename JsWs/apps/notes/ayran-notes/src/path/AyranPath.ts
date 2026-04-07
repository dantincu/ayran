import { AyranPathType, ParsedAyranPath, ResolvedPath } from '../types/path.types';

/**
 * Parse an Ayran path string into its components.
 *
 * Path format summary:
 *   ||/<note-path>            note-absolute from notebook root
 *   ||./<note-path>           note-relative to current note
 *   |/<file-path>             file-absolute from notebook root
 *   |./<file-path>            file-relative to current directory
 *   ||/<note-path>/|/<fp>     file attached to specific note (note-absolute)
 *   ||./<note-path>/|/<fp>    file attached to specific note (note-relative)
 *   <plain>                   plain relative path (no | prefix)
 *   http(s)://...             external URI
 */
export function parseAyranPath(raw: string): ParsedAyranPath {
  // External URI
  if (/^https?:\/\//i.test(raw) || /^[a-z][a-z0-9+\-.]*:\/\//i.test(raw)) {
    return { type: AyranPathType.External, raw };
  }

  // Note-file composite: ||/<note-path>/|/<file-path> or ||./<note-path>/|/<file-path>
  // The |/ separator must appear after the note part
  const compositeMatch = raw.match(/^(\|\|\.?\/)(.+?)\/\|\/(.*)$/);
  if (compositeMatch) {
    const notePrefix = compositeMatch[1];
    const notePath = compositeMatch[2];
    const filePath = compositeMatch[3];
    return {
      type: AyranPathType.NoteFile,
      raw,
      notePath,
      filePath,
      noteRelative: notePrefix === '||./',
      fileRelative: false,
    };
  }

  // Note absolute: ||/<note-path>
  if (raw.startsWith('||/')) {
    return {
      type: AyranPathType.NoteAbsolute,
      raw,
      notePath: raw.slice(3),
      noteRelative: false,
    };
  }

  // Note relative: ||./<note-path>
  if (raw.startsWith('||./')) {
    return {
      type: AyranPathType.NoteRelative,
      raw,
      notePath: raw.slice(4),
      noteRelative: true,
    };
  }

  // File absolute: |/<file-path>
  if (raw.startsWith('|/')) {
    return {
      type: AyranPathType.FileAbsolute,
      raw,
      filePath: raw.slice(2),
      fileRelative: false,
    };
  }

  // File relative: |./<file-path>
  if (raw.startsWith('|./')) {
    return {
      type: AyranPathType.FileRelative,
      raw,
      filePath: raw.slice(3),
      fileRelative: true,
    };
  }

  // Plain relative path
  return {
    type: AyranPathType.PlainRelative,
    raw,
    filePath: raw,
    fileRelative: true,
  };
}

/**
 * Resolve path segments, handling ".." correctly.
 */
export function resolvePathSegments(base: string[], relative: string[]): string[] {
  const result = [...base];
  for (const seg of relative) {
    if (seg === '..') {
      result.pop();
    } else if (seg !== '.') {
      result.push(seg);
    }
  }
  return result;
}

/**
 * Resolve an Ayran path to an actual storage path.
 *
 * @param parsed - The parsed Ayran path
 * @param notebookRootPath - Absolute path to the notebook root on storage
 * @param currentNotePath - Current note path relative to notebook root (e.g., "999/998")
 * @param currentDirPath - Current directory path for file-relative resolution
 * @param provider - Storage provider for path joining
 */
export function resolveAyranPath(
  parsed: ParsedAyranPath,
  notebookRootPath: string,
  currentNotePath: string,
  currentDirPath: string,
): ResolvedPath {
  const rootSegments = notebookRootPath.split('/').filter(Boolean);
  const currentNoteSegments = currentNotePath.split('/').filter(Boolean);
  const currentDirSegments = currentDirPath.split('/').filter(Boolean);

  switch (parsed.type) {
    case AyranPathType.External:
      return { storagePath: parsed.raw, isNote: false };

    case AyranPathType.NoteAbsolute: {
      const noteSegments = (parsed.notePath ?? '').split('/').filter(Boolean);
      const resolved = resolvePathSegments(rootSegments, noteSegments);
      return { storagePath: '/' + resolved.join('/'), isNote: true };
    }

    case AyranPathType.NoteRelative: {
      const noteSegments = (parsed.notePath ?? '').split('/').filter(Boolean);
      const base = [...rootSegments, ...currentNoteSegments];
      const resolved = resolvePathSegments(base, noteSegments);
      return { storagePath: '/' + resolved.join('/'), isNote: true };
    }

    case AyranPathType.FileAbsolute: {
      const fileSegments = (parsed.filePath ?? '').split('/').filter(Boolean);
      const resolved = resolvePathSegments(rootSegments, fileSegments);
      return { storagePath: '/' + resolved.join('/'), isNote: false };
    }

    case AyranPathType.FileRelative:
    case AyranPathType.PlainRelative: {
      const fileSegments = (parsed.filePath ?? '').split('/').filter(Boolean);
      const resolved = resolvePathSegments(currentDirSegments, fileSegments);
      return { storagePath: '/' + resolved.join('/'), isNote: false };
    }

    case AyranPathType.NoteFile: {
      // Resolve the note path first, then resolve file within note's [note-files] folder
      const noteSegments = (parsed.notePath ?? '').split('/').filter(Boolean);
      const base = parsed.noteRelative
        ? [...rootSegments, ...currentNoteSegments]
        : rootSegments;
      const resolvedNote = resolvePathSegments(base, noteSegments);
      // File path is relative to the note's [note-files] short folder
      const fileSegments = (parsed.filePath ?? '').split('/').filter(Boolean);
      const resolvedFile = resolvePathSegments(resolvedNote, fileSegments);
      return { storagePath: '/' + resolvedFile.join('/'), isNote: false };
    }

    default:
      return { storagePath: parsed.raw, isNote: false };
  }
}

/**
 * Check if a URL string is an Ayran path (starts with | or ||).
 */
export function isAyranPath(url: string): boolean {
  return url.startsWith('||') || url.startsWith('|/') || url.startsWith('|./');
}
