import { useEffect, useState } from 'react'
import { Palette as PaletteIcon } from 'lucide-react'
import Modal from './Modal'
import {
  currentAppearance,
  isDark,
  MIN_ROTATION_SECONDS,
  setAppearance,
  setRotation,
  subscribeAppearance,
  UNIT_SECONDS,
  type ColorMode,
  type Rotation,
  type RotationMode,
  type RotationUnit,
} from '../lib/appearance'
import { FAMILIES, themeById, THEMES } from '../lib/themes'

const MODES: { mode: ColorMode; label: string; hint: string }[] = [
  { mode: 'system', label: 'Follow the device', hint: "Light or dark as the device's own setting says" },
  { mode: 'light', label: 'Light', hint: 'Always light' },
  { mode: 'dark', label: 'Dark', hint: 'Always dark' },
]

const ROTATION_MODES: { mode: RotationMode; label: string }[] = [
  { mode: 'ascending', label: 'Ascending — the next theme of the list' },
  { mode: 'descending', label: 'Descending — the previous one' },
  { mode: 'random', label: 'Random — any other theme' },
]

const UNITS: { unit: RotationUnit; label: string }[] = [
  { unit: 'seconds', label: 'seconds' },
  { unit: 'minutes', label: 'minutes' },
  { unit: 'hours', label: 'hours' },
  { unit: 'days', label: 'days' },
]

const rotationSummary = (r: Rotation) => (r.enabled ? ` · rotating ${r.mode}, every ${r.every} ${r.every === 1 ? r.unit.slice(0, -1) : r.unit}` : '')

/** Settings → Appearance: a summary of the theme and the light/dark mode in use and a button that opens the dialog where they are chosen (the
 * themes are many; the dialog keeps the page short). One choice for the whole app: the backend keeps it and tells every window
 * (`lib/appearance.ts`). */
export default function AppearanceSettings() {
  const [open, setOpen] = useState(false)
  const [chosen, setChosen] = useState(currentAppearance())
  useEffect(() => subscribeAppearance(setChosen), [])
  const theme = themeById(chosen.theme)
  const mode = MODES.find((m) => m.mode === chosen.mode)?.label ?? ''

  return (
    <section className="appearance-settings">
      <div className="toolbar">
        <strong>Appearance</strong>
      </div>
      <div className="appearance-summary">
        <span className="theme-swatch small" style={{ background: (isDark(chosen.mode) ? theme.dark : theme.light).bg, borderColor: (isDark(chosen.mode) ? theme.dark : theme.light).border }} aria-hidden="true">
          <span style={{ background: (isDark(chosen.mode) ? theme.dark : theme.light).accent }} />
        </span>
        <span>
          <strong>{theme.name}</strong> <span className="muted">· {mode}{rotationSummary(chosen.rotation)}</span>
        </span>
        <button type="button" className="primary" onClick={() => setOpen(true)}>
          <PaletteIcon size={14} aria-hidden="true" /> Change…
        </button>
      </div>
      {open && <AppearanceDialog onClose={() => setOpen(false)} />}
    </section>
  )
}

