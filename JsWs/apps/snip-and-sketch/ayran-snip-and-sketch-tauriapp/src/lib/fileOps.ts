import { open, save } from "@tauri-apps/plugin-dialog";
import { readFile, writeFile } from "@tauri-apps/plugin-fs";
import { invoke } from "@tauri-apps/api/core";
import { fileToDataUrl, dataUrlToBytes } from "./imageOps";

const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "bmp", "gif"];

function bytesToDataUrl(bytes: Uint8Array, mime: string): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

function guessMime(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "bmp":
      return "image/bmp";
    case "gif":
      return "image/gif";
    default:
      return "image/png";
  }
}

/** Opens the native file picker and returns the picked image as a data URL, or null if cancelled. */
export async function pickImageFile(): Promise<{ name: string; dataUrl: string } | null> {
  const selected = await open({
    multiple: false,
    filters: [{ name: "Images", extensions: IMAGE_EXTENSIONS }],
  });
  if (!selected || Array.isArray(selected)) return null;

  const bytes = await readFile(selected);
  const name = selected.split(/[\\/]/).pop() ?? "image.png";
  const dataUrl = bytesToDataUrl(bytes, guessMime(selected));
  return { name, dataUrl };
}

/** Fallback for browser-only dev/testing: plain <input type="file"> + FileReader. */
export async function pickImageFileBrowser(): Promise<{ name: string; dataUrl: string } | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      const dataUrl = await fileToDataUrl(file);
      resolve({ name: file.name, dataUrl });
    };
    input.click();
  });
}

/** Opens a save dialog and writes the given data URL to disk as an image file. */
export async function saveImageDataUrl(dataUrl: string, suggestedName: string): Promise<string | null> {
  const path = await save({
    defaultPath: suggestedName,
    filters: [{ name: "PNG Image", extensions: ["png"] }],
  });
  if (!path) return null;
  await writeFile(path, dataUrlToBytes(dataUrl));
  return path;
}

export function isTauriRuntime(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

function isAndroidRuntime(): boolean {
  return /android/i.test(navigator.userAgent);
}

/**
 * Captures the full screen and returns a data URL.
 *
 * - Desktop: hides the app window, captures via the Rust `capture_screenshot` command, restores the window.
 * - Android: requests one-time MediaProjection consent, backgrounds the app so the capture reflects
 *   whatever the user switches to, then brings the app back to front (see the `screen-capture` plugin).
 */
export async function takeScreenshot(): Promise<string> {
  if (isAndroidRuntime()) {
    const { base64Png } = await invoke<{ base64Png: string }>("plugin:screen-capture|capture");
    return `data:image/png;base64,${base64Png}`;
  }
  const base64Png = await invoke<string>("capture_screenshot");
  return `data:image/png;base64,${base64Png}`;
}
