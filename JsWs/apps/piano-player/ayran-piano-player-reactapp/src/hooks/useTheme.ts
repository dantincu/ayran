import { useEffect } from 'react'
import { useSettingsStore } from '../store/useSettingsStore'
import { getTheme } from '../db/themesDb'

const STYLE_ID = 'user-theme-style'

export function useTheme(): void {
  const activeThemeId = useSettingsStore(s => s.activeThemeId)
  const loaded = useSettingsStore(s => s.loaded)

  useEffect(() => {
    if (!loaded) return

    const existing = document.getElementById(STYLE_ID)

    if (!activeThemeId) {
      existing?.remove()
      return
    }

    getTheme(activeThemeId).then(theme => {
      if (!theme) return
      const style = existing ?? document.createElement('style')
      style.id = STYLE_ID
      style.textContent = theme.css
      if (!existing) document.head.appendChild(style)
    })
  }, [activeThemeId, loaded])
}
