// IndexedDB helper for persisting notebook entries.
// DB: "ayran-notes", store: "notebooks", keyPath: "id"

export interface NotebookEntry {
  id: string;           // crypto.randomUUID()
  accountId: string;
  provider: string;
  itemId: string;       // effective item ID (Filen UUID / GDrive ID / local abs path)
  parentId: string;     // needed for save_text_file (Filen)
  displayPath: string;  // human-readable path shown in header
  title: string;        // from JSON file, cached here
  description?: string; // optional, IndexedDB only (not written to file)
  order: number;        // for drag reordering
  openedAt: number;     // Date.now() on creation
  windowLabel?: string; // Tauri WebviewWindow label when open in a separate window
  tabs?: Array<{ id: string; type: string; name: string }>;
  activeTabId?: string;
  tabsHeaderVisible?: boolean;
}

const DB_NAME = 'ayran-notes';
const STORE = 'notebooks';
const DB_VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbOp<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function addNotebook(
  entry: Omit<NotebookEntry, 'id' | 'order' | 'openedAt'>,
): Promise<NotebookEntry> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, 'readonly');
    const store = tx.objectStore(STORE);
    const all = await idbOp<NotebookEntry[]>(store.getAll());

    // If the same file is already tracked, update title/displayPath instead of duplicating.
    const existing = all.find(
      (e) => e.accountId === entry.accountId && e.provider === entry.provider && e.itemId === entry.itemId,
    );
    if (existing) {
      const updated: NotebookEntry = { ...existing, title: entry.title, displayPath: entry.displayPath, openedAt: Date.now() };
      const tx2 = db.transaction(STORE, 'readwrite');
      await idbOp(tx2.objectStore(STORE).put(updated));
      return updated;
    }

    const maxOrder = all.length > 0 ? Math.max(...all.map((e) => e.order)) : -1;
    const full: NotebookEntry = {
      ...entry,
      id: crypto.randomUUID(),
      order: maxOrder + 1,
      openedAt: Date.now(),
    };
    const tx2 = db.transaction(STORE, 'readwrite');
    await idbOp(tx2.objectStore(STORE).put(full));
    return full;
  } finally {
    db.close();
  }
}

export async function getAllNotebooks(): Promise<NotebookEntry[]> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, 'readonly');
    const all = await idbOp<NotebookEntry[]>(tx.objectStore(STORE).getAll());
    return all.sort((a, b) => a.order - b.order);
  } finally {
    db.close();
  }
}

export async function getNotebook(id: string): Promise<NotebookEntry | undefined> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, 'readonly');
    const result = await idbOp<NotebookEntry | undefined>(tx.objectStore(STORE).get(id));
    return result;
  } finally {
    db.close();
  }
}

export async function updateNotebook(
  id: string,
  updates: Partial<Omit<NotebookEntry, 'id'>>,
): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const existing = await idbOp<NotebookEntry | undefined>(store.get(id));
    if (!existing) throw new Error(`Notebook not found: ${id}`);
    const updated: NotebookEntry = { ...existing, ...updates };
    const tx2 = db.transaction(STORE, 'readwrite');
    await idbOp(tx2.objectStore(STORE).put(updated));
  } finally {
    db.close();
  }
}

export async function deleteNotebook(id: string): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, 'readwrite');
    await idbOp(tx.objectStore(STORE).delete(id));
  } finally {
    db.close();
  }
}

/** Update all notebook entries that reference the same underlying file. */
export async function updateNotebooksByFile(
  accountId: string,
  provider: string,
  itemId: string,
  updates: Partial<Omit<NotebookEntry, 'id'>>,
): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, 'readonly');
    const all = await idbOp<NotebookEntry[]>(tx.objectStore(STORE).getAll());
    const matching = all.filter(
      (n) => n.accountId === accountId && n.provider === provider && n.itemId === itemId,
    );
    for (const nb of matching) {
      const tx2 = db.transaction(STORE, 'readwrite');
      await idbOp(tx2.objectStore(STORE).put({ ...nb, ...updates }));
    }
  } finally {
    db.close();
  }
}

export async function reorderNotebooks(orderedIds: string[]): Promise<void> {
  const db = await openDb();
  try {
    for (let i = 0; i < orderedIds.length; i++) {
      const id = orderedIds[i];
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const entry = await idbOp<NotebookEntry | undefined>(store.get(id));
      if (entry) {
        const tx2 = db.transaction(STORE, 'readwrite');
        await idbOp(tx2.objectStore(STORE).put({ ...entry, order: i }));
      }
    }
  } finally {
    db.close();
  }
}
