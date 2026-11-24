/** Pure list operations behind the arrows and drag and drop. */

/** Moves every selected item one step up; a selected item already at the top (or under one that is) stays. */
export function moveUp<T>(items: T[], isSelected: (item: T) => boolean): T[] {
  const out = items.slice()
  for (let i = 1; i < out.length; i++) {
    if (isSelected(out[i]) && !isSelected(out[i - 1])) [out[i - 1], out[i]] = [out[i], out[i - 1]]
  }
  return out
}

export function moveDown<T>(items: T[], isSelected: (item: T) => boolean): T[] {
  return moveUp(items.slice().reverse(), isSelected).reverse()
}

/**
 * Moves the `moving` items, keeping their relative order, into the gap `gap` of the original list
 * (0 = before the first item, `items.length` = after the last).
 */
export function moveBlock<T>(items: T[], isMoving: (item: T) => boolean, gap: number): T[] {
  const moving = items.filter(isMoving)
  const rest = items.filter((it) => !isMoving(it))
  const at = items.slice(0, gap).filter((it) => !isMoving(it)).length
  return [...rest.slice(0, at), ...moving, ...rest.slice(at)]
}

/** The items from `a` to `b` (either order), inclusive. */
export function rangeBetween<T>(items: T[], a: number, b: number): T[] {
  return items.slice(Math.min(a, b), Math.max(a, b) + 1)
}

export function sameOrder<T>(a: T[], b: T[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i])
}
