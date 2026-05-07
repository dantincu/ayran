import { invoke } from '@tauri-apps/api/core';
import { upsertAccount } from './account-store';
import type { StoredAccount } from '../types';

export interface FilenItem {
  type: 'file' | 'directory';
  uuid: string;
  name: string;
  mime?: string;
  size?: number;
  lastModified: number;
}

export async function loginFilen(
  email: string,
  password: string,
  twoFactorCode?: string,
): Promise<StoredAccount> {
  const account = await invoke<StoredAccount>('filen_login', {
    email,
    password,
    twoFactorCode: twoFactorCode ?? null,
  });
  await upsertAccount(account);
  return account;
}

export async function listDirectory(
  accountId: string,
  uuid: string,
): Promise<FilenItem[]> {
  return invoke('filen_list_directory', { accountId, uuid });
}

export async function downloadFile(
  accountId: string,
  uuid: string,
  destPath: string,
): Promise<void> {
  return invoke('filen_download_file', { accountId, uuid, destPath });
}

export async function uploadFile(
  accountId: string,
  parentUuid: string,
  filePath: string,
): Promise<void> {
  return invoke('filen_upload_file', { accountId, parentUuid, filePath });
}

export async function createDirectory(
  accountId: string,
  parentUuid: string,
  name: string,
): Promise<string> {
  return invoke('filen_create_directory', { accountId, parentUuid, name });
}

export async function trashFile(accountId: string, uuid: string): Promise<void> {
  return invoke('filen_trash_file', { accountId, uuid });
}

export async function trashDirectory(accountId: string, uuid: string): Promise<void> {
  return invoke('filen_trash_directory', { accountId, uuid });
}

export async function hasSession(accountId: string): Promise<boolean> {
  return invoke('filen_has_session', { accountId });
}
