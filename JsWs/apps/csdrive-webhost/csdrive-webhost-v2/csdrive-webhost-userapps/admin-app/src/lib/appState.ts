/** Small IndexedDB-backed key/value store for persisting UI state (active tab,
 * last-browsed folder, collapsed groups, ...) across app restarts.
 *
 * Naming convention: every user app under csdrive-webhost-userapps/ runs from the
 * same `csuser://localhost` origin, so IndexedDB databases and Web Storage keys are
 * shared browser-wide across all of them unless namespaced. Any database or key an
 * app creates for its own persistence must be prefixed with `[<app-folder-name>]` —
 * for this app, `[admin-app]`. See csdrive-webhost-v2/CLAUDE.md for the full rule. */

const APP_PREFIX = '[admin-app]'

const DB_NAME = `${APP_PREFIX}app-state`
const STORE_NAME = 'kv'

/** Superseded by the prefixed name above; deleted once on first use so it doesn't
 * linger unnamespaced. Safe to remove this once it's rolled out everywhere. */
const OLD_UNPREFIXED_DB_NAME = 'csdrive-admin-app-state'
try {
  indexedDB.deleteDatabase(OLD_UNPREFIXED_DB_NAME)
} catch {
  // ignore — best-effort cleanup only
}

function openAppStateDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME, { keyPath: 'key' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function prefixedKey(key: string): string {
  return key.startsWith(APP_PREFIX) ? key : `${APP_PREFIX}${key}`
}

export async function getAppState<T>(key: string): Promise<T | undefined> {
  const db = await openAppStateDb()
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const req = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(prefixedKey(key))
      req.onsuccess = () => resolve(req.result?.value)
      req.onerror = () => reject(req.error)
    })
  } finally {
    db.close()
  }
}

export async function setAppState<T>(key: string, value: T): Promise<void> {
  const db = await openAppStateDb()
  try {
    await new Promise<void>((resolve, reject) => {
      const req = db
        .transaction(STORE_NAME, 'readwrite')
        .objectStore(STORE_NAME)
        .put({ key: prefixedKey(key), value })
      req.onsuccess = () => resolve()
      req.onerror = () => reject(req.error)
    })
  } finally {
    db.close()
  }
}
