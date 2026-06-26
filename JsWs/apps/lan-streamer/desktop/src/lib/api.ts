import type { AccountSettings, FilenAccount, HostAudioSource, StreamRecord } from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(
  apiBaseUrl: string,
  path: string,
  init: RequestInit & { token?: string } = {},
): Promise<T> {
  const headers: Record<string, string> = {
    ...(init.body ? { "Content-Type": "application/json" } : {}),
    ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
  };

  const res = await fetch(`${apiBaseUrl}/api${path}`, { ...init, headers });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(body.error ?? `Request failed with status ${res.status}`, res.status);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export function login(
  apiBaseUrl: string,
  email: string,
  password: string,
  twoFactorCode?: string,
): Promise<{ token: string; account: FilenAccount }> {
  return request(apiBaseUrl, "/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password, twoFactorCode }),
  });
}

export function logout(apiBaseUrl: string, token: string): Promise<void> {
  return request(apiBaseUrl, "/auth/logout", { method: "POST", token });
}

export function listStreams(apiBaseUrl: string, token: string): Promise<StreamRecord[]> {
  return request(apiBaseUrl, "/streams", { token });
}

export function createStream(apiBaseUrl: string, token: string, name: string): Promise<StreamRecord> {
  return request(apiBaseUrl, "/streams", { method: "POST", token, body: JSON.stringify({ name }) });
}

export function deleteStream(apiBaseUrl: string, token: string, id: string): Promise<void> {
  return request(apiBaseUrl, `/streams/${id}`, { method: "DELETE", token });
}

export function pauseStream(apiBaseUrl: string, token: string, id: string): Promise<void> {
  return request(apiBaseUrl, `/streams/${id}/pause`, { method: "POST", token });
}

export function resumeStream(apiBaseUrl: string, token: string, id: string): Promise<void> {
  return request(apiBaseUrl, `/streams/${id}/resume`, { method: "POST", token });
}

export function getAccountSettings(apiBaseUrl: string, token: string): Promise<AccountSettings> {
  return request(apiBaseUrl, "/account/settings", { token });
}

export function updateAccountSettings(
  apiBaseUrl: string,
  token: string,
  settings: AccountSettings,
): Promise<AccountSettings> {
  return request(apiBaseUrl, "/account/settings", {
    method: "PUT",
    token,
    body: JSON.stringify(settings),
  });
}

export function wsUrl(
  apiBaseUrl: string,
  kind: "host" | "listen",
  streamId: string,
  token: string,
  audioSource?: HostAudioSource,
): string {
  const url = new URL(apiBaseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `/ws/${kind}/${streamId}`;
  url.searchParams.set("token", token);
  if (audioSource) url.searchParams.set("source", audioSource);
  return url.toString();
}
