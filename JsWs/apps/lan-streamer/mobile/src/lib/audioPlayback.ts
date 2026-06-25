import { FRAME_SAMPLES, SAMPLE_RATE } from "./audioCapture";

export class AudioPlayback {
  private ctx: AudioContext;
  private nextStartTime = 0;

  constructor() {
    this.ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
  }

  enqueueFrame(data: ArrayBuffer): void {
    const samples = new Int16Array(data);
    const buffer = this.ctx.createBuffer(1, FRAME_SAMPLES, SAMPLE_RATE);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < FRAME_SAMPLES && i < samples.length; i++) {
      channel[i] = samples[i] / 32768;
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
