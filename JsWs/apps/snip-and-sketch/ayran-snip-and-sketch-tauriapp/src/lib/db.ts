import { openDB, type IDBPDatabase } from "idb";
import type { AppState, SavedCrop } from "./types";

const DB_NAME = "ayran-snip-and-sketch";
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDb() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains("appState")) {
          db.createObjectStore("appState", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("savedCrops")) {
          db.createObjectStore("savedCrops", { keyPath: "id" });
        }
      },
    });
  }
  return dbPromise;
}

export const EMPTY_APP_STATE: AppState = {
  id: "current",
  imageName: null,
  currentImageDataUrl: null,
  history: [],
};

export async function loadAppState(): Promise<AppState> {
  const db = await getDb();
  const state = await db.get("appState", "current");
  return state ?? EMPTY_APP_STATE;
}

export async function saveAppState(state: AppState): Promise<void> {
  const db = await getDb();
  await db.put("appState", state);
}

export async function clearAppState(): Promise<void> {
  const db = await getDb();
  await db.delete("appState", "current");
}

export async function listSavedCrops(): Promise<SavedCrop[]> {
  const db = await getDb();
  const all = await db.getAll("savedCrops");
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export async function putSavedCrop(crop: SavedCrop): Promise<void> {
  const db = await getDb();
  await db.put("savedCrops", crop);
}

export async function deleteSavedCrop(id: string): Promise<void> {
  const db = await getDb();
  await db.delete("savedCrops", id);
}
