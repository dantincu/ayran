// Singleton Web Audio API engine

let audioContext: AudioContext | null = null
let masterGain: GainNode | null = null
let recordingDestination: MediaStreamAudioDestinationNode | null = null
let isRecording = false

export function getAudioContext(): AudioContext {
  if (!audioContext) {
    audioContext = new AudioContext()
    masterGain = audioContext.createGain()
    masterGain.gain.value = 0.8
    masterGain.connect(audioContext.destination)
  }
  if (audioContext.state === 'suspended') {
    audioContext.resume()
  }
  return audioContext
}

export function getMasterGain(): GainNode {
  getAudioContext()
  return masterGain!
}

export function startCapture(): MediaStream {
  const ctx = getAudioContext()
  recordingDestination = ctx.createMediaStreamDestination()
  masterGain!.connect(recordingDestination)
  isRecording = true
  return recordingDestination.stream
}

export function stopCapture(): void {
  if (recordingDestination && masterGain) {
    try {
      masterGain.disconnect(recordingDestination)
    } catch {}
    recordingDestination = null
  }
  isRecording = false
}

export function isCapturing(): boolean {
  return isRecording
}
