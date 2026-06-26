import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_MAX_DEVICE_AMPLITUDE } from "./config.js";
import { secureStore } from "./secureStore.js";
import type { AccountSettings, HostAudioSource, Session, StreamMode, StreamRecord } from "./types.js";

const DATA_DIR = path.resolve(process.cwd(), "data");
const STREAMS_FILE = path.join(DATA_DIR, "streams.json");
const SESSIONS_FILE = path.join(DATA_DIR, "sessions.enc");
const SESSION_KEY_FILE = path.join(DATA_DIR, "session-key.bin");
const ACCOUNT_SETTINGS_FILE = path.join(DATA_DIR, "account-settings.json");

const streams = new Map<string, StreamRecord>();
const sessions = new Map<string, Session>();
const accountSettings = new Map<number, AccountSettings>();

let saveQueued = false;

async function persist(): Promise<void> {
  if (saveQueued) return;
  saveQueued = true;
  setTimeout(async () => {
    saveQueued = false;
    try {
      await mkdir(DATA_DIR, { recursive: true });
      await writeFile(STREAMS_FILE, JSON.stringify([...streams.values()], null, 2), "utf8");
    } catch (err) {
      console.error("Failed to persist streams:", err);
    }
  }, 50);
}

export async function loadStreams(): Promise<void> {
  try {
    const raw = await readFile(STREAMS_FILE, "utf8");
    const records: StreamRecord[] = JSON.parse(raw);
    for (const record of records) {
      // activeHosts/pausedHostAccountIds describe live WebSocket connections,
      // none of which can still exist right after the process just started -
      // reset them rather than trusting whatever was last persisted (which
      // also protects against loading data written under an older schema).
      record.activeHosts = [];
      record.pausedHostAccountIds = [];
      // mode didn't exist before simple streams were added - anything
      // persisted under that older schema was always mixing/merging.
      record.mode ??= "merged";
      streams.set(record.id, record);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

export function listStreamsForAccount(accountId: number): StreamRecord[] {
  return [...streams.values()].filter((s) => s.ownerAccountId === accountId);
}

export function getStream(id: string): StreamRecord | undefined {
  return streams.get(id);
}

export function createStream(name: string, ownerAccountId: number, mode: StreamMode): StreamRecord {
  const record: StreamRecord = {
    id: randomUUID(),
    name,
    mode,
    ownerAccountId,
    createdAt: Date.now(),
    activeHosts: [],
    pausedHostAccountIds: [],
  };
  streams.set(record.id, record);
  void persist();
  return record;
}

export function deleteStream(id: string, accountId: number): boolean {
  const record = streams.get(id);
  if (!record || record.ownerAccountId !== accountId) return false;
  streams.delete(id);
  void persist();
  return true;
}

export function setHostPaused(streamId: string, accountId: number, paused: boolean): void {
  const record = streams.get(streamId);
  if (!record) return;
  record.pausedHostAccountIds = record.pausedHostAccountIds.filter((id) => id !== accountId);
  if (paused) record.pausedHostAccountIds.push(accountId);
  void persist();
}

// Each entry in activeHosts represents one connected host *connection* (e.g. a
// separate window or device) - the same account can co-host a stream from
// multiple places at once, each with its own audio source.
export function addActiveHost(
  streamId: string,
  connectionId: string,
  accountId: number,
  audioSource: HostAudioSource,
): void {
  const record = streams.get(streamId);
  if (!record) return;
  record.activeHosts.push({ connectionId, accountId, audioSource });
  void persist();
}

export function removeActiveHost(streamId: string, connectionId: string, accountId: number): void {
  const record = streams.get(streamId);
  if (!record) return;
  record.activeHosts = record.activeHosts.filter((host) => host.connectionId !== connectionId);
  if (!record.activeHosts.some((host) => host.accountId === accountId)) {
    record.pausedHostAccountIds = record.pausedHostAccountIds.filter((id) => id !== accountId);
  }
  void persist();
}

// Sessions are encrypted at rest (AES-256-GCM) with a key generated on first
// run and stored separately from the encrypted blob (data/session-key.bin vs
// data/sessions.enc). That key is itself protected via the OS-native secure
// store (DPAPI on Windows) before being written to disk, tying decryption to
// this OS user account on this machine - copying both files elsewhere isn't
// enough, unlike a plain symmetric key sitting next to its ciphertext.
let cachedSessionKey: Buffer | undefined;

async function loadOrCreateSessionKey(): Promise<Buffer> {
  if (cachedSessionKey) return cachedSessionKey;
  const store = await secureStore();
  try {
    const protected_ = await readFile(SESSION_KEY_FILE);
    cachedSessionKey = await store.unprotect(protected_);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    cachedSessionKey = randomBytes(32);
    const protected_ = await store.protect(cachedSessionKey);
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(SESSION_KEY_FILE, protected_);
    await chmod(SESSION_KEY_FILE, 0o600).catch(() => {});
  }
  return cachedSessionKey;
}

function encryptSessions(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString("base64");
}

function decryptSessions(key: Buffer, payload: string): string {
  const data = Buffer.from(payload, "base64");
  const iv = data.subarray(0, 12);
  const authTag = data.subarray(12, 28);
  const ciphertext = data.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

let sessionsSaveQueued = false;

async function persistSessions(): Promise<void> {
  if (sessionsSaveQueued) return;
  sessionsSaveQueued = true;
  setTimeout(async () => {
    sessionsSaveQueued = false;
    try {
      const key = await loadOrCreateSessionKey();
      const plaintext = JSON.stringify([...sessions.values()]);
      await mkdir(DATA_DIR, { recursive: true });
      await writeFile(SESSIONS_FILE, encryptSessions(key, plaintext), "utf8");
    } catch (err) {
      console.error("Failed to persist sessions:", err);
    }
  }, 50);
}

export async function loadSessions(): Promise<void> {
  try {
    const key = await loadOrCreateSessionKey();
    const payload = await readFile(SESSIONS_FILE, "utf8");
    const records: Session[] = JSON.parse(decryptSessions(key, payload));
    for (const session of records) sessions.set(session.token, session);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

export function createSession(session: Session): void {
  sessions.set(session.token, session);
  void persistSessions();
}

export function getSession(token: string): Session | undefined {
  return sessions.get(token);
}

export function deleteSession(token: string): void {
  sessions.delete(token);
  void persistSessions();
}

let accountSettingsSaveQueued = false;

async function persistAccountSettings(): Promise<void> {
  if (accountSettingsSaveQueued) return;
  accountSettingsSaveQueued = true;
  setTimeout(async () => {
    accountSettingsSaveQueued = false;
    try {
      const records = [...accountSettings.entries()].map(([accountId, settings]) => ({ accountId, ...settings }));
      await mkdir(DATA_DIR, { recursive: true });
      await writeFile(ACCOUNT_SETTINGS_FILE, JSON.stringify(records, null, 2), "utf8");
    } catch (err) {
      console.error("Failed to persist account settings:", err);
    }
  }, 50);
}

export async function loadAccountSettings(): Promise<void> {
  try {
    const raw = await readFile(ACCOUNT_SETTINGS_FILE, "utf8");
    const records: ({ accountId: number } & AccountSettings)[] = JSON.parse(raw);
    for (const { accountId, ...settings } of records) accountSettings.set(accountId, settings);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

export function getAccountSettings(accountId: number): AccountSettings {
  return accountSettings.get(accountId) ?? { maxDeviceAmplitude: DEFAULT_MAX_DEVICE_AMPLITUDE };
}

export function setAccountSettings(accountId: number, settings: AccountSettings): void {
  accountSettings.set(accountId, settings);
  void persistAccountSettings();
}
