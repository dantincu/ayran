import { useState, useCallback } from 'react';
import type { RefObject, MouseEvent as RMouseEvent } from 'react';

export interface DragPos { x: number; y: number; w: number }

/** Enables panel dragging by mouse-down on the header. Constrained to viewport. */
export function useDraggable(
  panelRef: RefObject<HTMLElement | null>,
  disabled: boolean,
): {
  dragPos: DragPos | null;
  setDragPos: React.Dispatch<React.SetStateAction<DragPos | null>>;
  onHeaderMouseDown: (e: RMouseEvent) => void;
} {
  const [dragPos, setDragPos] = useState<DragPos | null>(null);

  const onHeaderMouseDown = useCallback(
    (e: RMouseEvent) => {
      if (disabled || (e.target as Element).closest?.('button')) return;
      e.preventDefault();
      const el = panelRef.current;
      if (!el) return;
      const { left, top, width, height } = el.getBoundingClientRect();
      const sx = e.clientX;
      const sy = e.clientY;

      const onMove = (ev: MouseEvent) => {
        const nx = Math.max(0, Math.min(left + ev.clientX - sx, window.innerWidth - width));
        const ny = Math.max(0, Math.min(top + ev.clientY - sy, window.innerHeight - height));
        setDragPos({ x: nx, y: ny, w: width });
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
      setDragPos({ x: left, y: top, w: width });
    },
    [disabled, panelRef],
  );

  return { dragPos, setDragPos, onHeaderMouseDown };
}
