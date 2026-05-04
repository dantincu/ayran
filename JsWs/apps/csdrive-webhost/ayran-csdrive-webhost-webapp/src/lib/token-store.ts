import fs from 'fs/promises';
import path from 'path';
import type { StoredAccount } from '@/types';

const TOKENS_DIR = path.join(process.cwd(), '.tokens');
const ACCOUNTS_FILE = path.join(TOKENS_DIR, 'accounts.json');

async function ensureDir(): Promise<void> {
  await fs.mkdir(TOKENS_DIR, { recursive: true });
}

async function readAccounts(): Promise<Record<string, StoredAccount>> {
  try {
    const data = await fs.readFile(ACCOUNTS_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return {};
  }
}

async function writeAccounts(accounts: Record<string, StoredAccount>): Promise<void> {
  await ensureDir();
  await fs.writeFile(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2), { encoding: 'utf-8', mode: 0o600 });
}

export async function listAccounts(): Promise<StoredAccount[]> {
  const accounts = await readAccounts();
  return Object.values(accounts);
}

export async function getAccount(id: string): Promise<StoredAccount | null> {
  const accounts = await readAccounts();
  return accounts[id] ?? null;
}

export async function upsertAccount(account: StoredAccount): Promise<void> {
  const accounts = await readAccounts();
  accounts[account.id] = account;
  await writeAccounts(accounts);
}

export async function deleteAccount(id: string): Promise<void> {
  const accounts = await readAccounts();
  delete accounts[id];
  await writeAccounts(accounts);
}
