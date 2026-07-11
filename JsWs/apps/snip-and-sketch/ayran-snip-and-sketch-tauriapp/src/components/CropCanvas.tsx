import { useEffect, useRef, useState, useCallback } from "react";
import type { Rect } from "../lib/types";
import { applyHandleDelta, type HandleId } from "../lib/geometry";

interface CropCanvasProps {
  imageDataUrl: string;
  rect: Rect;
  onRectChange: (rect: Rect) => void;
  onImageSize: (w: number, h: number) => void;
  naturalWidth: number;
  naturalHeight: number;
}

const HANDLES: { id: HandleId; className: string }[] = [
  { id: "nw", className: "-top-1.5 -left-1.5 cursor-nwse-resize" },
  { id: "n", className: "-top-1.5 left-1/2 -translate-x-1/2 cursor-ns-resize" },
  { id: "ne", className: "-top-1.5 -right-1.5 cursor-nesw-resize" },
  { id: "e", className: "top-1/2 -right-1.5 -translate-y-1/2 cursor-ew-resize" },
  { id: "se", className: "-bottom-1.5 -right-1.5 cursor-nwse-resize" },
  { id: "s", className: "-bottom-1.5 left-1/2 -translate-x-1/2 cursor-ns-resize" },
  { id: "sw", className: "-bottom-1.5 -left-1.5 cursor-nesw-resize" },
  { id: "w", className: "top-1/2 -left-1.5 -translate-y-1/2 cursor-ew-resize" },
];

export function CropCanvas({
  imageDataUrl,
  rect,
  onRectChange,
  onImageSize,
  naturalWidth,
  naturalHeight,
}: CropCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [displaySize, setDisplaySize] = useState({ w: 0, h: 0 });
  const dragState = useRef<{
    handle: HandleId;
    startX: number;
    startY: number;
    startRect: Rect;
  } | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !naturalWidth || !naturalHeight) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const availW = entry.contentRect.width;
      const availH = entry.contentRect.height;
      const scale = Math.min(availW / naturalWidth, availH / naturalHeight, 1);
      setDisplaySize({
        w: naturalWidth * scale,
        h: naturalHeight * scale,
      });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [naturalWidth, naturalHeight]);

  const scale = displaySize.w && naturalWidth ? displaySize.w / naturalWidth : 1;

  const handlePointerDown = useCallback(
    (handle: HandleId) => (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      (e.target as Element).setPointerCapture(e.pointerId);
      dragState.current = {
        handle,
        startX: e.clientX,
        startY: e.clientY,
        startRect: rect,
      };
    },
    [rect],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      const drag = dragState.current;
      if (!drag || scale === 0) return;
      const dx = (e.clientX - drag.startX) / scale;
      const dy = (e.clientY - drag.startY) / scale;
      const next = applyHandleDelta(
        drag.startRect,
        drag.handle,
        dx,
        dy,
        naturalWidth,
        naturalHeight,
      );
      onRectChange(next);
    },
    [scale, naturalWidth, naturalHeight, onRectChange],
  );

  const handlePointerUp = useCallback(() => {
    dragState.current = null;
  }, []);

  return (
    <div
      ref={containerRef}
      className="relative flex h-full w-full items-center justify-center overflow-hidden bg-neutral-900/5 dark:bg-black/40"
    >
      <div
        className="relative"
        style={{ width: displaySize.w, height: displaySize.h }}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        <img
          src={imageDataUrl}
          alt="Editing"
          draggable={false}
          className="pointer-events-none block h-full w-full select-none"
          onLoad={(e) => {
            const img = e.currentTarget;
            onImageSize(img.naturalWidth, img.naturalHeight);
          }}
        />
        {/* dim area outside the crop rect */}
        <div className="pointer-events-none absolute inset-0 bg-black/50" />
        <div
          className="absolute cursor-move touch-none overflow-hidden border-2 border-accent-500"
          style={{
            left: rect.x * scale,
            top: rect.y * scale,
            width: rect.w * scale,
            height: rect.h * scale,
          }}
          onPointerDown={handlePointerDown("move")}
        >
          <img
            src={imageDataUrl}
            alt=""
            draggable={false}
            className="pointer-events-none absolute select-none"
            style={{
              left: -rect.x * scale,
              top: -rect.y * scale,
              width: displaySize.w,
              height: displaySize.h,
              maxWidth: "none",
            }}
          />
          {HANDLES.map((h) => (
            <div
              key={h.id}
              className={`absolute h-3 w-3 touch-none rounded-full border border-accent-600 bg-white ${h.className}`}
              onPointerDown={handlePointerDown(h.id)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
