import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Note, Stylesheet, NoteTemplate } from '../types';
import { DEFAULT_STYLESHEETS, DEFAULT_EDITOR_STYLESHEET_IDS, DEFAULT_PREVIEW_STYLESHEET_IDS } from './defaultStylesheets';

interface QuickNotesDb extends DBSchema {
  notes: {
    key: string;
    value: Note;
    indexes: { createdAt: number };
  };
  stylesheets: {
    key: string;
    value: Stylesheet;
    indexes: { createdAt: number };
  };
  templates: {
    key: string;
    value: NoteTemplate;
    indexes: { createdAt: number };
  };
}

const DB_NAME = 'ayran-quick-notes';
const DB_VERSION = 2;

let dbPromise: Promise<IDBPDatabase<QuickNotesDb>> | null = null;

function getDb(): Promise<IDBPDatabase<QuickNotesDb>> {
  if (!dbPromise) {
    dbPromise = openDB<QuickNotesDb>(DB_NAME, DB_VERSION, {
      async upgrade(db, oldVersion, _newVersion, transaction) {
        if (oldVersion < 1) {
          const store = db.createObjectStore('notes', { keyPath: 'id' });
          store.createIndex('createdAt', 'createdAt');
        }
        if (oldVersion < 2) {
          const stylesheets = db.createObjectStore('stylesheets', { keyPath: 'id' });
          stylesheets.createIndex('createdAt', 'createdAt');
          db.createObjectStore('templates', { keyPath: 'id' }).createIndex('createdAt', 'createdAt');

          const now = Date.now();
          const stylesheetsStore = transaction.objectStore('stylesheets');
          for (const def of DEFAULT_STYLESHEETS) {
            await stylesheetsStore.put({ ...def, builtin: true, createdAt: now, updatedAt: now });
          }

          const notesStore = transaction.objectStore('notes');
          let cursor = await notesStore.openCursor();
          while (cursor) {
            const note = cursor.value;
            await cursor.update({
              ...note,
              labels: note.labels ?? [],
              editorStylesheetIds: note.editorStylesheetIds ?? DEFAULT_EDITOR_STYLESHEET_IDS,
              previewStylesheetIds: note.previewStylesheetIds ?? DEFAULT_PREVIEW_STYLESHEET_IDS,
            });
            cursor = await cursor.continue();
          }
        }
      },
    }).then(async (db) => {
      // Built-in stylesheets' content is re-applied on every open (idempotent) so
      // future app updates to default CSS propagate to already-installed DBs.
      const now = Date.now();
      const tx = db.transaction('stylesheets', 'readwrite');
      await Promise.all([
        ...DEFAULT_STYLESHEETS.map(async (def) => {
          const existing = await tx.store.get(def.id);
          await tx.store.put({
            ...def,
            builtin: true,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
          });
        }),
        tx.done,
      ]);
      return db;
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

export async function getAllStylesheets(): Promise<Stylesheet[]> {
  const db = await getDb();
  const sheets = await db.getAllFromIndex('stylesheets', 'createdAt');
  return sheets;
}

export async function putStylesheet(stylesheet: Stylesheet): Promise<void> {
  const db = await getDb();
  await db.put('stylesheets', stylesheet);
}

export async function deleteStylesheet(id: string): Promise<void> {
  const db = await getDb();
  const existing = await db.get('stylesheets', id);
  if (existing?.builtin) return; // built-ins are non-deletable; UI should never allow this either.
  await db.delete('stylesheets', id);
}

export async function getAllTemplates(): Promise<NoteTemplate[]> {
  const db = await getDb();
  const templates = await db.getAllFromIndex('templates', 'createdAt');
  return templates.reverse();
}

export async function putTemplate(template: NoteTemplate): Promise<void> {
  const db = await getDb();
  await db.put('templates', template);
}

export async function deleteTemplate(id: string): Promise<void> {
  const db = await getDb();
  await db.delete('templates', id);
}

export function createId(): string {
  return crypto.randomUUID();
}

export function createNoteId(): string {
  return createId();
}
