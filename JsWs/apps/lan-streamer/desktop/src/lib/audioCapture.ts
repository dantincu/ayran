export const SAMPLE_RATE = 48000;
export const FRAME_SAMPLES = 960; // 20ms at 48kHz

export type AudioSource = "microphone" | "system";

export async function captureStream(source: AudioSource): Promise<MediaStream> {
  if (source === "microphone") {
    return navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, sampleRate: SAMPLE_RATE, echoCancellation: false, noiseSuppression: false },
    });
  }

  // System/speaker loopback: capture audio while sharing the screen.
  // The user must enable "Share audio" / "Share system audio" in the picker.
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  stream.getVideoTracks().forEach((track) => track.stop());
  if (stream.getAudioTracks().length === 0) {
    throw new Error("No system audio was shared. Re-select the source and enable audio sharing.");
  }
  return stream;
}

export class AudioCapture {
  private ctx: AudioContext;
  private sourceNode: MediaStreamAudioSourceNode;
  private processor: ScriptProcessorNode;
  private pending: number[] = [];
  private onFrame: (frame: Int16Array) => void;

  constructor(stream: MediaStream, onFrame: (frame: Int16Array) => void) {
    this.onFrame = onFrame;
    this.ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    this.sourceNode = this.ctx.createMediaStreamSource(stream);
    this.processor = this.ctx.createScriptProcessor(1024, 1, 1);
    this.processor.onaudioprocess = (event) => this.handleAudioProcess(event);
    this.sourceNode.connect(this.processor);
    // ScriptProcessorNode only fires onaudioprocess while connected to a
    // destination; route through a silent gain node so capture doesn't echo.
    const silentSink = this.ctx.createGain();
    silentSink.gain.value = 0;
    this.processor.connect(silentSink);
    silentSink.connect(this.ctx.destination);
  }

  private handleAudioProcess(event: AudioProcessingEvent): void {
    const input = event.inputBuffer;
    const channelCount = input.numberOfChannels;
    const length = input.length;
    const mono = new Float32Array(length);

    for (let ch = 0; ch < channelCount; ch++) {
      const data = input.getChannelData(ch);
      for (let i = 0; i < length; i++) mono[i] += data[i] / channelCount;
    }

    for (let i = 0; i < length; i++) this.pending.push(mono[i]);

    while (this.pending.length >= FRAME_SAMPLES) {
      const chunk = this.pending.splice(0, FRAME_SAMPLES);
      const frame = new Int16Array(FRAME_SAMPLES);
      for (let i = 0; i < FRAME_SAMPLES; i++) {
        const clamped = Math.max(-1, Math.min(1, chunk[i]));
        frame[i] = Math.round(clamped * 32767);
      }
      this.onFrame(frame);
    }
  }

  stop(): void {
    this.processor.disconnect();
    this.sourceNode.disconnect();
    void this.ctx.close();
  }
}
