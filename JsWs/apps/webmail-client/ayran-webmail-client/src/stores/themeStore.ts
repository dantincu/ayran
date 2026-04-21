import { create } from 'zustand'

const getInitialDark = (): boolean => {
  const stored = localStorage.getItem('darkMode')
  if (stored !== null) return stored === 'true'
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

const applyDark = (dark: boolean) => {
  document.documentElement.classList.toggle('dark', dark)
}

interface ThemeState {
  dark: boolean
  toggle: () => void
}

// Sync html.dark immediately so it matches the stored preference
// (the inline script in index.html does this too, but this handles the
// case where they diverge, e.g. after the first toggle)
const initialDark = getInitialDark()
applyDark(initialDark)

export const useThemeStore = create<ThemeState>()((set) => ({
  dark: initialDark,
  toggle: () =>
    set((state) => {
      const next = !state.dark
      localStorage.setItem('darkMode', String(next))
      applyDark(next)
      return { dark: next }
    }),
}))
