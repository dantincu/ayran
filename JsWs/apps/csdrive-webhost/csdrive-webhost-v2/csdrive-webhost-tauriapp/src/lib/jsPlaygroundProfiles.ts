/** The JS Playground's own "profiles" — named pieces of JavaScript, each editable from a code editor, one
 * of which (if any) runs automatically whenever a new playground window opens (see CLAUDE.md's "JS
 * Playground" — the PowerShell-profile analogy the person themselves gave). Kept as one JSON blob under one
 * app-state key, not two separate keys (the list, and which one is active) — writing both together from the
 * same state is what keeps `activeId` from ever pointing at a profile that's since been deleted. */

import { getAppState, setAppState } from './appState'

export interface JsPlaygroundProfile {
  id: string
  name: string
  code: string
}

export interface JsPlaygroundProfiles {
  profiles: JsPlaygroundProfile[]
  /** The one profile (if any) whose code runs automatically when a new playground window opens. */
  activeId: string | null
}

const KEY = 'jsPlayground.profiles'

const EMPTY: JsPlaygroundProfiles = { profiles: [], activeId: null }

/** What was saved is never trusted blindly (the same rule every other saved shape in this app follows) — a
 * malformed or missing value falls back to `EMPTY` rather than throwing, and `activeId` is dropped back to
 * `null` if it no longer names a real profile. */
function sanitize(value: unknown): JsPlaygroundProfiles {
  if (typeof value !== 'object' || value === null) return EMPTY
  const raw = value as { profiles?: unknown; activeId?: unknown }
  const profiles = Array.isArray(raw.profiles)
    ? raw.profiles.filter(
        (p): p is JsPlaygroundProfile => typeof p === 'object' && p !== null && typeof (p as JsPlaygroundProfile).id === 'string' && typeof (p as JsPlaygroundProfile).name === 'string' && typeof (p as JsPlaygroundProfile).code === 'string',
      )
    : []
  const activeId = typeof raw.activeId === 'string' && profiles.some((p) => p.id === raw.activeId) ? raw.activeId : null
  return { profiles, activeId }
}

export async function loadJsPlaygroundProfiles(): Promise<JsPlaygroundProfiles> {
  const saved = await getAppState<JsPlaygroundProfiles>(KEY)
  return saved === undefined ? EMPTY : sanitize(saved)
}

export function saveJsPlaygroundProfiles(value: JsPlaygroundProfiles): Promise<void> {
  return setAppState(KEY, value)
}
