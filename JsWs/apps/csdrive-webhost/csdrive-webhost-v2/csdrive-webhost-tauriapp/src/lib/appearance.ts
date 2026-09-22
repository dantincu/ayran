import { invoke } from '@tauri-apps/api/core'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { DEFAULT_THEME, themeById, variablesOf } from './themes'

/** The app's appearance — which theme, whether it is light, dark or the device's own, and whether the theme rotates through all of them — is
 * one choice for every page of the admin-app and of the system apps. The backend keeps it (`appearance.rs`) and tells every window when it
 * changes; a page applies it with `applyAppearance`. Any window may choose the theme and the mode (`setAppearance`); only the admin-app sets
 * the rotation (`setRotation`). Nothing is kept in browser storage. */
export type ColorMode = 'system' | 'light' | 'dark'
export type RotationMode = 'ascending' | 'descending' | 'random'
export type RotationUnit = 'seconds' | 'minutes' | 'hours' | 'days'

/** Whether the theme goes through all the themes by itself, in which order, and how long each stays. */
export interface Rotation {
  enabled: boolean
  mode: RotationMode
  unit: RotationUnit
  every: number
}

export interface Appearance {
  theme: string
  mode: ColorMode
  rotation: Rotation
}

/** The shortest time a theme may stay (the backend refuses less): every change recolours the whole window. */
export const MIN_ROTATION_SECONDS = 30
export const UNIT_SECONDS: Record<RotationUnit, number> = { seconds: 1, minutes: 60, hours: 3600, days: 86_400 }

/** The event the backend sends every window when the appearance changes. */
export const APPEARANCE_EVENT = 'appearance-changed'

export const DEFAULT_ROTATION: Rotation = { enabled: false, mode: 'ascending', unit: 'minutes', every: 5 }

let current: Appearance = { theme: DEFAULT_THEME, mode: 'system', rotation: DEFAULT_ROTATION }
const listeners = new Set<(appearance: Appearance) => void>()

const darkQuery = () => (typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null)

/** Whether this page shows the dark palette: the mode says so, or leaves it to the device (`system`). */
export function isDark(mode: ColorMode): boolean {
  if (mode === 'dark') return true
  if (mode === 'light') return false
  return darkQuery()?.matches ?? false
}

/** How long the colours take to give way to the next theme's (a change is never a flash). */
const FADE_MS = 700
let fadeTimer: number | undefined

/** Puts the theme on this page: every colour is a CSS variable of the root element, so this is all the page needs. With `fade` the colours
 * slide over to the new ones (unless the person asked the device for less motion). */
export function applyAppearance(appearance: Appearance, fade = false): void {
  const changedColours = appearance.theme !== current.theme || appearance.mode !== current.mode
  current = appearance
  const dark = isDark(appearance.mode)
  const root = document.documentElement
  if (fade && changedColours) {
    root.classList.add('theme-fade')
    window.clearTimeout(fadeTimer)
    fadeTimer = window.setTimeout(() => root.classList.remove('theme-fade'), FADE_MS)
  }
  const theme = themeById(appearance.theme)
  for (const [name, value] of Object.entries(variablesOf(theme, dark))) root.style.setProperty(`--${name}`, value)
  root.style.colorScheme = dark ? 'dark' : 'light'
  if (document.body) document.body.style.colorScheme = dark ? 'dark' : 'light'
  root.dataset.theme = theme.id
  root.dataset.mode = dark ? 'dark' : 'light'
  listeners.forEach((listener) => listener(appearance))
}

/** What is applied to this page now. */
export function currentAppearance(): Appearance {
  return current
}

/** Calls `listener` whenever the appearance is applied to this page (the settings dialog keeps up with a change made elsewhere). */
export function subscribeAppearance(listener: (appearance: Appearance) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const asMode = (value: unknown): ColorMode => (value === 'light' || value === 'dark' ? value : 'system')

function asRotation(value: unknown): Rotation {
  const r = (value ?? {}) as Partial<Rotation>
  return {
    enabled: r.enabled === true,
    mode: r.mode === 'descending' || r.mode === 'random' ? r.mode : 'ascending',
    unit: r.unit === 'seconds' || r.unit === 'hours' || r.unit === 'days' ? r.unit : 'minutes',
    every: typeof r.every === 'number' && r.every >= 1 ? Math.floor(r.every) : DEFAULT_ROTATION.every,
  }
}

const fromBackend = (raw: { theme: string; mode: unknown; rotation?: unknown }): Appearance => ({ theme: raw.theme, mode: asMode(raw.mode), rotation: asRotation(raw.rotation) })

/** Reads the appearance the backend keeps and applies it, then follows it: a change made anywhere reaches this page as an event, and (in
 * `system` mode) the device switching between light and dark is followed too. Best-effort: a page that can't ask keeps the default colours. */
export async function initAppearance(): Promise<void> {
  try {
    applyAppearance(fromBackend(await invoke('get_appearance')))
  } catch {
    applyAppearance(current)
  }
  try {
    await getCurrentWebviewWindow().listen(APPEARANCE_EVENT, (event) => applyAppearance(fromBackend(event.payload as { theme: string; mode: unknown; rotation?: unknown }), true))
  } catch {
    // No events in this window: it shows the appearance it started with.
  }
  darkQuery()?.addEventListener('change', () => {
    if (current.mode === 'system') applyAppearance(current)
  })
}

/** Chooses the theme and the mode for the whole app. A rotation that is on goes on from there. */
export async function setAppearance(choice: { theme: string; mode: ColorMode }): Promise<void> {
  applyAppearance(fromBackend(await invoke('set_appearance', { theme: choice.theme, mode: choice.mode })), true)
}

/** Sets the rotation through the themes. Only the admin-app is allowed to (the backend refuses anyone else). */
export async function setRotation(rotation: Rotation): Promise<void> {
  applyAppearance(fromBackend(await invoke('set_appearance_rotation', { rotation })))
}
