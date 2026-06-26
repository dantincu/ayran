import { CHANNELS, FRAME_SAMPLES, SAMPLE_RATE } from "./audioCapture";

export class AudioPlayback {
  private ctx: AudioContext;
  private nextStartTime = 0;

  constructor() {
    this.ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
  }

  enqueueFrame(data: ArrayBuffer): void {
    const samples = new Int16Array(data);
    const buffer = this.ctx.createBuffer(CHANNELS, FRAME_SAMPLES, SAMPLE_RATE);
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);
    for (let i = 0; i < FRAME_SAMPLES; i++) {
      const base = i * CHANNELS;
      if (base + 1 >= samples.length) break;
      left[i] = samples[base] / 32768;
      right[i] = samples[base + 1] / 32768;
    }

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.ctx.destination);

    const now = this.ctx.currentTime;
    if (this.nextStartTime < now) this.nextStartTime = now;
    source.start(this.nextStartTime);
    this.nextStartTime += buffer.duration;
  }

  stop(): void {
    void this.ctx.close();
  }
}
