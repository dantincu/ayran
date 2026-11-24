import { invoke } from '@tauri-apps/api/core'

/** An entry as the backend shows it: never a hash, never a password. */
export interface Entry {
  id: string
  label: string
  createdAt: number
  updatedAt: number
}

export const api = {
  list: () => invoke<Entry[]>('list_passwords'),
  add: (label: string, password: string) => invoke<Entry[]>('add_password', { label, password }),
  /** `password: null` keeps the current one. */
  update: (id: string, label: string, password: string | null) =>
    invoke<Entry[]>('update_password', { id, label, password }),
  remove: (ids: string[]) => invoke<Entry[]>('delete_passwords', { ids }),
  reorder: (ids: string[]) => invoke<Entry[]>('reorder_passwords', { ids }),
  check: (id: string, attempt: string) => invoke<boolean>('check_password', { id, attempt }),
}

export function errorText(e: unknown): string {
  return typeof e === 'string' ? e : e instanceof Error ? e.message : String(e)
}
