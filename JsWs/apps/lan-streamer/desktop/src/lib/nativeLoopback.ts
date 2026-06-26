import { Channel, invoke } from "@tauri-apps/api/core";
import { CHANNELS, FRAME_SAMPLES } from "./audioCapture";

const EXPECTED_FRAME_INTERVAL_MS = 20;
const BYTES_PER_FRAME = FRAME_SAMPLES * CHANNELS * 2;
// Must match BATCH_FRAMES in desktop/src-tauri/src/loopback.rs. Reverted to 1
// (no batching) - batching introduced bursty delivery that reintroduced the
// same gap symptom this was meant to fix. See the comment there.
const BATCH_FRAMES = 1;
const EXPECTED_BATCH_INTERVAL_MS = EXPECTED_FRAME_INTERVAL_MS * BATCH_FRAMES;

/**
 * Starts native system-audio loopback capture (Rust/cpal). Frames arrive
 * batched (see BATCH_FRAMES) and already shaped to match the host WebSocket
 * protocol (48kHz stereo 16-bit PCM, 960 samples/channel per 20ms frame), so
 * each unbatched frame can be sent straight through `ws.send()`.
 */
export async function startNativeLoopback(onFrame: (frame: ArrayBuffer) => void, initialGain = 1): Promise<void> {
  // ArrayBuffer, not number[]: the Rust side sends each batch as a raw-bytes
  // Response rather than a bare Vec<u8>. A bare Vec<u8> gets JSON-encoded as
  // one numeric token per byte, which was enough JSON encode/parse + GC load
  // on the webview's main thread to stall IPC delivery on its own.
  const channel = new Channel<ArrayBuffer | Uint8Array | number[]>();
  let lastReceivedAt: number | undefined;
  let loggedPayloadShape = false;
  channel.onmessage = (raw) => {
    if (!loggedPayloadShape) {
      loggedPayloadShape = true;
      console.log(
        `[nativeLoopback] batch payload shape: ${Object.prototype.toString.call(raw)}, byteLength=${(raw as ArrayBuffer)?.byteLength}, isArray=${Array.isArray(raw)}`,
      );
    }
    // Diagnostics: each batch is BATCH_FRAMES * 20ms of audio. If onmessage
    // itself fires much later than that, the delay is in Tauri's IPC
    // delivery or main-thread contention (e.g. a React re-render) - upstream
    // of this, not in the Rust-side audio capture, which is instrumented
    // separately and wasn't the source when last checked.
    const now = performance.now();
    if (lastReceivedAt !== undefined) {
      const gap = now - lastReceivedAt;
      if (gap > EXPECTED_BATCH_INTERVAL_MS * 3) {
        console.warn(
          `[nativeLoopback] batch delivery gap: ${gap.toFixed(1)}ms since previous batch (expected ~${EXPECTED_BATCH_INTERVAL_MS}ms) - main-thread/IPC delay, not capture`,
        );
      }
    }
    lastReceivedAt = now;

    // Normalize rather than assume a shape: depending on payload size and
    // Tauri version, a channel's raw-bytes payload can arrive as an
    // ArrayBuffer, a Uint8Array, or (for the small-payload code path) a
    // plain number[] - all three construct a Uint8Array correctly, but
    // assuming any one specific shape silently drops every frame (the
    // splitting loop below relies on .byteLength, which is undefined on a
    // plain array) with no error anywhere.
    const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);

    for (let offset = 0; offset + BYTES_PER_FRAME <= bytes.byteLength; offset += BYTES_PER_FRAME) {
      onFrame(bytes.slice(offset, offset + BYTES_PER_FRAME).buffer);
    }
  };
  await invoke("start_loopback_capture", { onFrame: channel, initialGain });
}

export async function stopNativeLoopback(): Promise<void> {
  await invoke("stop_loopback_capture");
}

/** Live-updates the gain applied to native loopback capture while it's running. */
export async function setNativeLoopbackGain(gain: number): Promise<void> {
  await invoke("set_loopback_gain", { gain });
}
