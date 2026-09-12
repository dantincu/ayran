const ATX_H1 = /^#(?!#)\s+(.+?)\s*#*\s*$/;
const SETEXT_H1 = /^=+\s*$/;

/**
 * Finds the markdown primary heading (H1) and returns its plain text,
 * stripped of markdown emphasis/link/code markup. Returns '' when no H1 exists.
 */
export function deriveTitle(markdown: string): string {
  const lines = markdown.split(/\r\n|\r|\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const atx = ATX_H1.exec(line);
    if (atx) {
      return cleanInline(atx[1]);
    }

    // Setext H1: a non-blank line followed by a line of '=' characters.
    if (i + 1 < lines.length && SETEXT_H1.test(lines[i + 1]) && line.trim().length > 0) {
      return cleanInline(line.trim());
    }
  }

  return '';
}

function cleanInline(text: string): string {
  return text
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .trim();
}
