import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Note } from '../types';

interface QuickNotesDb extends DBSchema {
  notes: {
    key: string;
    value: Note;
    indexes: { createdAt: number };
  };
}

const DB_NAME = 'ayran-quick-notes';
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<QuickNotesDb>> | null = null;

function getDb(): Promise<IDBPDatabase<QuickNotesDb>> {
  if (!dbPromise) {
    dbPromise = openDB<QuickNotesDb>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        const store = db.createObjectStore('notes', { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt');
      },
    });
  }
  return dbPromise;
}

export async function getAllNotes(): Promise<Note[]> {
  const db = await getDb();
  const notes = await db.getAllFromIndex('notes', 'createdAt');
  return notes.reverse();
}

export async function getNote(id: string): Promise<Note | undefined> {
  const db = await getDb();
  return db.get('notes', id);
}

export async function putNote(note: Note): Promise<void> {
  const db = await getDb();
  await db.put('notes', note);
}

export async function deleteNotes(ids: string[]): Promise<void> {
  const db = await getDb();
  const tx = db.transaction('notes', 'readwrite');
  await Promise.all([...ids.map((id) => tx.store.delete(id)), tx.done]);
}

export function createNoteId(): string {
  return crypto.randomUUID();
}
