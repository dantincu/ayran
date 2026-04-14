import { NoteEvent } from '../db/schema'
import { noteCodeToFrequency } from '../constants/piano'
import { getSoundsetNote } from '../db/soundsetsDb'
import { audioBufferToMp3Blob } from './recorder'

const SAMPLE_RATE = 44100

export async function synthesizeBlueprint(
  blueprint: NoteEvent[],
  soundsetId: string | null,
  fadeMs: number
): Promise<AudioBuffer> {
  if (blueprint.length === 0) {
    const ctx = new OfflineAudioContext(1, SAMPLE_RATE, SAMPLE_RATE)
    return ctx.startRendering()
  }

  const totalMs =
    Math.max(...blueprint.map(e => e.timestamp + e.duration)) +
    fadeMs + 1000 // tail

  const totalSamples = Math.ceil((totalMs / 1000) * SAMPLE_RATE)
  const offlineCtx = new OfflineAudioContext(2, totalSamples, SAMPLE_RATE)

  // Pre-load all soundset buffers needed
  const bufferCache = new Map<string, AudioBuffer>()
  if (soundsetId) {
    const uniqueNotes = [...new Set(blueprint.map(e => e.note))]
    await Promise.all(
      uniqueNotes.map(async note => {
        const record = await getSoundsetNote(soundsetId, note)
        if (!record) return
        try {
          const ab = await record.blob.arrayBuffer()
          const buf = await offlineCtx.decodeAudioData(ab)
          bufferCache.set(note, buf)
        } catch {}
      })
    )
  }

  for (const event of blueprint) {
    const startSec = event.timestamp / 1000
    const holdSec = Math.max(event.duration, fadeMs) / 1000
    const fadeSec = fadeMs / 1000
    const stopSec = startSec + holdSec + fadeSec + 0.05

    const gainNode = offlineCtx.createGain()
    gainNode.gain.setValueAtTime(0.7, startSec)
    gainNode.gain.setValueAtTime(0.7, startSec + holdSec)
    gainNode.gain.linearRampToValueAtTime(0, startSec + holdSec + fadeSec)
    gainNode.connect(offlineCtx.destination)

    const soundBuf = bufferCache.get(event.note)
    if (soundBuf) {
      const src = offlineCtx.createBufferSource()
      src.buffer = soundBuf
      src.connect(gainNode)
      src.start(startSec)
      src.stop(Math.min(stopSec, startSec + soundBuf.duration))
    } else {
      const osc = offlineCtx.createOscillator()
      osc.type = 'triangle'
      osc.frequency.value = noteCodeToFrequency(event.note)
      osc.connect(gainNode)
      osc.start(startSec)
      osc.stop(stopSec)
    }
  }

  return offlineCtx.startRendering()
}

export async function blueprintToMp3Blob(
  blueprint: NoteEvent[],
  soundsetId: string | null,
  fadeMs: number
): Promise<Blob> {
  const audioBuffer = await synthesizeBlueprint(blueprint, soundsetId, fadeMs)
  return audioBufferToMp3Blob(audioBuffer)
}
