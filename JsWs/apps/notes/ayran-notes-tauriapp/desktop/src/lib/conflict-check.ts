import { invoke } from '@tauri-apps/api/core';
import type { StoredAccount } from '../types';

/**
 * Checks whether an item has been modified on the cloud provider since we last
 * cached it. Returns `true` if a conflict is detected (server mtime > cached mtime).
 * Returns `false` if no conflict or if the check cannot be performed.
 */
export async function checkItemConflict(account: StoredAccount, itemId: string): Promise<boolean> {
  if (account.provider === 'local-fs') return false;
  try {
    const cachedMs = await invoke<number | null>('get_item_cached_mtime', {
      accountId: account.id, itemId,
    });
    if (cachedMs == null) return false;

    let serverMs: number | null = null;
    if (account.provider === 'google-drive') {
      serverMs = await invoke<number | null>('gdrive_get_file_mtime', {
        accountId: account.id, fileId: itemId,
      });
    } else if (account.provider === 'filen') {
      serverMs = await invoke<number | null>('filen_get_file_mtime', {
        accountId: account.id, uuid: itemId,
      });
    }

    return serverMs != null && serverMs > cachedMs;
  } catch {
    return false;
  }
}

/**
 * Prompts the user when a conflict is detected. Returns `true` if the user
 * chooses to proceed anyway, `false` if they want to cancel.
 */
export async function warnAndConfirmConflict(
  account: StoredAccount,
  itemId: string,
  itemName: string,
): Promise<boolean> {
  const conflict = await checkItemConflict(account, itemId);
  if (!conflict) return true;
  return confirm(
    `"${itemName}" has been modified on ${account.provider === 'filen' ? 'Filen' : 'Google Drive'} since you last fetched it.\n\nProceed anyway? Your changes may overwrite the server version.`
  );
}
