import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import { listen } from '@tauri-apps/api/event';
import { upsertAccount } from './account-store';
import type { StoredAccount } from '../types';

export async function connectGoogleDrive(
  onSuccess: (account: StoredAccount) => void,
  onError: (msg: string) => void
): Promise<() => void> {
  // Rust generates PKCE + state, starts the loopback listener, and returns the
  // authorization URL. Credentials never touch JavaScript.
  const authUrl = await invoke<string>('start_google_oauth');

  const unlistenAccount = await listen<StoredAccount>('oauth-account', async (event) => {
    unlistenAccount();
    unlistenErr();
    await upsertAccount(event.payload);
    onSuccess(event.payload);
  });

  const unlistenErr = await listen<string>('oauth-error', (event) => {
    unlistenAccount();
    unlistenErr();
    onError(event.payload ?? 'OAuth error');
  });

  await openUrl(authUrl);
  return () => { unlistenAccount(); unlistenErr(); };
}

export async function getValidAccessToken(account: StoredAccount): Promise<string> {
  if (!account.expiresAt || account.expiresAt - 60_000 > Date.now()) {
    return account.accessToken!;
  }
  if (!account.refreshToken) return account.accessToken!;

  const [accessToken, expiresAt] = await invoke<[string, number]>('refresh_google_token', {
    refreshToken: account.refreshToken,
  });

  const updated: StoredAccount = { ...account, accessToken, expiresAt };
  await upsertAccount(updated);
  return accessToken;
}
