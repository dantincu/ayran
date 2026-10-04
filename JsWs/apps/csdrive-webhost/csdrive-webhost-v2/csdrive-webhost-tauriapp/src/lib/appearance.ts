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

/** The colours of a generated palette — a superset of a catalog theme's own `Palette` (`themes.ts`), which has no
 * `accentText` of its own: a catalog theme's `accent` already doubles as its own text colour by the author's own
 * choice, so the app's CSS falls back to plain `--accent` for one; only a generated palette's `accent` — the raw,
 * un-blended drawn key colour — needs a second, contrast-guaranteed stand-in for it (see `appearance.rs`'s
 * `readable_variant_of` for the full story of why). */
export interface ThemeColors {
  bg: string
  fg: string
  muted: string
  border: string
  accent: string
  accentFg: string
  /** A reduced-vividness stand-in for `accent`, for the handful of places the app's own CSS uses the accent colour
   * as literal text directly on the page's background rather than as a button's own background. */
  accentText: string
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

/** A colour scheme the person saved for picking again later — the one way a *generated* draw (otherwise gone the
 * moment the rotation moves on, or the app closes) can be kept. Its `id` is never one of the catalog's own
 * (`custom-<uuid>`, made on save), and a page resolves it from its own `light`/`dark` rather than the compiled-in
 * `THEMES` catalog, since nothing about it exists anywhere but this one saved record. */
export interface CustomTheme {
  id: string
  name: string
  light: ThemeColors
  dark: ThemeColors
}

export interface Appearance {
  /** A real catalog id, or a saved custom theme's, at all times — even while `generated` is what is actually
   * shown — kept so switching the generated rotation off falls back to the theme chosen before it was turned on. */
  theme: string
  mode: ColorMode
  rotation: Rotation
  /** Present exactly while `rotation.generated.enabled`: what a page applies instead of `theme`. */
  generated: GeneratedPalette | null
  /** Present exactly while `rotation.generated.enabled` *and* at least one rotation tick has happened since it was
   * turned on — the one the rotation just moved on from, so a saved-theme dialog can still offer to save it even
   * after `generated` itself has already moved to a fresh draw. */
  previousGenerated: GeneratedPalette | null
  /** The full record for `theme`, sent inline whenever it names a saved custom theme rather than a catalog one —
   * see the backend's own `Appearance.custom` for why (a custom theme's colours exist nowhere else, so a page
   * applying this needs no separate fetch to resolve them). */
  custom: CustomTheme | null
}

/** The shortest time a theme may stay (the backend refuses less) — one second, so the rotation can be watched happening while testing. */
export const MIN_ROTATION_SECONDS = 1
export const UNIT_SECONDS: Record<RotationUnit, number> = { seconds: 1, minutes: 60, hours: 3600, days: 86_400 }

/** The event the backend sends every window when the appearance changes. */
export const APPEARANCE_EVENT = 'appearance-changed'

export const DEFAULT_GENERATED: GeneratedColors = { enabled: false, spread: 64 }
export const DEFAULT_ROTATION: Rotation = { enabled: false, mode: 'ascending', unit: 'minutes', every: 5, generated: DEFAULT_GENERATED }

let current: Appearance = { theme: DEFAULT_THEME, mode: 'system', rotation: DEFAULT_ROTATION, generated: null, previousGenerated: null, custom: null }
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

/** What actually decides the colours shown, folded into one comparable string — a generated or custom palette's
 * own background (its id alone isn't enough for a generated one: the same key is drawn again and again, each
 * time with a fresh RGB) or a catalog theme's id, plus the mode either way. */
const paletteKey = (a: Appearance) =>
  `${a.generated ? `g:${a.generated.light.bg}:${a.generated.dark.bg}` : a.custom ? `c:${a.custom.id}` : `t:${a.theme}`}:${a.mode}`

/** The colours this page actually draws with right now — a generated draw, a saved custom theme, or a catalog
 * one — whichever `appearance` names. Used by `applyAppearance` and by anything that needs today's own accent
 * for a readable-as-text stand-in (there is none for a catalog theme, whose own `accent` already doubles as one). */
const activeColors = (appearance: Appearance, dark: boolean): ThemeColors | null => {
  const generatedOrCustom = appearance.generated ?? appearance.custom
  return generatedOrCustom ? (dark ? generatedOrCustom.dark : generatedOrCustom.light) : null
}

/** Puts the theme — or the generated/custom palette, while there is one — on this page: every colour is a CSS
 * variable of the root element, so this is all the page needs. With `fade` the colours slide over to the new
 * ones (unless the person asked the device for less motion). */
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
  // Neither a generated draw nor a saved custom theme is one of the catalog's named themes (no id/family/name of
  // its own) — `variablesOf` only ever looks at `.light`/`.dark`, so a plain object with those two is all it needs.
  const theme = appearance.generated ?? appearance.custom ?? themeById(appearance.theme)
  for (const [name, value] of Object.entries(variablesOf(theme, dark))) root.style.setProperty(`--${name}`, value)
  // `--accent-text` has no counterpart in a catalog theme's own `Palette` (`themes.ts`), so `variablesOf` above
  // never sets it — the CSS that needs a readable-as-text accent falls back to plain `--accent` there
  // (`var(--accent-text, var(--accent))`), which is exactly right for a hand-made theme, whose own `accent` was
  // already chosen to work as text too. Only a generated palette actually has this field, so it's the one place
  // that sets — and, switching back to a catalog theme, un-sets — the variable at all.
  //
  // `--tok-heading` (the editor's heading/link-text/function colour — `.tok-heading`/`.tok-linktext`/
  // `.tok-function` in App.css) is `variablesOf`'s own `'tok-heading': c.accent` above — always exactly the raw
  // accent, for every theme, catalog or generated; no theme ever gives it an independent value. That's the
  // second place (beyond the CSS spots already routed through `--accent-text`) a generated palette's vivid,
  // high-luminance accent (Yellow, Green, Teal) showed up unreadable as text on a light background — reported
  // live, still broken after the first fix, because this variable is set to a literal colour by `variablesOf`'s
  // loop, not a `var()` reference a CSS fallback could catch. Overriding it here, straight after that loop, to
  // the same readable `accentText` used for `--accent-text` itself keeps every heading/link/function token
  // readable too, for a generated palette; a catalog theme's `--tok-heading` is left exactly as the loop set it
  // (its own `accent`, unchanged). A saved custom theme is just a kept copy of some past generated draw, so it
  // carries the exact same `accentText` need — `activeColors` folds the two together for this.
  const active = activeColors(appearance, dark)
  if (active) {
    root.style.setProperty('--accent-text', active.accentText)
    root.style.setProperty('--tok-heading', active.accentText)
  } else {
    root.style.removeProperty('--accent-text')
  }
  root.style.colorScheme = dark ? 'dark' : 'light'
  if (document.body) document.body.style.colorScheme = dark ? 'dark' : 'light'
  // A custom theme's own id is still `appearance.theme` itself (only a generated draw, with no stable id of its
  // own, needs the literal 'generated' stand-in).
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

/** `#rrggbb`, or `fallback` (a safe mid-grey by default) for anything else — never trusts the backend's own colours
 * blindly before they land as a CSS variable, the same caution every other saved-shape check in the app takes. */
const asHexColor = (value: unknown, fallback = '#808080'): string => (typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value) ? value : fallback)

