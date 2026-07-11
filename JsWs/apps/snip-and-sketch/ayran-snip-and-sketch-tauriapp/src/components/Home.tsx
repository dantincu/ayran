import { useState } from "react";
import type { AppState } from "../lib/types";
import { saveAppState } from "../lib/db";
import { isTauriRuntime, pickImageFile, pickImageFileBrowser, takeScreenshot } from "../lib/fileOps";

export function Home({ onReady }: { onReady: (state: AppState) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleOpenImage() {
    setError(null);
    setBusy(true);
    try {
      const picked = isTauriRuntime() ? await pickImageFile() : await pickImageFileBrowser();
      if (!picked) return;
      const state: AppState = {
        id: "current",
        imageName: picked.name,
        currentImageDataUrl: picked.dataUrl,
        history: [],
      };
      await saveAppState(state);
      onReady(state);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleTakeScreenshot() {
    setError(null);
    setBusy(true);
    try {
      const dataUrl = await takeScreenshot();
      const state: AppState = {
        id: "current",
        imageName: "screenshot.png",
        currentImageDataUrl: dataUrl,
        history: [],
      };
      await saveAppState(state);
      onReady(state);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 p-6 text-center">
      <div>
        <h1 className="text-2xl font-semibold text-neutral-900 dark:text-neutral-100">
          Snip &amp; Sketch
        </h1>
        <p className="mt-1 text-neutral-500">Crop an image or capture a screenshot to get started</p>
      </div>
      <div className="flex flex-col gap-3 sm:flex-row">
        <button
          disabled={busy}
          onClick={handleOpenImage}
          className="rounded-lg bg-accent-500 px-5 py-3 font-medium text-white hover:bg-accent-600 disabled:opacity-50"
        >
          Open Image…
        </button>
        <button
          disabled={busy}
          onClick={handleTakeScreenshot}
          className="rounded-lg border border-neutral-300 px-5 py-3 font-medium text-neutral-800 hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-600 dark:text-neutral-100 dark:hover:bg-neutral-800"
        >
          Take Screenshot
        </button>
      </div>
      {error && <p className="max-w-sm text-sm text-red-500">{error}</p>}
    </div>
  );
}
