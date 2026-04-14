import { useState } from 'react'
import { useSettingsStore } from '../../store/useSettingsStore'
import { KEY_SIZE_MIN, KEY_SIZE_MAX } from '../../constants/piano'
import './Settings.css'

export function KeySizeSettings() {
  const { customSizes, activeSize, addCustomSize, removeCustomSize, setActiveSize } = useSettingsStore()
  const [newSize, setNewSize] = useState<string>('')
  const [error, setError] = useState<string>('')
  const [fadeMs, setFadeMsLocal] = useState<string>(String(useSettingsStore.getState().fadeMs))
  const { setFadeMs } = useSettingsStore()

  const handleAdd = () => {
    const val = parseInt(newSize, 10)
    if (isNaN(val) || val < KEY_SIZE_MIN || val > KEY_SIZE_MAX) {
      setError(`Size must be between ${KEY_SIZE_MIN} and ${KEY_SIZE_MAX}`)
      return
    }
    addCustomSize(val)
    setNewSize('')
    setError('')
  }

  const handleFadeMs = () => {
    const val = parseInt(fadeMs, 10)
    if (!isNaN(val) && val >= 0) {
      setFadeMs(val)
    }
  }

  return (
    <div className="settings-section">
      <h3 className="settings-section__title">Key Size</h3>
      <p className="settings-section__desc">
        Each key is a square. Size is in pixels ({KEY_SIZE_MIN}–{KEY_SIZE_MAX}px).
        "Default" auto-fits all 88 keys to the window width and adjusts on resize.
      </p>

      <div className="size-list">
        <label className="size-option">
          <input
            type="radio"
            name="keySize"
            checked={activeSize === 'default'}
            onChange={() => setActiveSize('default')}
          />
          <span>Default (auto-fit)</span>
        </label>
        {customSizes.map(size => (
          <div key={size} className="size-option">
            <label>
              <input
                type="radio"
                name="keySize"
                checked={activeSize === size}
                onChange={() => setActiveSize(size)}
              />
              <span>{size}px</span>
            </label>
            <button
              className="btn btn--icon btn--danger-soft"
              onClick={() => removeCustomSize(size)}
              title="Delete this size"
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      <div className="settings-add-row">
        <input
          type="number"
          min={KEY_SIZE_MIN}
          max={KEY_SIZE_MAX}
          value={newSize}
          onChange={e => { setNewSize(e.target.value); setError('') }}
          placeholder={`${KEY_SIZE_MIN}–${KEY_SIZE_MAX}`}
          className="input input--sm"
          onKeyDown={e => e.key === 'Enter' && handleAdd()}
        />
        <button className="btn btn--primary btn--sm" onClick={handleAdd}>Add Size</button>
      </div>
      {error && <p className="settings-error">{error}</p>}

      <h3 className="settings-section__title" style={{ marginTop: '1.5rem' }}>Note Fade-out Duration</h3>
      <p className="settings-section__desc">
        Minimum time (ms) a note plays before fading out on key release. Default: 100ms.
      </p>
      <div className="settings-add-row">
        <input
          type="number"
          min={0}
          value={fadeMs}
          onChange={e => setFadeMsLocal(e.target.value)}
          className="input input--sm"
          style={{ width: 80 }}
        />
        <span className="text-muted">ms</span>
        <button className="btn btn--primary btn--sm" onClick={handleFadeMs}>Save</button>
      </div>
    </div>
  )
}
