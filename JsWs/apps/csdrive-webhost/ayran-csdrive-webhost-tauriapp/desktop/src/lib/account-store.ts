import { load } from '@tauri-apps/plugin-store';
import type { StoredAccount } from '../types';

type StoreInstance = Awaited<ReturnType<typeof load>>;
let _store: StoreInstance | null = null;

async function getStore(): Promise<StoreInstance> {
  if (!_store) _store = await load('.csdrive-accounts.dat', { autoSave: false, defaults: {} });
  return _store;
}

export async function listAccounts(): Promise<StoredAccount[]> {
  const store = await getStore();
  const accounts = await store.get<Record<string, StoredAccount>>('accounts');
  return accounts ? Object.values(accounts) : [];
}

export async function getAccount(id: string): Promise<StoredAccount | null> {
  const store = await getStore();
  const accounts = await store.get<Record<string, StoredAccount>>('accounts');
  return accounts?.[id] ?? null;
}

export async function upsertAccount(account: StoredAccount): Promise<void> {
  const store = await getStore();
  const accounts = (await store.get<Record<string, StoredAccount>>('accounts')) ?? {};
  accounts[account.id] = account;
  await store.set('accounts', accounts);
  await store.save();
}

export async function deleteAccount(id: string): Promise<void> {
  const store = await getStore();
  const accounts = (await store.get<Record<string, StoredAccount>>('accounts')) ?? {};
  delete accounts[id];
  await store.set('accounts', accounts);
  await store.save();
}