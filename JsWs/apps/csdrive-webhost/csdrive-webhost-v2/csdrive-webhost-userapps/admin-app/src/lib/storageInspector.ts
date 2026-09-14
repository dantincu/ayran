export interface IdbInfo {
  name: string
  version: number
}

export async function listDatabases(): Promise<IdbInfo[]> {
  if (!indexedDB.databases) return []
  const dbs = await indexedDB.databases()
  return dbs
    .filter((d): d is { name: string; version: number } => !!d.name)
    .map((d) => ({ name: d.name, version: d.version ?? 0 }))
}

function openDb(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
    req.onblocked = () => reject(new Error('Database open blocked by another connection.'))
  })
}

export async function listStores(dbName: string): Promise<string[]> {
  const db = await openDb(dbName)
  try {
    return Array.from(db.objectStoreNames)
  } finally {
    db.close()
  }
}

export interface StoreInfo {
  keyPath: string | string[] | null
  autoIncrement: boolean
}

export async function getStoreInfo(dbName: string, storeName: string): Promise<StoreInfo> {
  const db = await openDb(dbName)
  try {
    const tx = db.transaction(storeName, 'readonly')
    const store = tx.objectStore(storeName)
    return { keyPath: store.keyPath as string | string[] | null, autoIncrement: store.autoIncrement }
  } finally {
    db.close()
  }
}

export interface StoreRecord {
  key: IDBValidKey
  value: unknown
}

export async function listRecords(dbName: string, storeName: string, limit = 200): Promise<StoreRecord[]> {
  const db = await openDb(dbName)
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly')
      const store = tx.objectStore(storeName)
      const results: StoreRecord[] = []
      const cursorReq = store.openCursor()
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result
        if (cursor && results.length < limit) {
          results.push({ key: cursor.key, value: cursor.value })
          cursor.continue()
        } else {
          resolve(results)
        }
      }
      cursorReq.onerror = () => reject(cursorReq.error)
    })
  } finally {
    db.close()
  }
}

export async function putRecord(dbName: string, storeName: string, value: unknown, key?: IDBValidKey): Promise<void> {
  const db = await openDb(dbName)
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite')
      const store = tx.objectStore(storeName)
      const req = key !== undefined ? store.put(value, key) : store.put(value)
      req.onsuccess = () => resolve()
      req.onerror = () => reject(req.error)
    })
  } finally {
    db.close()
  }
}

export async function deleteRecord(dbName: string, storeName: string, key: IDBValidKey): Promise<void> {
  const db = await openDb(dbName)
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite')
      const req = tx.objectStore(storeName).delete(key)
      req.onsuccess = () => resolve()
      req.onerror = () => reject(req.error)
    })
  } finally {
    db.close()
  }
}

export async function clearStore(dbName: string, storeName: string): Promise<void> {
  const db = await openDb(dbName)
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite')
      const req = tx.objectStore(storeName).clear()
      req.onsuccess = () => resolve()
      req.onerror = () => reject(req.error)
    })
  } finally {
    db.close()
  }
}

export function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
    req.onblocked = () => reject(new Error('Delete blocked by another open connection.'))
  })
}

export async function createDatabase(name: string): Promise<void> {
  const db = await openDb(name)
  db.close()
}

export async function createStore(
  dbName: string,
  storeName: string,
  keyPath: string | null,
  autoIncrement: boolean,
): Promise<void> {
  const probe = await openDb(dbName)
  const currentVersion = probe.version
  probe.close()

  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.open(dbName, currentVersion + 1)
    req.onupgradeneeded = () => {
      const options: IDBObjectStoreParameters = {}
      if (keyPath) options.keyPath = keyPath
      if (autoIncrement) options.autoIncrement = true
      req.result.createObjectStore(storeName, options)
    }
    req.onsuccess = () => {
      req.result.close()
      resolve()
    }
    req.onerror = () => reject(req.error)
    req.onblocked = () => reject(new Error('Upgrade blocked by another open connection.'))
  })
}

export async function deleteStore(dbName: string, storeName: string): Promise<void> {
  const probe = await openDb(dbName)
  const currentVersion = probe.version
  probe.close()

  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.open(dbName, currentVersion + 1)
    req.onupgradeneeded = () => {
      req.result.deleteObjectStore(storeName)
    }
    req.onsuccess = () => {
      req.result.close()
      resolve()
    }
    req.onerror = () => reject(req.error)
    req.onblocked = () => reject(new Error('Upgrade blocked by another open connection.'))
  })
}
