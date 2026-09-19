import { invoke } from '@tauri-apps/api/core'

/** Thin wrapper over the backend's `sqlite_*` commands (see `sqlite_db.rs`), shaped like
 * the `tauri-plugin-sql` `Database` class this app used before. The backend only opens
 * files inside the user folder or folders the user has picked, and a handle is only
 * valid in the window that loaded it. */

export interface ExecuteResult {
  rowsAffected: number
  lastInsertId: number
}

export default class Database {
  private readonly handle: string

  private constructor(handle: string) {
    this.handle = handle
  }

  /** `path` is absolute, or relative to the user folder. Creates the file if missing. */
  static async load(path: string): Promise<Database> {
    return new Database(await invoke<string>('sqlite_load', { path }))
  }

  async execute(query: string, values: unknown[] = []): Promise<ExecuteResult> {
    return invoke<ExecuteResult>('sqlite_execute', { db: this.handle, query, values })
  }

  async select<T>(query: string, values: unknown[] = []): Promise<T> {
    return invoke<T>('sqlite_select', { db: this.handle, query, values })
  }

  async close(): Promise<void> {
    await invoke('sqlite_close', { db: this.handle })
  }
}

/** Closes every database this window has open. */
export async function closeAllDatabases(): Promise<void> {
  await invoke('sqlite_close', { db: null })
}
