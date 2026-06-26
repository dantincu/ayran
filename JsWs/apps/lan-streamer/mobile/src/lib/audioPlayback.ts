import { SAMPLE_RATE } from "./audioCapture";

const WORKLET_URL = "/playback-worklet.js";

/**
 * Plays incoming PCM frames via an AudioWorklet ring buffer instead of
 * scheduling a fresh AudioBuffer/AudioBufferSourceNode per frame (50/sec).
 * That approach worked but allocated heavily on the main thread every 20ms;
 * a GC pause at the wrong moment could delay delivery long enough to outrun
 * the jitter cushion, producing periodic silence gaps. The worklet's ring
 * buffer lives on the dedicated audio rendering thread, immune to main-thread
 * GC, and naturally absorbs arrival jitter without per-frame scheduling math.
 */
const EXPECTED_FRAME_INTERVAL_MS = 20;

export class AudioPlayback {
  private ctx: AudioContext;
  private node: AudioWorkletNode | undefined;
  private pendingBeforeReady: Float32Array[] = [];
  private lastEnqueuedAt: number | undefined;

  constructor() {
    this.ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    // Diagnostic: confirms whether this platform actually honors the
    // requested sample rate. If ctx.sampleRate ends up != SAMPLE_RATE, every
    // frame (generated assuming exactly 960 samples = 20ms at SAMPLE_RATE)
    // gets played back at the wrong implied duration - a mismatch far bigger
    // than ordinary clock drift, and not something a few-percent adaptive
    // rate correction could ever fully compensate for.
    console.log(`[AudioPlayback] requested sampleRate=${SAMPLE_RATE}, actual ctx.sampleRate=${this.ctx.sampleRate}`);
    void this.ctx.audioWorklet.addModule(WORKLET_URL).then(() => {
      this.node = new AudioWorkletNode(this.ctx, "playback-processor", {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });
      this.node.connect(this.ctx.destination);
      this.node.port.onmessage = (event) => {
        // Diagnostics: tells us whether short gaps are the ring buffer
        // itself running dry (independent of whether WebSocket frames are
        // arriving on schedule - that's measured separately).
        if (event.data.type === "underrun-started") {
          console.warn("[AudioPlayback] ring buffer underrun started");
        } else if (event.data.type === "underrun-resolved") {
          console.warn(`[AudioPlayback] ring buffer underrun resolved after ${event.data.durationMs.toFixed(1)}ms`);
        } else if (event.data.type === "enqueue-gap") {
          console.warn(
            `[AudioPlayback] enqueue-gap (audio thread): ${event.data.gapMs.toFixed(1)}ms since previous enqueue - delivery to the rendering thread itself was delayed`,
          );
        } else if (event.data.type === "buffer-level") {
          console.log(`[AudioPlayback] buffer level: ${event.data.availableMs.toFixed(1)}ms, started=${event.data.started}`);
        }
      };
      for (const floats of this.pendingBeforeReady) this.node.port.postMessage(floats, [floats.buffer]);
      this.pendingBeforeReady = [];
    });
  }

  enqueueFrame(data: ArrayBuffer): void {
    // Diagnostics: WS messages were confirmed arriving on schedule
    // ([ListenerPanel] showed no receive-gap warnings), yet the ring buffer
    // was still crashing from a full ~200ms cushion to empty almost
    // instantly. If main-thread work between "WS message received" and
    // "data actually handed to the worklet" is itself periodically delayed
    // (e.g. by per-frame allocation/GC, same root cause as the original
    // host-side stalls, just here on this device's main thread), that gap
    // would show up here even though the network-level gap is clean.
    const now = performance.now();
    if (this.lastEnqueuedAt !== undefined) {
      const gap = now - this.lastEnqueuedAt;
      if (gap > EXPECTED_FRAME_INTERVAL_MS * 3) {
        console.warn(
          `[AudioPlayback] enqueueFrame gap: ${gap.toFixed(1)}ms since previous call (expected ~${EXPECTED_FRAME_INTERVAL_MS}ms) - main-thread delay between WS receipt and worklet handoff`,
        );
      }
    }
    this.lastEnqueuedAt = now;

    const samples = new Int16Array(data);
    const floats = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) floats[i] = samples[i] / 32768;

    if (this.node) {
      this.node.port.postMessage(floats, [floats.buffer]);
    } else {
      this.pendingBeforeReady.push(floats);
    }
  }

  stop(): void {
    this.node?.disconnect();
    void this.ctx.close();
  }
}
