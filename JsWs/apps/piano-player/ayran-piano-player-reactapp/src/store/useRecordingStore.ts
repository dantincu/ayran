import { create } from 'zustand'
import { NoteEvent } from '../db/schema'

export type RecordingState = 'idle' | 'recording' | 'paused' | 'stopped'

interface RecordingStore {
  state: RecordingState
  blueprint: NoteEvent[]
  startedAt: number | null
  // Unsaved current recording (persisted from last session or stopped recording)
  currentBlueprint: NoteEvent[] | null
  currentStartedAt: number | null
  showSavePopup: boolean

  startRecording: () => void
  pauseRecording: () => void
  resumeRecording: () => void
  stopRecording: () => void
  addNoteEvent: (event: NoteEvent) => void
  setCurrentRecording: (blueprint: NoteEvent[], startedAt: number) => void
  clearCurrentRecording: () => void
  closeSavePopup: () => void
}

export const useRecordingStore = create<RecordingStore>((set, get) => ({
  state: 'idle',
  blueprint: [],
  startedAt: null,
  currentBlueprint: null,
  currentStartedAt: null,
  showSavePopup: false,

  startRecording: () => {
    set({
      state: 'recording',
      blueprint: [],
      startedAt: Date.now(),
      currentBlueprint: null,
      currentStartedAt: null,
      showSavePopup: false
    })
  },

  pauseRecording: () => {
    if (get().state === 'recording') {
      set({ state: 'paused' })
    }
  },

  resumeRecording: () => {
    if (get().state === 'paused') {
      set({ state: 'recording' })
    }
  },

  stopRecording: () => {
    const { blueprint, startedAt } = get()
    set({
      state: 'stopped',
      currentBlueprint: blueprint,
      currentStartedAt: startedAt,
      blueprint: [],
      startedAt: null,
      showSavePopup: true
    })
  },

  addNoteEvent: (event) => {
    set(s => ({ blueprint: [...s.blueprint, event] }))
  },

  setCurrentRecording: (blueprint, startedAt) => {
    set({ currentBlueprint: blueprint, currentStartedAt: startedAt })
  },

  clearCurrentRecording: () => {
    set({ currentBlueprint: null, currentStartedAt: null, state: 'idle' })
  },

  closeSavePopup: () => {
    set({ showSavePopup: false, state: 'idle' })
  }
}))
