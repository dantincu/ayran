import { useEffect, useState } from "react";
import { CropCanvas } from "./CropCanvas";
import { SaveCropModal } from "./SaveCropModal";
import { LoadCropModal } from "./LoadCropModal";
import type { AppState, Rect, SavedCrop } from "../lib/types";
import { saveAppState, putSavedCrop } from "../lib/db";
import { cropImage, loadImageElement } from "../lib/imageOps";
import { clampRect, defaultRect } from "../lib/geometry";
import { saveImageDataUrl } from "../lib/fileOps";

interface EditorProps {
  appState: AppState;
  onAppStateChange: (state: AppState) => void;
  onStartOver: () => void;
}

export function Editor({ appState, onAppStateChange, onStartOver }: EditorProps) {
  const [naturalSize, setNaturalSize] = useState({ w: 0, h: 0 });
  const [rect, setRect] = useState<Rect | null>(null);
  const [showSaveCrop, setShowSaveCrop] = useState(false);
  const [showLoadCrop, setShowLoadCrop] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // Preload the image (outside CropCanvas) so we know its dimensions before mounting
  // the crop overlay, which otherwise needs a rect to render in the first place.
  useEffect(() => {
    let cancelled = false;
    setRect(null);
    setNaturalSize({ w: 0, h: 0 });
    if (!appState.currentImageDataUrl) return;
    loadImageElement(appState.currentImageDataUrl).then((img) => {
      if (cancelled) return;
      setNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
      setRect(defaultRect(img.naturalWidth, img.naturalHeight));
    });
    return () => {
      cancelled = true;
    };
  }, [appState.currentImageDataUrl]);

  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => setMessage(null), 2500);
    return () => clearTimeout(t);
  }, [message]);

  if (!appState.currentImageDataUrl) return null;

  async function applyCrop() {
    if (!rect || !appState.currentImageDataUrl) return;
    setBusy(true);
    try {
      const cropped = await cropImage(appState.currentImageDataUrl, rect);
      const nextState: AppState = {
        ...appState,
        currentImageDataUrl: cropped,
        history: [
          ...appState.history,
          { rect, previousImageDataUrl: appState.currentImageDataUrl },
        ],
      };
      await saveAppState(nextState);
      onAppStateChange(nextState);
    } finally {
      setBusy(false);
    }
  }

  async function undoCrop() {
    if (appState.history.length === 0) return;
    const last = appState.history[appState.history.length - 1];
    const nextState: AppState = {
      ...appState,
      currentImageDataUrl: last.previousImageDataUrl,
      history: appState.history.slice(0, -1),
    };
    await saveAppState(nextState);
    onAppStateChange(nextState);
  }

  async function handleSaveImage() {
    if (!appState.currentImageDataUrl) return;
    setBusy(true);
    try {
      const suggested = appState.imageName
        ? appState.imageName.replace(/\.[^.]+$/, "") + "-cropped.png"
        : "cropped.png";
      const path = await saveImageDataUrl(appState.currentImageDataUrl, suggested);
      if (path) setMessage(`Saved to ${path}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveCropCoords(name: string) {
    if (!rect) return;
    const crop: SavedCrop = {
      id: crypto.randomUUID(),
      name,
      rect,
      sourceWidth: naturalSize.w,
      sourceHeight: naturalSize.h,
      createdAt: Date.now(),
    };
    await putSavedCrop(crop);
    setShowSaveCrop(false);
    setMessage("Crop coordinates saved");
  }

  function handleApplySavedCrop(crop: SavedCrop) {
    if (naturalSize.w && naturalSize.h) {
      setRect(clampRect(crop.rect, naturalSize.w, naturalSize.h));
    }
    setShowLoadCrop(false);
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b border-neutral-200 px-4 py-2 dark:border-neutral-700">
        <button
          onClick={onStartOver}
          className="rounded px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-700"
        >
          ← New Image
        </button>
        <div className="mx-1 h-5 w-px bg-neutral-200 dark:bg-neutral-700" />
        <button
          disabled={busy || !rect}
          onClick={applyCrop}
          className="rounded bg-accent-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-600 disabled:opacity-50"
        >
          Apply Crop
        </button>
        <button
          disabled={appState.history.length === 0}
          onClick={undoCrop}
          className="rounded px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100 disabled:opacity-40 dark:text-neutral-300 dark:hover:bg-neutral-700"
        >
          Undo Crop
        </button>
        <div className="mx-1 h-5 w-px bg-neutral-200 dark:bg-neutral-700" />
        <button
          disabled={!rect}
          onClick={() => setShowSaveCrop(true)}
          className="rounded px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-700"
        >
          Save Crop Coordinates
        </button>
        <button
          onClick={() => setShowLoadCrop(true)}
          className="rounded px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-700"
        >
          Load Saved Crop
        </button>
        <div className="flex-1" />
        <button
          disabled={busy}
          onClick={handleSaveImage}
          className="rounded bg-neutral-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
        >
          Save Image
        </button>
      </header>

      {message && (
        <div className="border-b border-accent-500/30 bg-accent-500/10 px-4 py-1.5 text-sm text-accent-600">
          {message}
        </div>
      )}

      <div className="min-h-0 flex-1 p-4">
        {rect && (
          <CropCanvas
            imageDataUrl={appState.currentImageDataUrl}
            rect={rect}
            onRectChange={setRect}
            onImageSize={(w, h) => setNaturalSize({ w, h })}
            naturalWidth={naturalSize.w}
            naturalHeight={naturalSize.h}
          />
        )}
      </div>

      {showSaveCrop && rect && (
        <SaveCropModal
          rect={rect}
          onSave={handleSaveCropCoords}
          onClose={() => setShowSaveCrop(false)}
        />
      )}
      {showLoadCrop && (
        <LoadCropModal
          onApply={handleApplySavedCrop}
          onClose={() => setShowLoadCrop(false)}
        />
      )}
    </div>
  );
}
