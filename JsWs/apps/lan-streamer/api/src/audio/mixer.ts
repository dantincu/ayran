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
  /** diagnostics: how many consecutive ticks this connection's queue has been empty */
  emptyStreak: number;
}

interface StreamMixState {
  // keyed per host *connection* (not per account) so that multiple windows/devices
  // under the same Filen account can stream into the same stream simultaneously
  // and have their audio mixed together rather than colliding on one queue.
  hostQueues: Map<string, HostConnection>;
  listeners: Set<WebSocket>;
  timer: NodeJS.Timeout;
  /** diagnostics: wall-clock time of the previous tick, to detect the mixer's own timer lagging */
  lastTickAt: number;
  // Reused every tick instead of allocating fresh arrays - with N host
  // connections, the old code allocated 1 Int32Array + N Int16Arrays *every
  // single 20ms tick* (50x/sec), which is enough garbage to trigger V8 GC
  // pauses landing the mixer's own setInterval noticeably behind schedule -
  // the actual cause of the periodic gaps this was built to diagnose.
  accumulator: Int32Array;
  // Also reused every tick (not just the accumulator) - a fresh
  // Buffer.alloc(BYTES_PER_FRAME) every tick was left in place under the
  // assumption that ws.send() copies synchronously before returning, but
  // that assumption was never actually verified, and tick-lag warnings kept
  // recurring even after the accumulator fix above. Since the *same* buffer
  // instance is already sent to every listener within one tick without
  // corruption, ws.send() provably does copy synchronously - so reusing it
  // across ticks too is just as safe as reusing the accumulator.
  output: Buffer;
}

const streams = new Map<string, StreamMixState>();

