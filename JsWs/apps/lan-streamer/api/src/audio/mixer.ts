import type { WebSocket } from "ws";
import { LIMITER_ATTACK_SECONDS, LIMITER_RELEASE_SECONDS } from "../config.js";
import { getAccountSettings } from "../store.js";

export const SAMPLE_RATE = 48000;
export const FRAME_SAMPLES = 960; // 20ms at 48kHz, per channel
export const CHANNELS = 2;
export const BYTES_PER_FRAME = FRAME_SAMPLES * CHANNELS * 2; // 16-bit PCM, interleaved [L0,R0,L1,R1,...]

const TICK_MS = 20;

// One-pole envelope smoothing coefficients for the per-device limiter: fast
// attack so a loud transient is caught almost immediately, slower release so
// gain eases back up smoothly afterward instead of snapping (which is what
// produces an audible "pop").
const LIMITER_ATTACK_COEFF = Math.exp(-1 / (SAMPLE_RATE * LIMITER_ATTACK_SECONDS));
const LIMITER_RELEASE_COEFF = Math.exp(-1 / (SAMPLE_RATE * LIMITER_RELEASE_SECONDS));

interface HostConnection {
  queue: Buffer[];
  accountId: number;
  /** current smoothed limiter gain (1 == no reduction), persists across frames/ticks */
  limiterGain: number;
}

interface StreamMixState {
  // keyed per host *connection* (not per account) so that multiple windows/devices
  // under the same Filen account can stream into the same stream simultaneously
  // and have their audio mixed together rather than colliding on one queue.
  hostQueues: Map<string, HostConnection>;
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

/**
 * Limits a device stream's peak amplitude to `ceilingAmplitude` (fraction of
 * full-scale) before it gets summed with other device streams, easing the
 * gain reduction in/out via an envelope follower rather than hard-clipping,
 * to avoid an audible "pop". Mutates `conn.limiterGain` to carry the
 * envelope across calls. Adds no buffering delay - the limiter acts on each
 * sample as it's read, it's just not a brick-wall clip.
 *
 * Stereo is "linked": both channels of a sample pair share one gain value
 * derived from whichever channel is louder, instead of being limited
 * independently. Independent per-channel limiting would shrink whichever
 * channel happens to be louder at any instant, smearing the stereo image
 * left/right as the signal moves - linking keeps the balance intact.
 */
function applyLimiter(frame: Buffer, ceilingAmplitude: number, conn: HostConnection): Int16Array {
  const ceiling = ceilingAmplitude * 32767;
  const out = new Int16Array(FRAME_SAMPLES * CHANNELS);

  for (let i = 0; i < FRAME_SAMPLES; i++) {
    const left = frame.readInt16LE(i * CHANNELS * 2);
    const right = frame.readInt16LE((i * CHANNELS + 1) * 2);
    const magnitude = Math.max(Math.abs(left), Math.abs(right));
    const targetGain = magnitude > ceiling ? ceiling / magnitude : 1;
    const coeff = targetGain < conn.limiterGain ? LIMITER_ATTACK_COEFF : LIMITER_RELEASE_COEFF;
    conn.limiterGain = conn.limiterGain * coeff + targetGain * (1 - coeff);
    out[i * CHANNELS] = Math.round(left * conn.limiterGain);
    out[i * CHANNELS + 1] = Math.round(right * conn.limiterGain);
  }

  return out;
}

function tick(streamId: string): void {
  const state = streams.get(streamId);
  if (!state) return;
  if (state.listeners.size === 0) return;

  const accumulator = new Int32Array(FRAME_SAMPLES * CHANNELS);
  let anyContribution = false;

  for (const conn of state.hostQueues.values()) {
    const frame = conn.queue.shift();
    if (!frame) continue;
    anyContribution = true;

    const { maxDeviceAmplitude } = getAccountSettings(conn.accountId);
    const limited = applyLimiter(frame, maxDeviceAmplitude, conn);
    for (let i = 0; i < accumulator.length; i++) accumulator[i] += limited[i];
  }

  if (!anyContribution) return;

  const mixed = Buffer.alloc(BYTES_PER_FRAME);
  for (let i = 0; i < accumulator.length; i++) {
    const clamped = Math.max(-32768, Math.min(32767, accumulator[i]));
    mixed.writeInt16LE(clamped, i * 2);
  }

  for (const ws of state.listeners) {
    if (ws.readyState === ws.OPEN) ws.send(mixed);
  }
}

export function registerHost(streamId: string, connectionId: string, accountId: number): void {
  const state = ensureStream(streamId);
  if (!state.hostQueues.has(connectionId)) {
    state.hostQueues.set(connectionId, { queue: [], accountId, limiterGain: 1 });
  }
}

export function unregisterHost(streamId: string, connectionId: string): void {
  const state = streams.get(streamId);
  if (!state) return;
  state.hostQueues.delete(connectionId);
  maybeTeardown(streamId);
}

export function pushHostFrame(streamId: string, connectionId: string, frame: Buffer): void {
  const state = streams.get(streamId);
  const conn = state?.hostQueues.get(connectionId);
  if (!conn) return;
  conn.queue.push(frame);
  // bound queue depth to avoid unbounded memory growth on slow consumers
  while (conn.queue.length > 25) conn.queue.shift();
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
