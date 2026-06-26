export const SAMPLE_RATE = 48000;
export const FRAME_SAMPLES = 960; // 20ms at 48kHz, per channel
export const CHANNELS = 2;

export type AudioSource = "microphone" | "system" | "test-tone";

const TEST_TONE_URL = "/test-tone.wav";

// Bundled test signal for verifying the pipeline (and the API's account-wide
// limiter) without needing a microphone, speakers, or a closed audio loop:
// quiet -> sudden loud -> quiet, looped (see public/test-tone.wav). Decodes
// once into an AudioBuffer and loops it through a MediaStreamDestination so
// it can flow through the exact same AudioCapture path as a real device.
async function captureTestToneStream(): Promise<MediaStream> {
  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
  const response = await fetch(TEST_TONE_URL);
  const arrayBuffer = await response.arrayBuffer();
  const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
  const source = ctx.createBufferSource();
  source.buffer = audioBuffer;
  source.loop = true;
  const destination = ctx.createMediaStreamDestination();
  source.connect(destination);
  source.start();
  return destination.stream;
}

export async function captureStream(source: AudioSource): Promise<MediaStream> {
  if (source === "microphone") {
    return navigator.mediaDevices.getUserMedia({
      // Most mic hardware is mono; requesting stereo as a preference (not a
      // hard requirement) lets genuinely stereo input mics through while
      // still working on mono ones - AudioCapture below up-mixes mono to
      // stereo either way, so callers don't need to care which happened.
      audio: { channelCount: { ideal: CHANNELS }, sampleRate: SAMPLE_RATE, echoCancellation: false, noiseSuppression: false },
    });
  }

  if (source === "test-tone") {
    return captureTestToneStream();
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
  private gainNode: GainNode;
  private processor: ScriptProcessorNode;
  private pending: number[] = [];
  private onFrame: (frame: Int16Array) => void;

  constructor(stream: MediaStream, onFrame: (frame: Int16Array) => void, initialGain = 1) {
    this.onFrame = onFrame;
    this.ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    this.sourceNode = this.ctx.createMediaStreamSource(stream);
    // Lets the device lower (never raise) its own contribution before
    // sending - independent of the API's account-wide safety cap, which
    // only ever pulls a stream *down* if it's too loud, never boosts it.
    this.gainNode = this.ctx.createGain();
    this.gainNode.gain.value = initialGain;
    // Fixing numberOfInputChannels at 2 means inputBuffer always has exactly
    // 2 channels regardless of the source's actual channel count - the Web
    // Audio graph automatically up-mixes a mono source (duplicating it to
    // both channels) to match, so handleAudioProcess never needs to branch
    // on how many channels the source actually has.
    this.processor = this.ctx.createScriptProcessor(1024, CHANNELS, CHANNELS);
    this.processor.onaudioprocess = (event) => this.handleAudioProcess(event);
    this.sourceNode.connect(this.gainNode);
    this.gainNode.connect(this.processor);
    // ScriptProcessorNode only fires onaudioprocess while connected to a
    // destination; route through a silent gain node so capture doesn't echo.
    const silentSink = this.ctx.createGain();
    silentSink.gain.value = 0;
    this.processor.connect(silentSink);
    silentSink.connect(this.ctx.destination);
  }

  setGain(value: number): void {
    this.gainNode.gain.value = value;
  }

  private handleAudioProcess(event: AudioProcessingEvent): void {
    const input = event.inputBuffer;
    const length = input.length;
    const left = input.getChannelData(0);
    const right = input.numberOfChannels > 1 ? input.getChannelData(1) : left;

    for (let i = 0; i < length; i++) {
      this.pending.push(left[i], right[i]);
    }

    const frameLength = FRAME_SAMPLES * CHANNELS;
    while (this.pending.length >= frameLength) {
      const chunk = this.pending.splice(0, frameLength);
      const frame = new Int16Array(frameLength);
      for (let i = 0; i < frameLength; i++) {
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
