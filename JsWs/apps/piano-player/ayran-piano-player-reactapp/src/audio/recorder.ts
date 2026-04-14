import { startCapture, stopCapture } from './AudioEngine'

let mediaRecorder: MediaRecorder | null = null
let chunks: Blob[] = []

export function startRecording(): void {
  const stream = startCapture()
  chunks = []

  // Try to use audio/webm or fallback
  const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus'
    : MediaRecorder.isTypeSupported('audio/webm')
    ? 'audio/webm'
    : ''

  mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : {})
  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data)
  }
  mediaRecorder.start(100) // collect chunks every 100ms
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

export function stopRecordingAndGetBlob(): Promise<Blob> {
  return new Promise((resolve, reject) => {
    if (!mediaRecorder) {
      reject(new Error('No active recording'))
      return
    }

    mediaRecorder.onstop = () => {
      const blob = new Blob(chunks, {
        type: mediaRecorder!.mimeType || 'audio/webm'
      })
      chunks = []
      stopCapture()
      resolve(blob)
    }

    mediaRecorder.onerror = (e) => {
      stopCapture()
      reject(e)
    }

    mediaRecorder.stop()
  })
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
