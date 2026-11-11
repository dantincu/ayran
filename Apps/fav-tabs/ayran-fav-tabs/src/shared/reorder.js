// Pure reordering helpers. `ids` is the current order, `selected` a Set of ids.
// All helpers return a new array and keep the relative order of selected items
// (and of unselected ones).

/**
 * Shifts every selected item by `delta` positions (negative = towards the start).
 * Items stop at the edges; selected items that reach an edge pile up behind each other
 * instead of overtaking.
 */
export function moveSelectedBy(ids, selected, delta) {
  if (!delta || !ids.some((id) => selected.has(id))) return ids.slice();
  if (delta > 0) return moveSelectedBy(ids.slice().reverse(), selected, -delta).reverse();
  const k = -delta;
  const n = ids.length;
  const out = new Array(n).fill(undefined);
  let limit = 0;
  for (let i = 0; i < n; i++) {
    if (!selected.has(ids[i])) continue;
    const pos = Math.max(i - k, limit);
    out[pos] = ids[i];
    limit = pos + 1;
  }
  let j = 0;
  for (const id of ids) {
    if (selected.has(id)) continue;
    while (out[j] !== undefined) j++;
    out[j] = id;
  }
  return out;
}

export function moveSelectedToStart(ids, selected) {
  return [...ids.filter((id) => selected.has(id)), ...ids.filter((id) => !selected.has(id))];
}

export function moveSelectedToEnd(ids, selected) {
  return [...ids.filter((id) => !selected.has(id)), ...ids.filter((id) => selected.has(id))];
}

/**
 * Moves the selected items, as one block, so it sits right before `beforeId`
 * (or at the end when `beforeId` is null). If `beforeId` is itself selected, the block goes
 * before the first unselected item that follows it.
 */
export function moveSelectedBefore(ids, selected, beforeId) {
  let anchor = beforeId;
  if (anchor != null && selected.has(anchor)) {
    const start = ids.indexOf(anchor);
    anchor = null;
    for (let i = start + 1; i < ids.length; i++) {
      if (!selected.has(ids[i])) {
        anchor = ids[i];
        break;
      }
    }
  }
  const sel = ids.filter((id) => selected.has(id));
  const rest = ids.filter((id) => !selected.has(id));
  const at = anchor == null ? rest.length : rest.indexOf(anchor);
  if (at < 0) return ids.slice();
  return [...rest.slice(0, at), ...sel, ...rest.slice(at)];
}

/** Reorders `items` (objects with .id) to follow `orderIds`; items missing from it keep their place at the end. */
export function applyOrder(items, orderIds) {
  const byId = new Map(items.map((x) => [x.id, x]));
  const out = [];
  for (const id of orderIds) {
    const x = byId.get(id);
    if (x) {
      out.push(x);
      byId.delete(id);
    }
  }
  for (const x of items) if (byId.has(x.id)) out.push(x);
  return out;
}