function ensureStream(streamId: string): StreamMixState {
  let state = streams.get(streamId);
  if (state) return state;

  state = {
    hostQueues: new Map(),
    listeners: new Set(),
    timer: setInterval(() => tick(streamId), TICK_MS),
    lastTickAt: Date.now(),
    accumulator: new Int32Array(FRAME_SAMPLES * CHANNELS),
    output: Buffer.alloc(BYTES_PER_FRAME),
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
 * full-scale) and adds the result directly into `accumulator`, easing the
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
function accumulateLimited(frame: Buffer, ceilingAmplitude: number, conn: HostConnection, accumulator: Int32Array): void {
  const ceiling = ceilingAmplitude * 32767;

  for (let i = 0; i < FRAME_SAMPLES; i++) {
    const left = frame.readInt16LE(i * CHANNELS * 2);
    const right = frame.readInt16LE((i * CHANNELS + 1) * 2);
    const magnitude = Math.max(Math.abs(left), Math.abs(right));
    const targetGain = magnitude > ceiling ? ceiling / magnitude : 1;
    const coeff = targetGain < conn.limiterGain ? LIMITER_ATTACK_COEFF : LIMITER_RELEASE_COEFF;
    conn.limiterGain = conn.limiterGain * coeff + targetGain * (1 - coeff);
    accumulator[i * CHANNELS] += Math.round(left * conn.limiterGain);
    accumulator[i * CHANNELS + 1] += Math.round(right * conn.limiterGain);
  }
}

interface SimpleStreamState {
  listeners: Set<WebSocket>;
  /** same envelope-follower limiter as accumulateLimited, but writing
   * directly into `output` instead of summing into an accumulator - a
   * simple stream only ever has one active source, so there's nothing to
   * mix and no clamping risk from multiple sources overlapping. */
  limiterGain: number;
  output: Buffer;
}

const simpleStreams = new Map<string, SimpleStreamState>();

function ensureSimpleStream(streamId: string): SimpleStreamState {
  let state = simpleStreams.get(streamId);
  if (state) return state;
  state = { listeners: new Set(), limiterGain: 1, output: Buffer.alloc(BYTES_PER_FRAME) };
  simpleStreams.set(streamId, state);
  return state;
}

function maybeTeardownSimple(streamId: string): void {
  const state = simpleStreams.get(streamId);
  if (state && state.listeners.size === 0) simpleStreams.delete(streamId);
}

/** Forwards one frame from the currently-active host straight to a simple
 * stream's listeners, applying the same account-wide volume cap as merged
 * streams but with no mixing/buffering tick involved - whatever the host
 * sends goes out immediately. */
export function forwardSimpleFrame(streamId: string, accountId: number, frame: Buffer): void {
  const state = simpleStreams.get(streamId);
  if (!state || state.listeners.size === 0) return;

  const { maxDeviceAmplitude } = getAccountSettings(accountId);
  const ceiling = maxDeviceAmplitude * 32767;
  for (let i = 0; i < FRAME_SAMPLES; i++) {
    const left = frame.readInt16LE(i * CHANNELS * 2);
    const right = frame.readInt16LE((i * CHANNELS + 1) * 2);
    const magnitude = Math.max(Math.abs(left), Math.abs(right));
    const targetGain = magnitude > ceiling ? ceiling / magnitude : 1;
    const coeff = targetGain < state.limiterGain ? LIMITER_ATTACK_COEFF : LIMITER_RELEASE_COEFF;
    state.limiterGain = state.limiterGain * coeff + targetGain * (1 - coeff);
    state.output.writeInt16LE(Math.round(left * state.limiterGain), i * CHANNELS * 2);
    state.output.writeInt16LE(Math.round(right * state.limiterGain), (i * CHANNELS + 1) * 2);
  }

  for (const ws of state.listeners) {
    if (ws.readyState === ws.OPEN) ws.send(state.output);
  }
}

export function registerSimpleListener(streamId: string, ws: WebSocket): void {
  ensureSimpleStream(streamId).listeners.add(ws);
}

export function unregisterSimpleListener(streamId: string, ws: WebSocket): void {
  const state = simpleStreams.get(streamId);
  if (!state) return;
  state.listeners.delete(ws);
  maybeTeardownSimple(streamId);
}

function tick(streamId: string): void {
  const state = streams.get(streamId);
  if (!state) return;

  // Diagnostics: if the mixer's own timer fires noticeably late, that points
  // at server-side load (event loop congestion, GC, etc.) rather than the
  // host failing to produce/send audio - distinguishes the two possible
  // sources of an output gap.
  const now = Date.now();
  const sinceLastTick = now - state.lastTickAt;
  state.lastTickAt = now;
  if (sinceLastTick > TICK_MS * 2) {
    console.warn(`[mixer] stream ${streamId}: tick fired ${sinceLastTick}ms after the previous one (expected ~${TICK_MS}ms) - mixer is running behind`);
  }

  if (state.listeners.size === 0) return;

  state.accumulator.fill(0);
  let anyContribution = false;

  for (const [connectionId, conn] of state.hostQueues) {
    const frame = conn.queue.shift();
    if (!frame) {
      conn.emptyStreak += 1;
      if (conn.emptyStreak === 1) {
        console.warn(`[mixer] stream ${streamId}: host ${connectionId} produced no frame for this tick (queue empty)`);
      }
      continue;
    }
    if (conn.emptyStreak > 1) {
      console.warn(`[mixer] stream ${streamId}: host ${connectionId} resumed after ${conn.emptyStreak * TICK_MS}ms with no frames`);
    }
    conn.emptyStreak = 0;
    anyContribution = true;

    const { maxDeviceAmplitude } = getAccountSettings(conn.accountId);
    accumulateLimited(frame, maxDeviceAmplitude, conn, state.accumulator);
  }

  if (!anyContribution) return;

  const mixed = state.output;
  for (let i = 0; i < state.accumulator.length; i++) {
    const clamped = Math.max(-32768, Math.min(32767, state.accumulator[i]));
    mixed.writeInt16LE(clamped, i * 2);
  }

  for (const ws of state.listeners) {
    if (ws.readyState === ws.OPEN) ws.send(mixed);
  }
}

export function registerHost(streamId: string, connectionId: string, accountId: number): void {
  const state = ensureStream(streamId);
  if (!state.hostQueues.has(connectionId)) {
    state.hostQueues.set(connectionId, { queue: [], accountId, limiterGain: 1, emptyStreak: 0 });
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
