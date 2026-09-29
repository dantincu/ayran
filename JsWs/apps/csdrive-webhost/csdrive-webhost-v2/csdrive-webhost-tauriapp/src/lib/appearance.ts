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

/** Whether the rotation makes up its own colours near the six key hues instead of going through the catalog
 * (`appearance.rs`'s `KEY_COLORS`/`KEY_COLOR_NAMES`, fetched with `keyColorNames`) — `mode` above is then
 * meaningless (a generated rotation always goes forward through the six) and ignored. */
export interface GeneratedColors {
  enabled: boolean
  /** How far each RGB channel may drift from the key colour it is near, 0–255 (0: exactly the key colour). */
  spread: number
}

/** Whether the theme goes through all the themes by itself, in which order, and how long each stays. */
export interface Rotation {
  enabled: boolean
  mode: RotationMode
  unit: RotationUnit
  every: number
  generated: GeneratedColors
}

/** The eight colours of a palette — a catalog theme's (`themes.ts`) or a generated one's. */
export interface ThemeColors {
  bg: string
  fg: string
  muted: string
  border: string
  accent: string
  accentFg: string
  panel: string
  hover: string
}

/** A colour scheme made up on the spot, near one of the six key hues — what a page applies in place of a catalog
 * theme while `rotation.generated.enabled`. */
export interface GeneratedPalette {
  keyIndex: number
  light: ThemeColors
  dark: ThemeColors
}

export interface Appearance {
  /** A real catalog id at all times, even while `generated` is what is actually shown — kept so switching the
   * generated rotation off falls back to the theme chosen before it was turned on. */
  theme: string
  mode: ColorMode
  rotation: Rotation
  /** Present exactly while `rotation.generated.enabled`: what a page applies instead of `theme`. */
  generated: GeneratedPalette | null
}

/** The shortest time a theme may stay (the backend refuses less): every change recolours the whole window. */
export const MIN_ROTATION_SECONDS = 30
export const UNIT_SECONDS: Record<RotationUnit, number> = { seconds: 1, minutes: 60, hours: 3600, days: 86_400 }

/** The event the backend sends every window when the appearance changes. */
export const APPEARANCE_EVENT = 'appearance-changed'

export const DEFAULT_GENERATED: GeneratedColors = { enabled: false, spread: 64 }
export const DEFAULT_ROTATION: Rotation = { enabled: false, mode: 'ascending', unit: 'minutes', every: 5, generated: DEFAULT_GENERATED }

let current: Appearance = { theme: DEFAULT_THEME, mode: 'system', rotation: DEFAULT_ROTATION, generated: null }
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

/** What actually decides the colours shown, folded into one comparable string — a generated palette's own
 * background (its `keyIndex` alone isn't enough: the same key is drawn again and again, each time with a fresh
 * RGB) or a catalog theme's id, plus the mode either way. */
const paletteKey = (a: Appearance) => `${a.generated ? `g:${a.generated.light.bg}:${a.generated.dark.bg}` : `t:${a.theme}`}:${a.mode}`

/** Puts the theme — or the generated palette, while there is one — on this page: every colour is a CSS variable
 * of the root element, so this is all the page needs. With `fade` the colours slide over to the new ones (unless
 * the person asked the device for less motion). */
export function applyAppearance(appearance: Appearance, fade = false): void {
  const changedColours = paletteKey(appearance) !== paletteKey(current)
  current = appearance
  const dark = isDark(appearance.mode)
  const root = document.documentElement
  if (fade && changedColours) {
    root.classList.add('theme-fade')
    window.clearTimeout(fadeTimer)
    fadeTimer = window.setTimeout(() => root.classList.remove('theme-fade'), FADE_MS)
  }
  // A generated palette isn't one of the catalog's named themes (no id/family/name of its own) — `variablesOf`
  // only ever looks at `.light`/`.dark`, so a plain object with those two is all it needs.
  const theme = appearance.generated ?? themeById(appearance.theme)
  for (const [name, value] of Object.entries(variablesOf(theme, dark))) root.style.setProperty(`--${name}`, value)
  root.style.colorScheme = dark ? 'dark' : 'light'
  if (document.body) document.body.style.colorScheme = dark ? 'dark' : 'light'
  root.dataset.theme = appearance.generated ? 'generated' : appearance.theme
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

function asGeneratedColors(value: unknown): GeneratedColors {
  const g = (value ?? {}) as Partial<GeneratedColors>
  return {
    enabled: g.enabled === true,
    spread: typeof g.spread === 'number' && g.spread >= 0 && g.spread <= 255 ? Math.floor(g.spread) : DEFAULT_GENERATED.spread,
  }
}

function asRotation(value: unknown): Rotation {
  const r = (value ?? {}) as Partial<Rotation>
  return {
    enabled: r.enabled === true,
    mode: r.mode === 'descending' || r.mode === 'random' ? r.mode : 'ascending',
    unit: r.unit === 'seconds' || r.unit === 'hours' || r.unit === 'days' ? r.unit : 'minutes',
    every: typeof r.every === 'number' && r.every >= 1 ? Math.floor(r.every) : DEFAULT_ROTATION.every,
    generated: asGeneratedColors(r.generated),
  }
}

/** `#rrggbb`, or a safe fallback (mid-grey) for anything else — never trusts the backend's own colours blindly
 * before they land as a CSS variable, the same caution every other saved-shape check in the app takes. */
const asHexColor = (value: unknown): string => (typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value) ? value : '#808080')

