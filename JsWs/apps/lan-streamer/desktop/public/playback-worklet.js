// Runs on the dedicated audio rendering thread, not the main JS thread - so
// main-thread GC pauses/allocation churn (the actual cause of the periodic
// silence gaps the old AudioBuffer-per-frame approach had) can't delay it.
// A ring buffer absorbs network/timing jitter naturally: process() just
// reads whatever's available each render quantum (128 samples), instead of
// the main thread trying to schedule exact AudioBufferSourceNode start times.
const CHANNELS = 2;
// Cold-start cushion: how much audio to buffer before the very first sound
// plays, and again after a genuine outage (network drop, app backgrounded,
// etc.) forces a full re-buffer. Generous on purpose since it only costs
// latency once, not an ongoing tax.
const TARGET_LEAD_SECONDS = 0.35;
// The ongoing buffer level the adaptive-rate correction below tries to hold
// during normal playback - comfortably above the WiFi jitter actually
// observed (a single WS receive gap of ~90ms was logged) but well under
// TARGET_LEAD_SECONDS, so steady-state latency stays low.
const STEADY_TARGET_SECONDS = 0.2;
// A direct measurement (logging the raw buffer level over time, not just
// underrun timestamps) showed it draining at roughly 8%. An attempt to
// compensate for that via a larger adaptive-rate correction (an "integral"
// term that ramped up to ~8-15%) did eliminate the underruns, but produced
// a continuous, audibly fluctuating pitch+speed change instead - and a
// direct throughput count (received-frame count vs expected, independent
// of any timing diagnostic) confirmed why: it's ~6-11% *genuine packet
// loss* on the network path to this device, not clock drift. Time-
// stretching the entire stream to paper over scattered real packet loss is
// the wrong tool - it distorts everything continuously to compensate for
// something that's actually only missing here and there. The right
// response to real loss is to let those specific frames be brief, isolated
// silences (handled naturally by the underrun path below) rather than
// warping playback rate to chase data that was never going to arrive.
// MAX_RATE_ADJUST stays small - just enough for ordinary clock drift
// between this device's audio clock and the sender's (typically well under
// 1%, same order of magnitude as NTP/WebRTC-style corrections), not as a
// disguise for actual loss.
const MAX_RATE_ADJUST = 0.03;

class PlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.capacityFrames = sampleRate * 2; // 2s of headroom, generous bound not the operating target
    this.ring = new Float32Array(this.capacityFrames * CHANNELS);
    this.writeFrame = 0;
    this.availableFrames = 0;
    // Fractional read cursor: readBaseFrame is the oldest buffered frame,
    // frac in [0,1) is how far between readBaseFrame and the next frame
    // we've consumed so far - lets the consumption rate be slightly above
    // or below 1.0 instead of always advancing by exactly one frame.
    this.readBaseFrame = 0;
    this.frac = 0;
    this.started = false;
    this.hasStartedOnce = false;
    this.targetLeadFrames = Math.round(sampleRate * TARGET_LEAD_SECONDS);
    this.steadyTargetFrames = Math.round(sampleRate * STEADY_TARGET_SECONDS);
    this.underrunStartedAt = null;
    this.lastEnqueueAt = null;
    // Diagnostics: rather than keep inferring buffer health indirectly from
    // underrun timestamps, log the actual instantaneous buffer level
    // directly on a fixed cadence - this settles definitively whether it's
    // a genuine supply deficit (level trends down steadily) or a
    // consumption-side bug (level oscillates/spikes oddly) instead of more
    // speculation.
    this.lastLevelLogAt = null;
    this.port.onmessage = (event) => this.enqueue(event.data);
  }

  enqueue(floatSamples) {
    // Diagnostics: WS receipt and the main-thread relay into postMessage
    // were both confirmed on schedule, yet the buffer still drains from a
    // full cushion to empty almost instantly every cycle - the remaining
    // unverified link is delivery from postMessage to this audio-rendering
    // thread itself (a separate timing domain from the main thread, using
    // currentTime - the audio clock - rather than performance.now()).
    if (this.lastEnqueueAt !== null) {
      const gapMs = (currentTime - this.lastEnqueueAt) * 1000;
      if (gapMs > 60) {
        this.port.postMessage({ type: "enqueue-gap", gapMs });
      }
    }
    this.lastEnqueueAt = currentTime;

    const frames = floatSamples.length / CHANNELS;
    for (let f = 0; f < frames; f++) {
      const widx = (this.writeFrame + f) % this.capacityFrames;
      for (let ch = 0; ch < CHANNELS; ch++) {
        this.ring[widx * CHANNELS + ch] = floatSamples[f * CHANNELS + ch];
      }
    }
    this.writeFrame = (this.writeFrame + frames) % this.capacityFrames;
    this.availableFrames = Math.min(this.availableFrames + frames, this.capacityFrames);
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    const frames = output[0].length;

    if (this.lastLevelLogAt === null || currentTime - this.lastLevelLogAt >= 0.25) {
      this.lastLevelLogAt = currentTime;
      this.port.postMessage({
        type: "buffer-level",
        availableMs: (this.availableFrames / sampleRate) * 1000,
        started: this.started,
      });
    }

    if (!this.started) {
      // Resuming after an underrun rebuilds the real operating cushion
      // (steadyTargetFrames), not a token amount - a too-thin resume
      // threshold doesn't give the adaptive correction above enough margin
      // to actually do its job, so it just gets stuck oscillating at that
      // thin level instead of ever settling at the intended steady state.
      // Only the very first cold start pays the bigger introductory lead.
      const requiredLead = this.hasStartedOnce ? this.steadyTargetFrames : this.targetLeadFrames;
      if (this.availableFrames >= requiredLead) {
        this.started = true;
        this.hasStartedOnce = true;
        this.frac = 0;
        if (this.underrunStartedAt !== null) {
          const durationMs = (currentTime - this.underrunStartedAt) * 1000;
          this.port.postMessage({ type: "underrun-resolved", durationMs });
          this.underrunStartedAt = null;
        }
      } else {
        for (let ch = 0; ch < output.length; ch++) output[ch].fill(0);
        return true;
      }
    }

    // Recomputed once per render quantum (every ~2.7ms), not per-sample -
    // the correction only needs to track slow drift, not react instantly.
    const error = (this.availableFrames - this.steadyTargetFrames) / this.steadyTargetFrames;
    const rate = 1 + Math.max(-MAX_RATE_ADJUST, Math.min(MAX_RATE_ADJUST, error * 0.5));

    for (let i = 0; i < frames; i++) {
      if (this.availableFrames < 2) {
        // Genuine underrun: nothing left to interpolate from. Go silent and
        // require the small resume cushion (not the full cold-start lead)
        // before resuming - the adaptive rate correction should keep this
        // rare under normal conditions, so recovery should stay brief.
        if (this.underrunStartedAt === null) {
          this.underrunStartedAt = currentTime;
          this.port.postMessage({ type: "underrun-started" });
        }
        for (let ch = 0; ch < output.length; ch++) output[ch][i] = 0;
        this.started = false;
        continue;
      }

      const i0 = this.readBaseFrame;
      const i1 = (this.readBaseFrame + 1) % this.capacityFrames;
      for (let ch = 0; ch < CHANNELS; ch++) {
        const a = this.ring[i0 * CHANNELS + ch];
        const b = this.ring[i1 * CHANNELS + ch];
        output[ch][i] = a + (b - a) * this.frac;
      }

      this.frac += rate;
      if (this.frac >= 1) {
        const advance = Math.floor(this.frac);
        this.readBaseFrame = (this.readBaseFrame + advance) % this.capacityFrames;
        this.availableFrames -= advance;
        this.frac -= advance;
      }
    }

    return true;
  }
}

registerProcessor("playback-processor", PlaybackProcessor);
