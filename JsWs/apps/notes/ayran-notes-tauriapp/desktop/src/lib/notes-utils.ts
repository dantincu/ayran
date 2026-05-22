import nc from '../notesConfig.json';

// ── Name computation ─────────────────────────────────────────────────────────

/** Remove characters that are invalid in folder names on common filesystems.
 *  Forward slash is replaced by '%' as specified; all other invalid chars are removed. */
export function sanitizeForFolderName(title: string): string {
  return title
    .replace(/\//g, '%')                    // / → %
    .replace(/[\\<>:"|?*\x00-\x1f]/g, '')  // other invalid chars removed
    .trim()
    .slice(0, nc.maxFullNamePartLength);
}

/** The part of the full folder name that comes after the join string. */
export function computeFullNamePart(title: string): string {
  return sanitizeForFolderName(title);
}

export function computeShortFolderName(digits: string): string {
  return nc.shortNamePrefix + digits;
}

export function computeFullFolderName(digits: string, title: string): string {
  return `${computeShortFolderName(digits)}${nc.fullNameJoinString}${computeFullNamePart(title)}`;
}

export function computeMarkdownFileName(fullNamePart: string): string {
  return `${nc.noteMarkdownPrefix}${fullNamePart}${nc.noteMarkdownSuffix}`;
}

export function computeHtmlFileName(fullNamePart: string): string {
  return `${nc.noteMarkdownPrefix}${fullNamePart}${nc.noteHtmlSuffix}`;
}

export function computePdfFileName(fullNamePart: string): string {
  return `${nc.noteMarkdownPrefix}${fullNamePart}${nc.notePdfSuffix}`;
}

// ── Note detection ───────────────────────────────────────────────────────────

/** Returns true when the folder name is a valid note short name (prefix + digits only). */
export function isNoteShortFolder(name: string): boolean {
  const withoutPrefix = nc.shortNamePrefix
    ? name.startsWith(nc.shortNamePrefix) ? name.slice(nc.shortNamePrefix.length) : null
    : name;
  if (withoutPrefix === null) return false;
  return /^\d+$/.test(withoutPrefix);
}

/** Extracts the digits part from a short folder name. Returns null when not a match. */
export function extractDigits(name: string): string | null {
  if (!isNoteShortFolder(name)) return null;
  return nc.shortNamePrefix ? name.slice(nc.shortNamePrefix.length) : name;
}

/**
 * Extracts the digits part from a full folder name (e.g. "110-My Note" → "110").
 * Returns null when the name is not a valid full folder name.
 * A full folder name starts with a short folder name followed by the fullNameJoinString.
 */
export function extractDigitsFromFullFolderName(name: string): string | null {
  const joinStr = nc.fullNameJoinString;
  if (!joinStr) return null;
  const idx = name.indexOf(joinStr);
  if (idx < 0) return null;
  return extractDigits(name.substring(0, idx));
}

// ── Short name generation ────────────────────────────────────────────────────

/** Computes the next sequential short name (numeric, 1-based) given existing digit strings. */
export function nextDigits(existingDigits: string[]): string {
  if (existingDigits.length === 0) return '1';
  const max = Math.max(...existingDigits.map((d) => parseInt(d, 10) || 0));
  return String(max + 1);
}

/** Returns true when `n` falls within any configured note interval. */
export function isValidNoteNumber(n: number): boolean {
  return nc.noteIntervals.some(({ lo, hi }) => n >= lo && n <= hi);
}

/**
 * Computes the next available index within [lo, hi] by decrementing from the
 * current minimum.  Returns null when the interval is full.
 */
export function nextDigitsInInterval(existingDigits: string[], lo: number, hi: number): string | null {
  const nums = existingDigits.map((d) => parseInt(d, 10)).filter((n) => n >= lo && n <= hi);
  const next = nums.length === 0 ? hi : Math.min(...nums) - 1;
  return next >= lo ? String(next) : null;
}

// ── File content helpers ─────────────────────────────────────────────────────

/** Initial markdown content for a new note. */
export function initialMarkdownContent(title: string): string {
  const escaped = title.replace(/[\\`*_[\]]/g, '\\$&');
  return `# ${escaped}\n`;
}

/** `[note].json` content for a newly created note. */
export function noteJsonContent(title: string): string {
  return JSON.stringify({ Title: title, CreatedAt: new Date().toISOString() }, null, 2);
}

/** Sets `UpdatedAt` on an existing entry in a `[note-children].json` string without touching other fields. */
export function updateNoteUpdatedAt(existing: string, digits: string, updatedAt: string): string {
  let data: { ChildNotes: Record<string, { Title: string; CreatedAt: string; UpdatedAt?: string }> };
  try {
    data = JSON.parse(existing) as typeof data;
  } catch {
    return existing;
  }
  if (data.ChildNotes?.[digits]) {
    data.ChildNotes[digits].UpdatedAt = updatedAt;
  }
  return JSON.stringify(data, null, 2);
}

/** Merges a new note entry into an existing `[note-children].json` string (or creates fresh). */
export function addNoteToChildrenJson(
  existing: string | null,
  digits: string,
  title: string,
  updatedAt?: string,
): string {
  let data: { ChildNotes: Record<string, { Title: string; CreatedAt: string; UpdatedAt?: string }> };
  try {
    data = existing ? (JSON.parse(existing) as typeof data) : { ChildNotes: {} };
  } catch {
    data = { ChildNotes: {} };
  }
  data.ChildNotes ??= {};
  const entry: { Title: string; CreatedAt: string; UpdatedAt?: string } = {
    Title: title,
    CreatedAt: new Date().toISOString(),
  };
  if (updatedAt) entry.UpdatedAt = updatedAt;
  data.ChildNotes[digits] = entry;
  return JSON.stringify(data, null, 2);
}

// ── Local-fs path helpers ────────────────────────────────────────────────────

const SEP = navigator.platform.startsWith('Win') ? '\\' : '/';

export function toAbsPath(accountRoot: string, relPath: string): string {
  if (!relPath) return accountRoot;
  return `${accountRoot}${SEP}${relPath.replace(/\//g, SEP)}`;
}

export function joinRelPath(...parts: string[]): string {
  return parts.filter(Boolean).join('/');
}