function asThemeColors(value: unknown): ThemeColors {
  const c = (value ?? {}) as Partial<ThemeColors>
  const accent = asHexColor(c.accent)
  return {
    bg: asHexColor(c.bg),
    fg: asHexColor(c.fg),
    muted: asHexColor(c.muted),
    border: asHexColor(c.border),
    accent,
    accentFg: asHexColor(c.accentFg),
    // Falls back to `accent` itself rather than the generic mid-grey, so a shape missing this field (an older
    // backend, say) still shows something reasonable instead of a flat grey wherever accentText is used.
    accentText: asHexColor(c.accentText, accent),
    panel: asHexColor(c.panel),
    hover: asHexColor(c.hover),
  }
}

function asGeneratedPalette(value: unknown): GeneratedPalette | null {
  if (value === null || value === undefined) return null
  const g = value as Partial<GeneratedPalette>
  return { keyIndex: typeof g.keyIndex === 'number' ? g.keyIndex : 0, light: asThemeColors(g.light), dark: asThemeColors(g.dark) }
}

function asCustomTheme(value: unknown): CustomTheme | null {
  if (value === null || value === undefined) return null
  const c = value as Partial<CustomTheme>
  return { id: typeof c.id === 'string' ? c.id : '', name: typeof c.name === 'string' ? c.name : '', light: asThemeColors(c.light), dark: asThemeColors(c.dark) }
}

type RawAppearance = { theme: string; mode: unknown; rotation?: unknown; generated?: unknown; previousGenerated?: unknown; custom?: unknown }

const fromBackend = (raw: RawAppearance): Appearance => ({
  theme: raw.theme,
  mode: asMode(raw.mode),
  rotation: asRotation(raw.rotation),
  generated: asGeneratedPalette(raw.generated),
  previousGenerated: asGeneratedPalette(raw.previousGenerated),
  custom: asCustomTheme(raw.custom),
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
    await getCurrentWebviewWindow().listen(APPEARANCE_EVENT, (event) => applyAppearance(fromBackend(event.payload as RawAppearance), true))
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
      invoke('get_appearance').then((raw) => applyAppearance(fromBackend(raw as RawAppearance), true)).catch(() => {})
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

/** Every custom theme saved so far — for the dialog's own "Your saved themes" grid. Any window may ask (the
 * same read-only trust level as `list_themes`), though only the Settings dialog actually does today. */
export async function listCustomThemes(): Promise<CustomTheme[]> {
  const raw = (await invoke('list_custom_themes')) as unknown[]
  return raw.map((r) => asCustomTheme(r)).filter((t): t is CustomTheme => t !== null)
}

/** Saves `light`/`dark` as a new custom theme named `name`, so it can be picked again later like a catalog one.
 * Doesn't itself switch to it — saving a generated draw someone likes needn't also leave the rotation that drew it. */
export async function saveCustomTheme(name: string, light: ThemeColors, dark: ThemeColors): Promise<CustomTheme> {
  const raw = await invoke('save_custom_theme', { name, light, dark })
  const saved = asCustomTheme(raw)
  if (!saved) throw new Error("The backend didn't answer with the saved theme.")
  return saved
}

/** Removes a saved custom theme. If anything is currently showing it, every window falls back to the default
 * theme at once (the backend's own `delete_custom_theme` broadcasts a fresh `appearance-changed`). */
export async function deleteCustomTheme(id: string): Promise<void> {
  await invoke('delete_custom_theme', { id })
}