function asThemeColors(value: unknown): ThemeColors {
  const c = (value ?? {}) as Partial<ThemeColors>
  return {
    bg: asHexColor(c.bg),
    fg: asHexColor(c.fg),
    muted: asHexColor(c.muted),
    border: asHexColor(c.border),
    accent: asHexColor(c.accent),
    accentFg: asHexColor(c.accentFg),
    panel: asHexColor(c.panel),
    hover: asHexColor(c.hover),
  }
}

function asGeneratedPalette(value: unknown): GeneratedPalette | null {
  if (value === null || value === undefined) return null
  const g = value as Partial<GeneratedPalette>
  return { keyIndex: typeof g.keyIndex === 'number' ? g.keyIndex : 0, light: asThemeColors(g.light), dark: asThemeColors(g.dark) }
}

const fromBackend = (raw: { theme: string; mode: unknown; rotation?: unknown; generated?: unknown }): Appearance => ({
  theme: raw.theme,
  mode: asMode(raw.mode),
  rotation: asRotation(raw.rotation),
  generated: asGeneratedPalette(raw.generated),
})

/** Reads the appearance the backend keeps and applies it, then follows it: a change made anywhere reaches this page as an event, and (in
 * `system` mode) the device switching between light and dark is followed too. Best-effort: a page that can't ask keeps the default colours. */
export async function initAppearance(): Promise<void> {
  try {
    applyAppearance(fromBackend(await invoke('get_appearance')))
  } catch {
    applyAppearance(current)
  }
  try {
    await getCurrentWebviewWindow().listen(APPEARANCE_EVENT, (event) => applyAppearance(fromBackend(event.payload as { theme: string; mode: unknown; rotation?: unknown; generated?: unknown }), true))
  } catch {
    // No events in this window: it shows the appearance it started with.
  }
  darkQuery()?.addEventListener('change', () => {
    if (current.mode === 'system') applyAppearance(current)
  })
  // Re-reads the appearance from the backend whenever this page becomes visible again — belt and
  // suspenders alongside the live `appearance-changed` event above, not a replacement for it (the event
  // still applies a change at once while the page is in front). A window that was backgrounded for a
  // while (a rotation ticking on its own, or someone changing the theme from elsewhere) may never have
  // actually run the JS that applies a pushed update — reported live on Android, where a window left in
  // the background for a stretch came back showing the exact colour it had when it was last in front,
  // never having advanced with the rotation running the whole time in the backend. Whatever the precise
  // reason a pushed event didn't land (a suspended WebView, one that missed it outright, …), asking fresh
  // the moment the person actually looks at the page again closes the gap regardless of the cause —
  // `get_appearance` always answers with the backend's real current state. Best-effort, same as the rest
  // of this function; harmless to fire once more than strictly needed (`applyAppearance` only fades when
  // the colours actually differ).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      invoke('get_appearance').then((raw) => applyAppearance(fromBackend(raw as { theme: string; mode: unknown; rotation?: unknown; generated?: unknown }), true)).catch(() => {})
    }
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

/** The six key hues' names, in the order a generated rotation cycles through them (`appearance.rs`'s own list,
 * not a second copy kept here that could drift from it). */
export const getKeyColorNames = (): Promise<string[]> => invoke('key_color_names')
