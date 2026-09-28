import { useCallback, useEffect, useState } from 'react'
import { getAppState, setAppState } from '../../lib/appState'

/** The Notes app's own settings (its settings page), kept in its app state. */
export interface NotesSettings {
  /** Whether the notes' indexes (`001`…) are shown before their titles. */
  showIndexes: boolean
  /** The file managers list folders as thumbnails (the toolbar's *View thumbnails*) rather than as a table. */
  viewThumbnails: boolean
  /** Mirror-scroll: the syncing web app follows the note editor's own scroll position, continuously. Off by
   * default — see CLAUDE.md's "Editor ↔ syncing web app: scroll and refresh options". */
  syncScrollMirror: boolean
  /** Ctrl+Alt+arrows/PageUp/PageDown, in the editor, nudge the syncing web app's scroll — independent of
   * mirror-scroll, and on by default (it needs a deliberate key combination, so there's nothing to protect
   * against by defaulting it off). */
  syncScrollKeyboard: boolean
  /** Whether saving the note reloads its syncing web app automatically. On by default (today's behavior);
   * turning it off doesn't affect the editor's own manual "Refresh the web app" button. */
  autosync: boolean
}

const SETTINGS_KEY = 'notes.settings'
export const DEFAULT_SETTINGS: NotesSettings = {
  showIndexes: true,
  viewThumbnails: false,
  syncScrollMirror: false,
  syncScrollKeyboard: true,
  autosync: true,
}

function valid(value: unknown): NotesSettings {
  const saved = value !== null && typeof value === 'object' ? (value as Partial<NotesSettings>) : {}
  return {
    showIndexes: typeof saved.showIndexes === 'boolean' ? saved.showIndexes : DEFAULT_SETTINGS.showIndexes,
    viewThumbnails: typeof saved.viewThumbnails === 'boolean' ? saved.viewThumbnails : DEFAULT_SETTINGS.viewThumbnails,
    syncScrollMirror: typeof saved.syncScrollMirror === 'boolean' ? saved.syncScrollMirror : DEFAULT_SETTINGS.syncScrollMirror,
    syncScrollKeyboard: typeof saved.syncScrollKeyboard === 'boolean' ? saved.syncScrollKeyboard : DEFAULT_SETTINGS.syncScrollKeyboard,
    autosync: typeof saved.autosync === 'boolean' ? saved.autosync : DEFAULT_SETTINGS.autosync,
  }
}

/** The settings, and how to change one. (What was saved is checked before it is used.) */
export function useNotesSettings(): { settings: NotesSettings; loaded: boolean; change: (patch: Partial<NotesSettings>) => void } {
  const [settings, setSettings] = useState<NotesSettings>(DEFAULT_SETTINGS)
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    getAppState<unknown>(SETTINGS_KEY)
      .then((saved) => setSettings(valid(saved)))
      .catch(() => {})
      .finally(() => setLoaded(true))
  }, [])
  const change = useCallback((patch: Partial<NotesSettings>) => {
    setSettings((current) => {
      const next = { ...current, ...patch }
      setAppState(SETTINGS_KEY, next).catch(() => {})
      return next
    })
  }, [])
  return { settings, loaded, change }
}
