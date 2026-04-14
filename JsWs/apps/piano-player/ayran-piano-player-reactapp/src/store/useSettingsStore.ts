import { create } from 'zustand'
import { getSetting, setSetting } from '../db/settingsDb'

interface SettingsState {
  // Key sizes
  customSizes: number[]
  activeSize: number | 'default'
  // Theme
  activeThemeId: string | null
  // Soundset
  activeSoundsetId: string | null
  // Audio
  fadeMs: number
  // Loaded flag
  loaded: boolean

  loadSettings: () => Promise<void>
  addCustomSize: (size: number) => Promise<void>
  removeCustomSize: (size: number) => Promise<void>
  setActiveSize: (size: number | 'default') => Promise<void>
  setActiveThemeId: (id: string | null) => Promise<void>
  setActiveSoundsetId: (id: string | null) => Promise<void>
  setFadeMs: (ms: number) => Promise<void>
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  customSizes: [],
  activeSize: 'default',
  activeThemeId: null,
  activeSoundsetId: null,
  fadeMs: 100,
  loaded: false,

  loadSettings: async () => {
    const [customSizes, activeSize, activeThemeId, activeSoundsetId, fadeMs] =
      await Promise.all([
        getSetting<number[]>('customSizes'),
        getSetting<number | 'default'>('activeSize'),
        getSetting<string | null>('activeThemeId'),
        getSetting<string | null>('activeSoundsetId'),
        getSetting<number>('fadeMs')
      ])
    set({
      customSizes: customSizes ?? [],
      activeSize: activeSize ?? 'default',
      activeThemeId: activeThemeId ?? null,
      activeSoundsetId: activeSoundsetId ?? null,
      fadeMs: fadeMs ?? 100,
      loaded: true
    })
  },

  addCustomSize: async (size) => {
    const { customSizes } = get()
    if (customSizes.includes(size)) return
    const next = [...customSizes, size].sort((a, b) => a - b)
    await setSetting('customSizes', next)
    set({ customSizes: next })
  },

  removeCustomSize: async (size) => {
    const { customSizes, activeSize } = get()
    const next = customSizes.filter(s => s !== size)
    await setSetting('customSizes', next)
    const updates: Partial<SettingsState> = { customSizes: next }
    if (activeSize === size) {
      updates.activeSize = 'default'
      await setSetting('activeSize', 'default')
    }
    set(updates)
  },

  setActiveSize: async (size) => {
    await setSetting('activeSize', size)
    set({ activeSize: size })
  },

  setActiveThemeId: async (id) => {
    await setSetting('activeThemeId', id)
    set({ activeThemeId: id })
  },

  setActiveSoundsetId: async (id) => {
    await setSetting('activeSoundsetId', id)
    set({ activeSoundsetId: id })
  },

  setFadeMs: async (ms) => {
    await setSetting('fadeMs', ms)
    set({ fadeMs: ms })
  }
}))
