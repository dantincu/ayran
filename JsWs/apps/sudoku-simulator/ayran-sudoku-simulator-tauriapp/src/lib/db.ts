import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { Board } from "./sudoku";

export interface SnapshotRecord {
  id: string;
  parentId: string | null;
  name: string;
  board: Board;
  labelColor: string | null;
  createdAt: number;
}

export interface CustomColorRecord {
  id: string;
  hex: string;
  createdAt: number;
}

export interface LiveStateRecord {
  key: "current";
  board: Board;
  currentSnapshotId: string | null;
  lastInput: { row: number; col: number; value: number } | null;
}

export interface SettingRecord {
  key: string;
  value: unknown;
}

export interface ThemeRecord {
  id: string;
  name: string;
  background: string;
  foreground: string;
  accent: string;
  createdAt: number;
}

interface SudokuDB extends DBSchema {
  snapshots: {
    key: string;
    value: SnapshotRecord;
    indexes: { parentId: string };
  };
  customColors: {
    key: string;
    value: CustomColorRecord;
  };
  liveState: {
    key: string;
    value: LiveStateRecord;
  };
  settings: {
    key: string;
    value: SettingRecord;
  };
  themes: {
    key: string;
    value: ThemeRecord;
  };
}

const DB_NAME = "ayran-sudoku";
const DB_VERSION = 3;

let dbPromise: Promise<IDBPDatabase<SudokuDB>> | null = null;

function getDb(): Promise<IDBPDatabase<SudokuDB>> {
  if (!dbPromise) {
    dbPromise = openDB<SudokuDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains("snapshots")) {
          const snapshots = db.createObjectStore("snapshots", { keyPath: "id" });
          snapshots.createIndex("parentId", "parentId");
        }
        if (!db.objectStoreNames.contains("customColors")) {
          db.createObjectStore("customColors", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("liveState")) {
          db.createObjectStore("liveState", { keyPath: "key" });
        }
        if (!db.objectStoreNames.contains("settings")) {
          db.createObjectStore("settings", { keyPath: "key" });
        }
        if (!db.objectStoreNames.contains("themes")) {
          db.createObjectStore("themes", { keyPath: "id" });
        }
      },
    });
  }
  return dbPromise;
}

export async function listSnapshots(): Promise<SnapshotRecord[]> {
  const db = await getDb();
  return db.getAll("snapshots");
}

export async function putSnapshot(snapshot: SnapshotRecord): Promise<void> {
  const db = await getDb();
  await db.put("snapshots", snapshot);
}

export async function deleteSnapshots(ids: string[]): Promise<void> {
  const db = await getDb();
  const tx = db.transaction("snapshots", "readwrite");
  await Promise.all([...ids.map((id) => tx.store.delete(id)), tx.done]);
}

export async function listCustomColors(): Promise<CustomColorRecord[]> {
  const db = await getDb();
  return db.getAll("customColors");
}

export async function addCustomColor(record: CustomColorRecord): Promise<void> {
  const db = await getDb();
  await db.put("customColors", record);
}

export async function deleteCustomColor(id: string): Promise<void> {
  const db = await getDb();
  await db.delete("customColors", id);
}

export async function getLiveState(): Promise<LiveStateRecord | undefined> {
  const db = await getDb();
  return db.get("liveState", "current");
}

export async function putLiveState(state: LiveStateRecord): Promise<void> {
  const db = await getDb();
  await db.put("liveState", state);
}

export async function getSetting<T>(key: string): Promise<T | undefined> {
  const db = await getDb();
  const record = await db.get("settings", key);
  return record?.value as T | undefined;
}

export async function putSetting(key: string, value: unknown): Promise<void> {
  const db = await getDb();
  await db.put("settings", { key, value });
}

export async function listThemes(): Promise<ThemeRecord[]> {
  const db = await getDb();
  return db.getAll("themes");
}

export async function putTheme(theme: ThemeRecord): Promise<void> {
  const db = await getDb();
  await db.put("themes", theme);
}

export async function deleteTheme(id: string): Promise<void> {
  const db = await getDb();
  await db.delete("themes", id);
}
