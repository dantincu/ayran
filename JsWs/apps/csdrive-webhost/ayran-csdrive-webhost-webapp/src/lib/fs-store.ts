const DB_NAME = 'csdrive-fs';
const STORE = 'handles';

export interface FsEntry {
  id: string;
  name: string;
  handle: FileSystemDirectoryHandle;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function store(db: IDBDatabase, mode: IDBTransactionMode) {
  return db.transaction(STORE, mode).objectStore(STORE);
}

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function listFsEntries(): Promise<FsEntry[]> {
  const db = await openDB();
  return promisify(store(db, 'readonly').getAll());
}

export async function saveFsEntry(entry: FsEntry): Promise<void> {
  const db = await openDB();
  await promisify(store(db, 'readwrite').put(entry));
}

export async function deleteFsEntry(id: string): Promise<void> {
  const db = await openDB();
  await promisify(store(db, 'readwrite').delete(id));
}
