/** Prefilled into a note's content when it's first created: an empty primary heading. */
export const NEW_NOTE_TEMPLATE = '# ';

/** True when content is empty, or is just the untouched new-note heading template. */
export function isEffectivelyEmpty(content: string): boolean {
  const trimmed = content.trim();
  return trimmed === '' || trimmed === '#';
}
