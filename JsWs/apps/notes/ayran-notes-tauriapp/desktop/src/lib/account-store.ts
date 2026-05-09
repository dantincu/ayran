import { invoke } from '@tauri-apps/api/core';
import type { StoredAccount } from '../types';

export function listAccounts(): Promise<StoredAccount[]> {
  return invoke('list_accounts');
}

export function getAccount(id: string): Promise<StoredAccount | null> {
  return invoke('get_account', { id });
}

export function upsertAccount(account: StoredAccount): Promise<void> {
  return invoke('upsert_account', { account });
}

export function deleteAccount(id: string): Promise<void> {
  return invoke('delete_account', { id });
}
