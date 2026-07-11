import type { Rect } from "./types";

export const MIN_RECT_SIZE = 16;

export function clampRect(rect: Rect, boundsW: number, boundsH: number): Rect {
  let w = Math.min(Math.max(rect.w, MIN_RECT_SIZE), boundsW);
  let h = Math.min(Math.max(rect.h, MIN_RECT_SIZE), boundsH);
  let x = Math.min(Math.max(rect.x, 0), boundsW - w);
  let y = Math.min(Math.max(rect.y, 0), boundsH - h);
  return { x, y, w, h };
}

export function defaultRect(boundsW: number, boundsH: number): Rect {
  const w = Math.round(boundsW * 0.7);
  const h = Math.round(boundsH * 0.7);
  return {
    x: Math.round((boundsW - w) / 2),
    y: Math.round((boundsH - h) / 2),
    w,
    h,
  };
}

export type HandleId =
  | "move"
  | "n"
  | "s"
  | "e"
  | "w"
  | "ne"
  | "nw"
  | "se"
  | "sw";

/**
 * Applies a pointer delta (in image-space pixels) to a rect being dragged via the given handle,
 * then clamps the result to the image bounds.
 */
export function applyHandleDelta(
  original: Rect,
  handle: HandleId,
  dx: number,
  dy: number,
  boundsW: number,
  boundsH: number,
): Rect {
  let { x, y, w, h } = original;
  const x2 = x + w;
  const y2 = y + h;

  if (handle === "move") {
    x = original.x + dx;
    y = original.y + dy;
    return clampRect({ x, y, w, h }, boundsW, boundsH);
  }

  let newX = x;
  let newY = y;
  let newX2 = x2;
  let newY2 = y2;

  if (handle.includes("n")) newY = y + dy;
  if (handle.includes("s")) newY2 = y2 + dy;
  if (handle.includes("w")) newX = x + dx;
  if (handle.includes("e")) newX2 = x2 + dx;

  // Prevent inversion by clamping edges relative to their opposite edge.
  newX = Math.min(newX, newX2 - MIN_RECT_SIZE);
  newY = Math.min(newY, newY2 - MIN_RECT_SIZE);
  newX2 = Math.max(newX2, newX + MIN_RECT_SIZE);
  newY2 = Math.max(newY2, newY + MIN_RECT_SIZE);

  newX = Math.max(newX, 0);
  newY = Math.max(newY, 0);
  newX2 = Math.min(newX2, boundsW);
  newY2 = Math.min(newY2, boundsH);

  return clampRect(
    { x: newX, y: newY, w: newX2 - newX, h: newY2 - newY },
    boundsW,
    boundsH,
  );
}

export function formatRectName(rect: Rect): string {
  const r = (n: number) => Math.round(n);
  return `(${r(rect.x)}, ${r(rect.y)}) → (${r(rect.x + rect.w)}, ${r(rect.y + rect.h)})`;
}
