import { invoke } from '@tauri-apps/api/core'

/** Thin wrappers around the CsDrive backend's OS-keychain-backed secret storage. */

export async function setSecret(key: string, value: string): Promise<void> {
  await invoke('keychain_set_secret', { key, value })
}

export async function getSecret(key: string): Promise<string | null> {
  return invoke<string | null>('keychain_get_secret', { key })
}

export async function deleteSecret(key: string): Promise<void> {
  await invoke('keychain_delete_secret', { key })
}
