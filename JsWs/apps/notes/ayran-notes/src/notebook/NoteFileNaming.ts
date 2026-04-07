/**
 * Pure functions for converting note titles to file/folder names per spec.
 */

const INVALID_FILENAME_CHARS = /[<>:"/\\|?*\x00-\x1f]/g;
const CONSECUTIVE_SPACES = /  +/g;
const MARKDOWN_SPECIAL = /([\\`*_[\]()#!|>~])/g;

export class TitleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TitleValidationError';
  }
}

/**
 * Validate and sanitize a note title.
 * Throws TitleValidationError if the title contains invalid characters or is too long.
 */
export function validateTitle(title: string): void {
  if (title !== title.trim()) {
    throw new TitleValidationError('Title must not have leading or trailing whitespace.');
  }
  if (/[\t\n\r]/.test(title)) {
    throw new TitleValidationError(
      'Title must not contain tab, newline, or carriage return characters.',
    );
  }
  if (title.length === 0) {
    throw new TitleValidationError('Title must not be empty.');
  }
  if (title.length > 1000) {
    throw new TitleValidationError('Title must not exceed 1000 characters.');
  }
}

/**
 * Convert a note title to a file-system-safe string for use in folder names.
 * - Replace invalid filename chars with space
 * - Collapse consecutive spaces
 * - Trim result
 */
export function titleToFolderSafeName(title: string): string {
  let safe = title.replace(INVALID_FILENAME_CHARS, ' ');
  safe = safe.replace(CONSECUTIVE_SPACES, ' ');
  safe = safe.trim();
  return safe;
}

/**
 * Build the short name folder for a note (just the 3-digit index, zero-padded).
 */
export function buildShortName(index: number): string {
  return String(index).padStart(3, '0');
}

/**
 * Build the full name folder for a note: "{index}-{sanitized-title}", max 100 chars for this part.
 */
export function buildFullName(index: number, title: string): string {
  const indexPart = buildShortName(index);
  const safeName = titleToFolderSafeName(title);
  const combined = `${indexPart}-${safeName}`;
  // Truncate to 100 chars
  return combined.substring(0, 100);
}

/**
 * Build the markdown filename: "0-{sanitized-title}[note].md"
 */
export function buildMdFileName(title: string): string {
  const safeName = titleToFolderSafeName(title);
  const withSuffix = `0-${safeName}[note].md`;
  // The title part can be truncated to fit within 100 chars for the derived portion
  return withSuffix;
}

/**
 * Build the HTML filename from the markdown filename.
 */
export function buildHtmlFileName(mdFileName: string): string {
  return `${mdFileName}.html`;
}

/**
 * Build the PDF filename from the markdown filename.
 */
export function buildPdfFileName(mdFileName: string): string {
  return `${mdFileName}.pdf`;
}

/**
 * Encode a title for use as a markdown heading (# Title).
 * Escapes special markdown characters.
 */
export function encodeMarkdownTitle(title: string): string {
  return title.replace(MARKDOWN_SPECIAL, '\\$1');
}

/**
 * Build the initial markdown content for a new note.
 */
export function buildInitialNoteMarkdown(title: string): string {
  return `# ${encodeMarkdownTitle(title)}\n`;
}

/**
 * Extract the title from the first line of a markdown file if it is a heading.
 * Returns null if the first line is not a heading.
 */
export function extractMarkdownTitle(content: string): string | null {
  const firstLine = content.split('\n')[0] ?? '';
  const match = firstLine.match(/^#\s+(.+)$/);
  if (!match) return null;
  // Unescape markdown special characters in the title
  return match[1].replace(/\\([\\`*_[\]()#!|>~])/g, '$1');
}

/**
 * Update the markdown title line in content with a new title.
 * If the first line is not a heading, prepend one.
 */
export function updateMarkdownTitle(content: string, newTitle: string): string {
  const lines = content.split('\n');
  const newHeading = `# ${encodeMarkdownTitle(newTitle)}`;
  if (lines[0]?.match(/^#\s+/)) {
    lines[0] = newHeading;
  } else {
    lines.unshift(newHeading);
  }
  return lines.join('\n');
}
