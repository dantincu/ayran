import type { WebSocket } from "ws";

export const SAMPLE_RATE = 48000;
export const FRAME_SAMPLES = 960; // 20ms at 48kHz
export const BYTES_PER_FRAME = FRAME_SAMPLES * 2; // 16-bit PCM

const TICK_MS = 20;

interface StreamMixState {
  // keyed per host *connection* (not per account) so that multiple windows/devices
  // under the same Filen account can stream into the same stream simultaneously
  // and have their audio mixed together rather than colliding on one queue.
  hostQueues: Map<string, Buffer[]>;
  listeners: Set<WebSocket>;
  timer: NodeJS.Timeout;
}

const streams = new Map<string, StreamMixState>();

function ensureStream(streamId: string): StreamMixState {
  let state = streams.get(streamId);
  if (state) return state;

  state = {
    hostQueues: new Map(),
    listeners: new Set(),
    timer: setInterval(() => tick(streamId), TICK_MS),
  };
  streams.set(streamId, state);
  return state;
}

function maybeTeardown(streamId: string): void {
  const state = streams.get(streamId);
  if (!state) return;
  if (state.hostQueues.size === 0 && state.listeners.size === 0) {
    clearInterval(state.timer);
    streams.delete(streamId);
  }
}

function tick(streamId: string): void {
  const state = streams.get(streamId);
  if (!state) return;
  if (state.listeners.size === 0) return;

  const accumulator = new Int32Array(FRAME_SAMPLES);
  let anyContribution = false;

  for (const queue of state.hostQueues.values()) {
    const frame = queue.shift();
    if (!frame) continue;
    anyContribution = true;
    for (let i = 0; i < FRAME_SAMPLES; i++) {
      accumulator[i] += frame.readInt16LE(i * 2);
    }
  }

  if (!anyContribution) return;

  const mixed = Buffer.alloc(BYTES_PER_FRAME);
  for (let i = 0; i < FRAME_SAMPLES; i++) {
    const clamped = Math.max(-32768, Math.min(32767, accumulator[i]));
    mixed.writeInt16LE(clamped, i * 2);
  }

  for (const ws of state.listeners) {
    if (ws.readyState === ws.OPEN) ws.send(mixed);
  }
}

export function registerHost(streamId: string, connectionId: string): void {
  const state = ensureStream(streamId);
  if (!state.hostQueues.has(connectionId)) state.hostQueues.set(connectionId, []);
}

export function unregisterHost(streamId: string, connectionId: string): void {
  const state = streams.get(streamId);
  if (!state) return;
  state.hostQueues.delete(connectionId);
  maybeTeardown(streamId);
}

export function pushHostFrame(streamId: string, connectionId: string, frame: Buffer): void {
  const state = streams.get(streamId);
  const queue = state?.hostQueues.get(connectionId);
  if (!queue) return;
  queue.push(frame);
  // bound queue depth to avoid unbounded memory growth on slow consumers
  while (queue.length > 25) queue.shift();
}

export function registerListener(streamId: string, ws: WebSocket): void {
  ensureStream(streamId).listeners.add(ws);
}

export function unregisterListener(streamId: string, ws: WebSocket): void {
  const state = streams.get(streamId);
  if (!state) return;
  state.listeners.delete(ws);
  maybeTeardown(streamId);
}
