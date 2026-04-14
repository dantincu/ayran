import { getAudioContext, getMasterGain } from './AudioEngine'
import { getSoundsetNote } from '../db/soundsetsDb'

export type SoundsetNotePlayer = {
  source: AudioBufferSourceNode
  gainNode: GainNode
  finished: boolean
  releaseTimeout: ReturnType<typeof setTimeout> | null
}

const activePlayers = new Map<string, SoundsetNotePlayer>()
// Cache decoded audio buffers to avoid repeated decoding
const bufferCache = new Map<string, AudioBuffer>()

export async function playSoundsetNote(
  soundsetId: string,
  noteCode: string,
  fadeMs: number
): Promise<SoundsetNotePlayer | null> {
  stopSoundsetNote(noteCode, 0)

  const ctx = getAudioContext()
  const cacheKey = `${soundsetId}:${noteCode}`

  let buffer = bufferCache.get(cacheKey)
  if (!buffer) {
    const noteRecord = await getSoundsetNote(soundsetId, noteCode)
    if (!noteRecord) return null

    const arrayBuffer = await noteRecord.blob.arrayBuffer()
    buffer = await ctx.decodeAudioData(arrayBuffer)
    bufferCache.set(cacheKey, buffer)
  }

  const gainNode = ctx.createGain()
  gainNode.gain.value = 0.9
  gainNode.connect(getMasterGain())

  const source = ctx.createBufferSource()
  source.buffer = buffer
  source.connect(gainNode)

  const player: SoundsetNotePlayer = {
    source,
    gainNode,
    finished: false,
    releaseTimeout: null
  }

  source.onended = () => {
    player.finished = true
  }

  source.start()
  activePlayers.set(noteCode, player)
  return player
}

export function stopSoundsetNote(noteCode: string, fadeMs: number): void {
  const player = activePlayers.get(noteCode)
  if (!player) return
  activePlayers.delete(noteCode)

  if (player.releaseTimeout !== null) {
    clearTimeout(player.releaseTimeout)
    player.releaseTimeout = null
  }

  // If the MP3 already finished, don't try to fade
  if (player.finished) return

  const ctx = getAudioContext()
  const gain = player.gainNode.gain
  const now = ctx.currentTime
  const fadeSec = Math.max(0.01, fadeMs / 1000)

  try {
    gain.cancelScheduledValues(now)
    gain.setValueAtTime(gain.value, now)
    gain.linearRampToValueAtTime(0, now + fadeSec)
    player.source.stop(now + fadeSec + 0.05)
  } catch {}
}

export function stopSoundsetNoteWithMinDuration(
  noteCode: string,
  pressedAt: number,
  fadeMs: number,
  minFadeMs: number
): void {
  const player = activePlayers.get(noteCode)
  if (!player) return

  if (player.finished) {
    activePlayers.delete(noteCode)
    return
  }

  const elapsed = Date.now() - pressedAt
  const remaining = Math.max(0, minFadeMs - elapsed)

  if (remaining > 0) {
    player.releaseTimeout = setTimeout(() => {
      stopSoundsetNote(noteCode, fadeMs)
    }, remaining)
  } else {
    stopSoundsetNote(noteCode, fadeMs)
  }
}

export function clearBufferCache(soundsetId?: string): void {
  if (soundsetId) {
    for (const key of bufferCache.keys()) {
      if (key.startsWith(`${soundsetId}:`)) {
        bufferCache.delete(key)
      }
    }
  } else {
    bufferCache.clear()
  }
}
