import { NoteCategory, NoteIndexRange, NoteChildrenJson } from '../types/note.types';
import constants from '../../config/app-constants.json';

export class NoteIndexLimitError extends Error {
  constructor(public readonly category: NoteCategory) {
    const range = constants.noteIndexRanges[category] as NoteIndexRange;
    super(
      `Cannot create more than ${range.maxCount} ${category} notes in a single list.`,
    );
    this.name = 'NoteIndexLimitError';
  }
}

const RANGES: Record<NoteCategory, NoteIndexRange> = constants.noteIndexRanges as Record<
  NoteCategory,
  NoteIndexRange
>;

/**
 * Get all note indexes in the given category that exist in a children JSON.
 */
export function getIndexesForCategory(
  childrenJson: NoteChildrenJson,
  category: NoteCategory,
): number[] {
  const range = RANGES[category];
  return Object.keys(childrenJson.ChildNotes)
    .map(Number)
    .filter((n) => n >= range.min && n <= range.max);
}

/**
 * Allocate the next index for a new note of the given category.
 * Throws NoteIndexLimitError if the minimum has been reached.
 */
export function allocateNextIndex(
  childrenJson: NoteChildrenJson,
  category: NoteCategory,
): number {
  const range = RANGES[category];
  const existing = getIndexesForCategory(childrenJson, category);

  if (existing.length === 0) {
    return range.max; // start at max (e.g., 999)
  }

  const minExisting = Math.min(...existing);
  const next = minExisting - 1;

  if (next < range.min) {
    throw new NoteIndexLimitError(category);
  }

  return next;
}

/**
 * Given a list of existing note indexes in a category (sorted desc by creation order),
 * return the normalized mapping: { oldIndex -> newIndex }.
 * New indexes are reassigned from max downward.
 */
export function buildNormalizationMap(
  existingIndexes: number[],
  category: NoteCategory,
): Map<number, number> {
  const range = RANGES[category];
  const sorted = [...existingIndexes].sort((a, b) => b - a); // descending
  const result = new Map<number, number>();
  let current = range.max;
  for (const oldIdx of sorted) {
    result.set(oldIdx, current);
    current--;
  }
  return result;
}

/**
 * Check if a note index belongs to a given category.
 */
export function indexToCategory(index: number): NoteCategory | null {
  for (const [cat, range] of Object.entries(RANGES) as [NoteCategory, NoteIndexRange][]) {
    if (index >= range.min && index <= range.max) return cat;
  }
  return null;
}

/**
 * Format a numeric index as a zero-padded 3-digit string.
 */
export function formatIndex(index: number): string {
  return String(index).padStart(3, '0');
}
