import { invoke } from "@tauri-apps/api/core";
import type { Session } from "./types";

interface StoredSession {
  api_base_url: string;
  token: string;
  account_user_id: number;
  account_email: string;
}

export async function saveSession(session: Session): Promise<void> {
  await invoke("save_session", {
    session: {
      api_base_url: session.apiBaseUrl,
      token: session.token,
      account_user_id: session.account.userId,
      account_email: session.account.email,
    },
  });
}

export async function loadSession(): Promise<Session | undefined> {
  const stored = await invoke<StoredSession | null>("load_session");
  if (!stored) return undefined;
  return {
    apiBaseUrl: stored.api_base_url,
    token: stored.token,
    account: { userId: stored.account_user_id, email: stored.account_email },
  };
}

export async function clearSession(): Promise<void> {
  await invoke("clear_session");
}
