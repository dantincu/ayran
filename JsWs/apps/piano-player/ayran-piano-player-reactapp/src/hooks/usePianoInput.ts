import { useCallback, useRef } from 'react'
import { useSettingsStore } from '../store/useSettingsStore'
import { useRecordingStore } from '../store/useRecordingStore'
import { playSynthNote, stopSynthNoteWithMinDuration } from '../audio/synth'
import { playSoundsetNote, stopSoundsetNoteWithMinDuration } from '../audio/soundsetPlayer'

export type PressedKeys = Set<string>

export function usePianoInput(
  pressedKeys: React.MutableRefObject<PressedKeys>,
  onKeysChange: (keys: Set<string>) => void
) {
  const { activeSoundsetId, fadeMs } = useSettingsStore()
  const { state: recordingState, startedAt: recordingStart, addNoteEvent } = useRecordingStore()

  // Map from pointerId -> noteCode currently held by that pointer
  const pointerNoteMap = useRef(new Map<number, string>())
  // pressedAt[noteCode] = timestamp when note started
  const pressedAt = useRef(new Map<string, number>())

  const pressNote = useCallback((noteCode: string) => {
    if (pressedKeys.current.has(noteCode)) return
    pressedKeys.current = new Set([...pressedKeys.current, noteCode])
    onKeysChange(pressedKeys.current)

    const now = Date.now()
    pressedAt.current.set(noteCode, now)

    if (activeSoundsetId) {
      playSoundsetNote(activeSoundsetId, noteCode, fadeMs).catch(() => {
        // Fallback to synth if note not found in soundset
        playSynthNote(noteCode, fadeMs)
      })
    } else {
      playSynthNote(noteCode, fadeMs)
    }
  }, [activeSoundsetId, fadeMs, pressedKeys, onKeysChange])

  const releaseNote = useCallback((noteCode: string) => {
    if (!pressedKeys.current.has(noteCode)) return
    const next = new Set(pressedKeys.current)
    next.delete(noteCode)
    pressedKeys.current = next
    onKeysChange(pressedKeys.current)

    const startTime = pressedAt.current.get(noteCode) ?? Date.now()
    const duration = Date.now() - startTime
    pressedAt.current.delete(noteCode)

    const minFade = useSettingsStore.getState().fadeMs

    if (activeSoundsetId) {
      stopSoundsetNoteWithMinDuration(noteCode, startTime, fadeMs, minFade)
    } else {
      stopSynthNoteWithMinDuration(noteCode, startTime, fadeMs, minFade)
    }

    // Record note event
    if (recordingState === 'recording' && recordingStart !== null) {
      addNoteEvent({
        timestamp: startTime - recordingStart,
        note: noteCode,
        duration
      })
    }
  }, [activeSoundsetId, fadeMs, pressedKeys, onKeysChange, recordingState, recordingStart, addNoteEvent])

  const onPointerDown = useCallback((noteCode: string, pointerId: number) => {
    pointerNoteMap.current.set(pointerId, noteCode)
    pressNote(noteCode)
  }, [pressNote])

  const onPointerUp = useCallback((pointerId: number) => {
    const noteCode = pointerNoteMap.current.get(pointerId)
    if (noteCode) {
      pointerNoteMap.current.delete(pointerId)
      releaseNote(noteCode)
    }
  }, [releaseNote])

  const onPointerEnter = useCallback((noteCode: string, pointerId: number) => {
    // Glissando: if pointer is already down when entering a new key
    if (pointerNoteMap.current.has(pointerId)) {
      const prevNote = pointerNoteMap.current.get(pointerId)!
      if (prevNote !== noteCode) {
        releaseNote(prevNote)
        pointerNoteMap.current.set(pointerId, noteCode)
        pressNote(noteCode)
      }
    }
  }, [pressNote, releaseNote])

  return { onPointerDown, onPointerUp, onPointerEnter }
}
