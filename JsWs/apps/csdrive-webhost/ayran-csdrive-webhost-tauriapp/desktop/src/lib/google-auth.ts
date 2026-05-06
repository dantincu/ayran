import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import { listen } from '@tauri-apps/api/event';
import { upsertAccount } from './account-store';
import type { StoredAccount } from '../types';

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string;
const CLIENT_SECRET = import.meta.env.VITE_GOOGLE_CLIENT_SECRET as string;
const SCOPES = 'https://www.googleapis.com/auth/drive';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

// ── PKCE helpers ──────────────────────────────────────────────────────────────

function randomBase64url(length: number): string {
  const arr = new Uint8Array(length);
  crypto.getRandomValues(arr);
  return btoa(String.fromCharCode(...arr))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function sha256Base64url(plain: string): Promise<string> {
  const data = new TextEncoder().encode(plain);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

// ── OAuth flow ─────────────────────────────────────────────────────────────────

export async function connectGoogleDrive(
  onSuccess: (account: StoredAccount) => void,
  onError: (msg: string) => void
): Promise<() => void> {
  const verifier = randomBase64url(64);
  const challenge = await sha256Base64url(verifier);
  const state = randomBase64url(16);

  // Start the one-shot local HTTP listener (Rust command) and get its port.
  const port = await invoke<number>('start_oauth_listener');
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent select_account',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  });

  // Listen for the code emitted by Rust after the browser callback arrives.
  const unlistenCode = await listen<string>('oauth-code', async (event) => {
    unlistenCode();
    unlistenErr();
    try {
      const tokens = await exchangeCode(event.payload, redirectUri, verifier);
      const account = await buildAccountFromTokens(tokens);
      await upsertAccount(account);
      onSuccess(account);
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Token exchange failed');
    }
  });

  const unlistenErr = await listen<string>('oauth-error', (event) => {
    unlistenCode();
    unlistenErr();
    onError(event.payload ?? 'OAuth error');
  });

  await openUrl(`https://accounts.google.com/o/oauth2/auth?${params}`);

  // Return a cancel function so the caller can clean up if needed.
  return () => { unlistenCode(); unlistenErr(); };
}

async function exchangeCode(code: string, redirectUri: string, verifier: string) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description ?? data.error ?? 'Token exchange failed');
  return data as { access_token: string; refresh_token?: string; expires_in: number };
}

async function buildAccountFromTokens(tokens: {
  access_token: string; refresh_token?: string; expires_in: number;
}): Promise<StoredAccount> {
  const res = await fetch(`${DRIVE_API}/about?fields=user`, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  const { user } = await res.json();
  return {
    id: `google-${user.permissionId}`,
    email: user.emailAddress,
    displayName: user.displayName,
    provider: 'google-drive',
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + tokens.expires_in * 1_000,
  };
}

// ── Token refresh ──────────────────────────────────────────────────────────────

export async function getValidAccessToken(account: StoredAccount): Promise<string> {
  if (!account.expiresAt || account.expiresAt - 60_000 > Date.now()) {
    return account.accessToken!;
  }
  if (!account.refreshToken) return account.accessToken!;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: account.refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description ?? 'Token refresh failed');

  const updated: StoredAccount = {
    ...account,
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1_000,
  };
  await upsertAccount(updated);
  return data.access_token as string;
}