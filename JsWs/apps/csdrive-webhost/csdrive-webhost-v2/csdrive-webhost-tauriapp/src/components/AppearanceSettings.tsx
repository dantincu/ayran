import { useEffect, useState } from 'react'
import { Palette as PaletteIcon, Plus, Save, Trash2 } from 'lucide-react'
import Modal from './Modal'
import IconButton from './IconButton'
import {
  currentAppearance,
  deleteCustomTheme,
  deleteKeyColorList,
  getDefaultKeyColors,
  getKeyColors,
  isDark,
  listCustomThemes,
  listSavedKeyColorLists,
  MIN_ROTATION_SECONDS,
  saveCustomTheme,
  saveKeyColorList,
  setAppearance,
  setKeyColors,
  setRotation,
  subscribeAppearance,
  UNIT_SECONDS,
  type ColorMode,
  type CustomTheme,
  type GeneratedColors,
  type GeneratedPalette,
  type KeyColor,
  type Rotation,
  type RotationMode,
  type RotationUnit,
  type SavedKeyColorList,
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

const rotationSummary = (r: Rotation) =>
  r.enabled ? ` · rotating ${r.generated.enabled ? 'generated colours' : r.mode}, every ${r.every} ${r.every === 1 ? r.unit.slice(0, -1) : r.unit}` : ''

/** Settings → Appearance: a summary of the theme and the light/dark mode in use and a button that opens the dialog where they are chosen (the
 * themes are many; the dialog keeps the page short). One choice for the whole app: the backend keeps it and tells every window
 * (`lib/appearance.ts`). */
export default function AppearanceSettings() {
  const [open, setOpen] = useState(false)
  const [chosen, setChosen] = useState(currentAppearance())
  useEffect(() => subscribeAppearance(setChosen), [])
  const theme = themeById(chosen.theme)
  const mode = MODES.find((m) => m.mode === chosen.mode)?.label ?? ''
  const dark = isDark(chosen.mode)
  const palette = chosen.generated ? (dark ? chosen.generated.dark : chosen.generated.light) : dark ? theme.dark : theme.light
  const name = chosen.generated ? 'Generated colours' : theme.name

  return (
    <section className="appearance-settings">
      <div className="toolbar">
        <strong>Appearance</strong>
      </div>
      <div className="appearance-summary">
        <span className="theme-swatch small" style={{ background: palette.bg, borderColor: palette.border }} aria-hidden="true">
          <span style={{ background: palette.accent }} />
        </span>
        <span>
          <strong>{name}</strong> <span className="muted">· {mode}{rotationSummary(chosen.rotation)}</span>
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
  // The spread is typed the same way: kept as text so an empty box or one being edited doesn't fight the person,
  // sent only once it is a whole number 0–255.
  const [spreadText, setSpreadText] = useState(String(chosen.rotation.generated.spread))
  const [keyColors, setKeyColorsState] = useState<KeyColor[]>([])
  const [editingKeyColors, setEditingKeyColors] = useState(false)
  const [savedKeyColorLists, setSavedKeyColorLists] = useState<SavedKeyColorList[]>([])
  // The inline "name it" box for saving the current seed-colour list — `null` while it's closed.
  const [keyColorListName, setKeyColorListName] = useState<string | null>(null)
  const [customThemes, setCustomThemes] = useState<CustomTheme[]>([])
  // Which generated palette the inline "name it" box is open for, if either — `null` while it's closed.
  const [savingSlot, setSavingSlot] = useState<'current' | 'previous' | null>(null)
  const [themeName, setThemeName] = useState('')
  useEffect(() => subscribeAppearance(setChosen), [])
  const refreshKeyColors = () => getKeyColors().then(setKeyColorsState).catch(() => setKeyColorsState([]))
  useEffect(() => {
    void refreshKeyColors()
  }, [])
  const refreshSavedKeyColorLists = () => listSavedKeyColorLists().then(setSavedKeyColorLists).catch(() => {})
  useEffect(() => {
    void refreshSavedKeyColorLists()
  }, [])
  const refreshCustomThemes = () => listCustomThemes().then(setCustomThemes).catch(() => {})
  useEffect(() => {
    void refreshCustomThemes()
  }, [])

  const attempt = async (work: () => Promise<void>) => {
    try {
      await work()
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  const choose = (next: { theme: string; mode: ColorMode }) => attempt(() => setAppearance(next))

  /** Opens the inline "name it" box for the current or the previous generated draw. */
  const startSaving = (slot: 'current' | 'previous') => {
    setSavingSlot(slot)
    setThemeName('')
  }
  const paletteForSlot = (slot: 'current' | 'previous'): GeneratedPalette | null => (slot === 'current' ? chosen.generated : chosen.previousGenerated)
  const confirmSaving = () =>
    attempt(async () => {
      const palette = savingSlot && paletteForSlot(savingSlot)
      if (!palette) return
      await saveCustomTheme(themeName, palette.light, palette.dark)
      setSavingSlot(null)
      await refreshCustomThemes()
    })
  const removeCustomTheme = (t: CustomTheme) =>
    attempt(async () => {
      await deleteCustomTheme(t.id)
      await refreshCustomThemes()
    })

  // ── Editable seed colours (the generated rotation's own key colours) ──
  const applyKeyColors = (next: KeyColor[]) =>
    attempt(async () => {
      setKeyColorsState(await setKeyColors(next))
    })
  const updateKeyColorName = (i: number, name: string) => setKeyColorsState((list) => list.map((c, idx) => (idx === i ? { ...c, name } : c)))
  const commitKeyColorNames = () => void applyKeyColors(keyColors)
  const updateKeyColorValue = (i: number, color: string) => {
    const next = keyColors.map((c, idx) => (idx === i ? { ...c, color } : c))
    setKeyColorsState(next)
    void applyKeyColors(next)
  }
  const addKeyColor = () => void applyKeyColors([...keyColors, { name: `Colour ${keyColors.length + 1}`, color: '#808080' }])
  // The list can never go empty from here (the backend would refuse it anyway) — the last colour's own remove
  // button is disabled rather than letting the person hit that error.
  const removeKeyColor = (i: number) => keyColors.length > 1 && void applyKeyColors(keyColors.filter((_, idx) => idx !== i))
  const revertKeyColors = () =>
    attempt(async () => {
      setKeyColorsState(await setKeyColors(await getDefaultKeyColors()))
    })
  const confirmSavingKeyColorList = () =>
    attempt(async () => {
      if (keyColorListName === null) return
      await saveKeyColorList(keyColorListName, keyColors)
      setKeyColorListName(null)
      await refreshSavedKeyColorLists()
    })
  const useKeyColorList = (list: SavedKeyColorList) => void applyKeyColors(list.colors)
  const removeKeyColorList = (list: SavedKeyColorList) =>
    attempt(async () => {
      await deleteKeyColorList(list.id)
      await refreshSavedKeyColorLists()
    })

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

  /** Sends the rotation with its `generated` changed — spread as typed when it is a whole number 0–255. */
  const rotateGenerated = (next: Partial<GeneratedColors>) => rotate({ generated: { ...chosen.rotation.generated, ...next } })
  const spreadOk = spreadText.trim() !== '' && Number.isInteger(Number(spreadText)) && Number(spreadText) >= 0 && Number(spreadText) <= 255
  const typedSpread = (next: string) => {
    setSpreadText(next)
    if (next.trim() !== '' && Number.isInteger(Number(next)) && Number(next) >= 0 && Number(next) <= 255) void rotateGenerated({ spread: Number(next) })
  }

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
            <select
              value={chosen.rotation.mode}
              disabled={chosen.rotation.generated.enabled}
              title={chosen.rotation.generated.enabled ? 'Meaningless for generated colours: they always go forward through the six key hues.' : undefined}
              onChange={(e) => rotate({ mode: e.target.value as RotationMode })}
            >
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
            {tooShort ? `A theme stays at least ${MIN_ROTATION_SECONDS} second${MIN_ROTATION_SECONDS === 1 ? '' : 's'}.` : 'Type a whole number, 1 or more.'}
          </div>
        )}
        <p className="muted">
          The colours slide over to the next theme in about half a second — {MIN_ROTATION_SECONDS} second{MIN_ROTATION_SECONDS === 1 ? '' : 's'} is the shortest interval allowed, handy for
          watching the rotation happen while testing; a very short interval means the fade from one theme to the next never really finishes before the one after starts. Every change
          recolours the whole window, so a comfortable everyday interval is a few minutes or more — that's a matter of taste, not a rule this app enforces. Choosing a theme by hand below
          doesn't stop the rotation: it goes on from that theme.
        </p>

        <label className="rotation-row">
          <input type="checkbox" checked={chosen.rotation.generated.enabled} onChange={(e) => rotateGenerated({ enabled: e.target.checked })} /> Generate colours near six key
          hues instead of choosing a theme
        </label>
        {chosen.rotation.generated.enabled && (
          <>
            <div className="rotation-row">
              <label>
                How close{' '}
                <input
                  type="number"
                  min={0}
                  max={255}
                  step={1}
                  value={spreadText}
                  className={!spreadOk ? 'invalid' : ''}
                  onChange={(e) => typedSpread(e.target.value)}
                />
              </label>
              <span className="muted">0–255: 0 is the key colour exactly, higher lets it drift further (per red/green/blue channel).</span>
            </div>
            {!spreadOk && <div className="rotation-warning">Type a whole number, 0 to 255.</div>}
            <p className="muted">
              At every step, the next of these {keyColors.length || 6} colours is drawn near, one channel at a time: {keyColors.length ? keyColors.map((c) => c.name).join(', ') : 'Red, Yellow, Green, Teal, Blue, Magenta'}. Choosing a theme below has no effect while this is on.
            </p>

            <div className="rotation-row">
              <button type="button" onClick={() => setEditingKeyColors((e) => !e)}>
                <PaletteIcon size={14} aria-hidden="true" /> {editingKeyColors ? 'Done editing the seed colours' : 'Edit the seed colours…'}
              </button>
            </div>

            {editingKeyColors && (
              <div className="key-colors-editor">
                {keyColors.map((c, i) => (
                  <div key={i} className="rotation-row key-color-row">
                    <input type="color" value={c.color} onChange={(e) => updateKeyColorValue(i, e.target.value)} aria-label={`Colour ${i + 1}'s own colour`} />
                    <input
                      type="text"
                      value={c.name}
                      onChange={(e) => updateKeyColorName(i, e.target.value)}
                      onBlur={commitKeyColorNames}
                      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                      aria-label={`Colour ${i + 1}'s own name`}
                    />
                    <IconButton icon={Trash2} label="Remove this colour" variant="danger" disabled={keyColors.length <= 1} onClick={() => removeKeyColor(i)} />
                  </div>
                ))}
                <div className="rotation-row">
                  <button type="button" onClick={addKeyColor}>
                    <Plus size={14} aria-hidden="true" /> Add a colour
                  </button>
                  <button type="button" onClick={() => void revertKeyColors()}>
                    Revert to the default colours
                  </button>
                  <button type="button" onClick={() => setKeyColorListName('')}>
                    <Save size={14} aria-hidden="true" /> Save this list…
                  </button>
                </div>
                {keyColorListName !== null && (
                  <div className="rotation-row">
                    <input
                      type="text"
                      autoFocus
                      placeholder="Name this list"
                      value={keyColorListName}
                      onChange={(e) => setKeyColorListName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void confirmSavingKeyColorList()
                        else if (e.key === 'Escape') setKeyColorListName(null)
                      }}
                    />
                    <button type="button" className="primary" onClick={() => void confirmSavingKeyColorList()} disabled={keyColorListName.trim() === ''}>
                      Save
                    </button>
                    <button type="button" onClick={() => setKeyColorListName(null)}>
                      Cancel
                    </button>
                  </div>
                )}
                {savedKeyColorLists.length > 0 && (
                  <>
                    <div className="muted">Your saved colour lists</div>
                    {savedKeyColorLists.map((list) => (
                      <div key={list.id} className="key-color-list-row">
                        <span className="key-color-list-swatches" aria-hidden="true">
                          {list.colors.slice(0, 6).map((c, i) => (
                            <span key={i} style={{ background: c.color }} />
                          ))}
                        </span>
                        <button type="button" onClick={() => void useKeyColorList(list)}>
                          {list.name}
                        </button>
                        <IconButton icon={Trash2} label={`Remove the saved list "${list.name}"`} variant="danger" onClick={() => void removeKeyColorList(list)} />
                      </div>
                    ))}
                  </>
                )}
              </div>
            )}

            {/* Saving a draw is the only way to keep one: a generated colour scheme is otherwise gone the moment the rotation moves
                on, or the app closes. The previous draw stays offered for one step after the rotation has moved past it, so noticing
                a nice one doesn't have to mean catching it before the next tick. */}
            <div className="rotation-row generated-save-row">
              <span className="theme-swatch small" style={{ background: (dark ? chosen.generated?.dark : chosen.generated?.light)?.bg, borderColor: (dark ? chosen.generated?.dark : chosen.generated?.light)?.border }} aria-hidden="true">
                <span style={{ background: (dark ? chosen.generated?.dark : chosen.generated?.light)?.accent }} />
              </span>
              <button type="button" onClick={() => startSaving('current')} disabled={!chosen.generated}>
                <Save size={14} aria-hidden="true" /> Save this colour scheme…
              </button>
              {chosen.previousGenerated && (
                <>
                  <span className="theme-swatch small" style={{ background: (dark ? chosen.previousGenerated.dark : chosen.previousGenerated.light).bg, borderColor: (dark ? chosen.previousGenerated.dark : chosen.previousGenerated.light).border }} aria-hidden="true">
                    <span style={{ background: (dark ? chosen.previousGenerated.dark : chosen.previousGenerated.light).accent }} />
                  </span>
                  <button type="button" onClick={() => startSaving('previous')}>
                    <Save size={14} aria-hidden="true" /> Save the previous one…
                  </button>
                </>
              )}
            </div>
            {savingSlot && (
              <div className="rotation-row">
                <input
                  type="text"
                  autoFocus
                  placeholder="Name this theme"
                  value={themeName}
                  onChange={(e) => setThemeName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void confirmSaving()
                    else if (e.key === 'Escape') setSavingSlot(null)
                  }}
                />
                <button type="button" className="primary" onClick={() => void confirmSaving()} disabled={themeName.trim() === ''}>
                  Save
                </button>
                <button type="button" onClick={() => setSavingSlot(null)}>
                  Cancel
                </button>
              </div>
            )}
          </>
        )}
      </fieldset>

      {customThemes.length > 0 && (
        <div className={`theme-family ${chosen.rotation.generated.enabled ? 'theme-family-disabled' : ''}`} aria-disabled={chosen.rotation.generated.enabled}>
          <div className="muted theme-family-name">Your saved themes</div>
          <div className="theme-grid">
            {customThemes.map((t) => {
              const palette = dark ? t.dark : t.light
              return (
                <div key={t.id} className="theme-card-wrap">
                  <button
                    type="button"
                    className={`theme-card ${chosen.theme === t.id ? 'active' : ''}`}
                    aria-pressed={chosen.theme === t.id}
                    title={t.name}
                    disabled={chosen.rotation.generated.enabled}
                    onClick={() => choose({ theme: t.id, mode: chosen.mode })}
                  >
                    <span className="theme-swatch" style={{ background: palette.bg, borderColor: palette.border }} aria-hidden="true">
                      <span style={{ background: palette.panel }} />
                      <span style={{ background: palette.accent }} />
                      <span style={{ background: palette.fg }} />
                    </span>
                    <span className="theme-name">{t.name}</span>
                  </button>
                  <IconButton icon={Trash2} label={`Remove the saved theme "${t.name}"`} variant="danger" className="theme-card-remove" onClick={() => removeCustomTheme(t)} />
                </div>
              )
            })}
          </div>
        </div>
      )}

      {FAMILIES.map((family) => (
        <div key={family} className={`theme-family ${chosen.rotation.generated.enabled ? 'theme-family-disabled' : ''}`} aria-disabled={chosen.rotation.generated.enabled}>
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
                  disabled={chosen.rotation.generated.enabled}
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
