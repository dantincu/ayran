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

export async function renameFile(accountId: string, uuid: string, newName: string): Promise<void> {
  return invoke('filen_rename_file', { accountId, uuid, newName });
}

export async function renameDirectory(accountId: string, uuid: string, newName: string): Promise<void> {
  return invoke('filen_rename_directory', { accountId, uuid, newName });
}

export async function moveFile(accountId: string, uuid: string, toFolderUuid: string): Promise<void> {
  return invoke('filen_move_file', { accountId, uuid, toFolderUuid });
}

export async function moveDirectory(accountId: string, uuid: string, toFolderUuid: string): Promise<void> {
  return invoke('filen_move_directory', { accountId, uuid, toFolderUuid });
}

export async function copyFile(accountId: string, uuid: string, parentUuid: string): Promise<string> {
  return invoke('filen_copy_file', { accountId, uuid, parentUuid });
}

export async function overwriteFile(
  accountId: string,
  fileUuid: string,
  parentUuid: string,
  filePath: string,
): Promise<void> {
  return invoke('filen_overwrite_file', { accountId, fileUuid, parentUuid, filePath });
}

export async function hasSession(accountId: string): Promise<boolean> {
  return invoke('filen_has_session', { accountId });
}

export function logout(accountId: string): void {
  invoke('filen_logout', { accountId });
}
