// lamejs is loaded as a global script via /lame.min.js in index.html
declare const lamejs: { Mp3Encoder: new (channels: number, sampleRate: number, kbps: number) => {
  encodeBuffer(left: Int16Array, right?: Int16Array): Int16Array
  flush(): Int16Array
}}
import { startCapture, stopCapture } from './AudioEngine'

let mediaRecorder: MediaRecorder | null = null
let chunks: Blob[] = []

export function startRecording(): void {
  const stream = startCapture()
  chunks = []

  const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus'
    : MediaRecorder.isTypeSupported('audio/webm')
    ? 'audio/webm'
    : ''

  mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : {})
  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data)
  }
  mediaRecorder.start(100)
}

export function pauseRecording(): void {
  if (mediaRecorder?.state === 'recording') {
    mediaRecorder.pause()
  }
}

export function resumeMediaRecording(): void {
  if (mediaRecorder?.state === 'paused') {
    mediaRecorder.resume()
  }
}

function floatToInt16(float32: Float32Array): Int16Array {
  const int16 = new Int16Array(float32.length)
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]))
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return int16
}

async function webmToMp3(webmBlob: Blob): Promise<Blob> {
  const arrayBuffer = await webmBlob.arrayBuffer()
  const ctx = new AudioContext()
  const audioBuffer = await ctx.decodeAudioData(arrayBuffer)
  await ctx.close()

  const numChannels = Math.min(audioBuffer.numberOfChannels, 2) as 1 | 2
  const sampleRate = audioBuffer.sampleRate
  const encoder = new lamejs.Mp3Encoder(numChannels, sampleRate, 128)

  const left = floatToInt16(audioBuffer.getChannelData(0))
  const right = numChannels === 2 ? floatToInt16(audioBuffer.getChannelData(1)) : undefined

  const mp3Parts: Int16Array[] = []
  const blockSize = 1152

  for (let i = 0; i < left.length; i += blockSize) {
    const leftChunk = left.subarray(i, i + blockSize)
    const buf = right
      ? encoder.encodeBuffer(leftChunk, right.subarray(i, i + blockSize))
      : encoder.encodeBuffer(leftChunk)
    if (buf.length > 0) mp3Parts.push(buf)
  }

  const flush = encoder.flush()
  if (flush.length > 0) mp3Parts.push(flush)

  return new Blob(mp3Parts.map(p => p.buffer as ArrayBuffer), { type: 'audio/mp3' })
}

export async function stopRecordingAndGetBlob(): Promise<Blob> {
  const webmBlob = await new Promise<Blob>((resolve, reject) => {
    if (!mediaRecorder) { reject(new Error('No active recording')); return }

    mediaRecorder.onstop = () => {
      const blob = new Blob(chunks, { type: mediaRecorder!.mimeType || 'audio/webm' })
      chunks = []
      stopCapture()
      resolve(blob)
    }
    mediaRecorder.onerror = (e) => { stopCapture(); reject(e) }
    mediaRecorder.stop()
  })

  return webmToMp3(webmBlob)
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