function AppearanceDialog({ onClose }: { onClose: () => void }) {
  const [chosen, setChosen] = useState(currentAppearance())
  const [error, setError] = useState<string | null>(null)
  // The rotation's interval is typed: the box and the unit hold what was typed until the two together are a valid interval (they are only
  // sent then — 5 seconds is not one, and 30 seconds is).
  const [every, setEvery] = useState(String(chosen.rotation.every))
  const [unit, setUnit] = useState<RotationUnit>(chosen.rotation.unit)
  useEffect(() => subscribeAppearance(setChosen), [])

  const attempt = async (work: () => Promise<void>) => {
    try {
      await work()
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  const choose = (next: { theme: string; mode: ColorMode }) => attempt(() => setAppearance(next))

  const seconds = Number(every) * UNIT_SECONDS[unit]
  const everyOk = every.trim() !== '' && Number.isInteger(Number(every)) && Number(every) >= 1
  const tooShort = everyOk && seconds < MIN_ROTATION_SECONDS
  /** Sends the rotation with `next` changed — the interval as typed when the two boxes make a valid one. */
  const rotate = (next: Partial<Rotation>) => attempt(() => setRotation({ ...chosen.rotation, ...next }))
  const typed = (nextEvery: string, nextUnit: RotationUnit) => {
    setEvery(nextEvery)
    setUnit(nextUnit)
    const n = Number(nextEvery)
    if (nextEvery.trim() !== '' && Number.isInteger(n) && n >= 1 && n * UNIT_SECONDS[nextUnit] >= MIN_ROTATION_SECONDS) void rotate({ every: n, unit: nextUnit })
  }
  const dark = isDark(chosen.mode)

  return (
    <Modal title="Appearance" onClose={onClose} wide>
      {error && <div className="error-banner">{error}</div>}
      <p className="muted">
        One choice for the whole app — this window and the system apps such as Notes, which follow it at once. A web app keeps its own colours, but is told about the
        light or dark mode and may follow it — and may choose the theme too.
      </p>

      <div className="segmented" role="radiogroup" aria-label="Light or dark">
        {MODES.map((m) => (
          <button
            key={m.mode}
            type="button"
            role="radio"
            aria-checked={chosen.mode === m.mode}
            className={chosen.mode === m.mode ? 'active' : ''}
            title={m.hint}
            onClick={() => choose({ theme: chosen.theme, mode: m.mode })}
          >
            {m.label}
          </button>
        ))}
      </div>

      <fieldset className="rotation-box">
        <legend>Rotate through all the themes</legend>
        <label className="rotation-row">
          <input type="checkbox" checked={chosen.rotation.enabled} onChange={(e) => rotate({ enabled: e.target.checked })} /> Change the theme by itself
        </label>
        <div className="rotation-row">
          <label>
            Order{' '}
            <select value={chosen.rotation.mode} onChange={(e) => rotate({ mode: e.target.value as RotationMode })}>
              {ROTATION_MODES.map((m) => (
                <option key={m.mode} value={m.mode}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="rotation-row">
          <label>
            Every{' '}
            <input
              type="number"
              min={1}
              step={1}
              value={every}
              className={!everyOk || tooShort ? 'invalid' : ''}
              onChange={(e) => typed(e.target.value, unit)}
            />
          </label>
          <select value={unit} aria-label="Unit of the interval" onChange={(e) => typed(every, e.target.value as RotationUnit)}>
            {UNITS.map((u) => (
              <option key={u.unit} value={u.unit}>
                {u.label}
              </option>
            ))}
          </select>
        </div>
        {(!everyOk || tooShort) && (
          <div className="rotation-warning">
            {tooShort ? `A theme stays at least ${MIN_ROTATION_SECONDS} seconds — changing the colours of the whole window faster than that is tiring to look at.` : 'Type a whole number, 1 or more.'}
          </div>
        )}
        <p className="muted">
          The colours slide over to the next theme in about half a second. Every change recolours the whole window, so leave it a few minutes or more;{' '}
          {MIN_ROTATION_SECONDS} seconds is the shortest allowed. Choosing a theme by hand below doesn't stop the rotation: it goes on from that theme.
        </p>
      </fieldset>

      {FAMILIES.map((family) => (
        <div key={family} className="theme-family">
          <div className="muted theme-family-name">{family}</div>
          <div className="theme-grid">
            {THEMES.filter((t) => t.family === family).map((t) => {
              const palette = dark ? t.dark : t.light
              return (
                <button
                  key={t.id}
                  type="button"
                  className={`theme-card ${chosen.theme === t.id ? 'active' : ''}`}
                  aria-pressed={chosen.theme === t.id}
                  title={t.name}
                  onClick={() => choose({ theme: t.id, mode: chosen.mode })}
                >
                  <span className="theme-swatch" style={{ background: palette.bg, borderColor: palette.border }} aria-hidden="true">
                    <span style={{ background: palette.panel }} />
                    <span style={{ background: palette.accent }} />
                    <span style={{ background: palette.fg }} />
                  </span>
                  <span className="theme-name">{t.name}</span>
                </button>
              )
            })}
          </div>
        </div>
      ))}
    </Modal>
  )
}
