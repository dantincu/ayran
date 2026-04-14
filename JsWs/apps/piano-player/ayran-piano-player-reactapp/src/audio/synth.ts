import { noteCodeToFrequency } from '../constants/piano'
import { getLoudnessGain } from '../utils/loudness'
import { getAudioContext, getMasterGain } from './AudioEngine'

export type SynthNote = {
  oscillator: OscillatorNode
  gainNode: GainNode
  finished: boolean
  releaseTimeout: ReturnType<typeof setTimeout> | null
}

const activeNotes = new Map<string, SynthNote>()

export function playSynthNote(noteCode: string, fadeMs: number): SynthNote {
  stopSynthNote(noteCode, 0)

  const ctx = getAudioContext()
  const freq = noteCodeToFrequency(noteCode)

  const targetGain = getLoudnessGain(noteCode)
  const gainNode = ctx.createGain()
  gainNode.gain.setValueAtTime(0.001, ctx.currentTime)
  gainNode.gain.exponentialRampToValueAtTime(targetGain, ctx.currentTime + 0.01)
  gainNode.connect(getMasterGain())

  const oscillator = ctx.createOscillator()
  oscillator.type = 'triangle'
  oscillator.frequency.value = freq
  oscillator.connect(gainNode)
  oscillator.start()

  const note: SynthNote = {
    oscillator,
    gainNode,
    finished: false,
    releaseTimeout: null
  }

  oscillator.onended = () => { note.finished = true }

  activeNotes.set(noteCode, note)
  return note
}

export function stopSynthNote(noteCode: string, fadeMs: number): void {
  const note = activeNotes.get(noteCode)
  if (!note) return
  activeNotes.delete(noteCode)

  if (note.releaseTimeout !== null) {
    clearTimeout(note.releaseTimeout)
    note.releaseTimeout = null
  }

  const ctx = getAudioContext()
  const gain = note.gainNode.gain
  const now = ctx.currentTime
  const fadeSec = Math.max(0.01, fadeMs / 1000)

  try {
    gain.cancelScheduledValues(now)
    gain.setValueAtTime(gain.value, now)
    gain.linearRampToValueAtTime(0, now + fadeSec)
    note.oscillator.stop(now + fadeSec + 0.05)
  } catch {}
}

export function stopSynthNoteWithMinDuration(
  noteCode: string,
  pressedAt: number,
  fadeMs: number,
  minFadeMs: number
): void {
  const elapsed = Date.now() - pressedAt
  const remaining = Math.max(0, minFadeMs - elapsed)

  const note = activeNotes.get(noteCode)
  if (!note) return

  if (remaining > 0) {
    note.releaseTimeout = setTimeout(() => {
      stopSynthNote(noteCode, fadeMs)
    }, remaining)
  } else {
    stopSynthNote(noteCode, fadeMs)
  }
}
