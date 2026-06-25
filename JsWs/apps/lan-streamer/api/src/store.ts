import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Session, StreamRecord } from "./types.js";

const DATA_DIR = path.resolve(process.cwd(), "data");
const STREAMS_FILE = path.join(DATA_DIR, "streams.json");

const streams = new Map<string, StreamRecord>();
const sessions = new Map<string, Session>();

let saveQueued = false;

async function persist(): Promise<void> {
  if (saveQueued) return;
  saveQueued = true;
  setTimeout(async () => {
    saveQueued = false;
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(STREAMS_FILE, JSON.stringify([...streams.values()], null, 2), "utf8");
  }, 50);
}

export async function loadStreams(): Promise<void> {
  try {
    const raw = await readFile(STREAMS_FILE, "utf8");
    const records: StreamRecord[] = JSON.parse(raw);
    for (const record of records) streams.set(record.id, record);
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

export function createStream(name: string, ownerAccountId: number): StreamRecord {
  const record: StreamRecord = {
    id: randomUUID(),
    name,
    ownerAccountId,
    createdAt: Date.now(),
    activeHostAccountIds: [],
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

// activeHostAccountIds may contain the same accountId more than once: each
// entry represents one connected host *connection* (e.g. a separate window or
// device), since the same account can co-host a stream from multiple places.
export function addActiveHost(streamId: string, accountId: number): void {
  const record = streams.get(streamId);
  if (!record) return;
  record.activeHostAccountIds.push(accountId);
  void persist();
}

export function removeActiveHost(streamId: string, accountId: number): void {
  const record = streams.get(streamId);
  if (!record) return;
  const index = record.activeHostAccountIds.indexOf(accountId);
  if (index !== -1) record.activeHostAccountIds.splice(index, 1);
  if (!record.activeHostAccountIds.includes(accountId)) {
    record.pausedHostAccountIds = record.pausedHostAccountIds.filter((id) => id !== accountId);
  }
  void persist();
}

export function createSession(session: Session): void {
  sessions.set(session.token, session);
}

export function getSession(token: string): Session | undefined {
  return sessions.get(token);
}

export function deleteSession(token: string): void {
  sessions.delete(token);
}
