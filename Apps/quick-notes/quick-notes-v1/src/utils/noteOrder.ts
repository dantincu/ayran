import type { Note } from '../types';

export function sortByDefaultOrder(notes: Note[]): Note[] {
  return [...notes].sort((a, b) => b.createdAt - a.createdAt);
}

export function sortByCustomOrder(notes: Note[]): Note[] {
  return [...notes].sort((a, b) => a.order - b.order);
}

/**
 * Removes `movingIds` (a contiguous drag group, in their current relative
 * order) from `orderedIds` and reinserts them as a block just before the
 * item that was originally at `insertBeforeIndex` (index === length means
 * "at the very end"). Used for drag-and-drop drop targets.
 */
export function moveGroup(orderedIds: string[], movingIds: string[], insertBeforeIndex: number): string[] {
  const movingSet = new Set(movingIds);
  const moving = orderedIds.filter((id) => movingSet.has(id));
  const rest = orderedIds.filter((id) => !movingSet.has(id));
  const removedBefore = orderedIds.slice(0, insertBeforeIndex).filter((id) => movingSet.has(id)).length;
  const adjustedIndex = insertBeforeIndex - removedBefore;
  return [...rest.slice(0, adjustedIndex), ...moving, ...rest.slice(adjustedIndex)];
}

/**
 * Moves every selected item one step in the given direction, preserving
 * relative order within the selection and handling disjoint selections
 * correctly (each run bubbles past its own nearest unselected neighbor).
 */
export function moveSelectedBy1(orderedIds: string[], selectedIds: Set<string>, direction: -1 | 1): string[] {
  const ids = [...orderedIds];
  if (direction === -1) {
    for (let i = 1; i < ids.length; i++) {
      if (selectedIds.has(ids[i]) && !selectedIds.has(ids[i - 1])) {
        [ids[i - 1], ids[i]] = [ids[i], ids[i - 1]];
      }
    }
  } else {
    for (let i = ids.length - 2; i >= 0; i--) {
      if (selectedIds.has(ids[i]) && !selectedIds.has(ids[i + 1])) {
        [ids[i], ids[i + 1]] = [ids[i + 1], ids[i]];
      }
    }
  }
  return ids;
}
