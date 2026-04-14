import { useState, useEffect, useRef } from 'react'
import { useSettingsStore } from '../../store/useSettingsStore'
import { getAllThemes, saveTheme, deleteTheme } from '../../db/themesDb'
import { Theme } from '../../db/schema'
import { ConfirmDialog } from '../common/ConfirmDialog'
import './Settings.css'

export function ThemeSettings() {
  const { activeThemeId, setActiveThemeId } = useSettingsStore()
  const [themes, setThemes] = useState<Theme[]>([])
  const [newName, setNewName] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<Theme | null>(null)
  const [error, setError] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const editFileRef = useRef<HTMLInputElement>(null)

  const reload = () => getAllThemes().then(setThemes)
  useEffect(() => { reload() }, [])

  const handleAdd = async () => {
    if (!newName.trim()) { setError('Enter a theme name'); return }
    const file = fileRef.current?.files?.[0]
    if (!file) { setError('Select a CSS file'); return }
    const css = await file.text()
    const theme: Theme = {
      id: crypto.randomUUID(),
      name: newName.trim(),
      css,
      createdAt: Date.now()
    }
    await saveTheme(theme)
    setNewName('')
    if (fileRef.current) fileRef.current.value = ''
    setError('')
    reload()
  }

  const handleEdit = async (id: string) => {
    if (!editName.trim()) { setError('Enter a theme name'); return }
    const file = editFileRef.current?.files?.[0]
    const existing = themes.find(t => t.id === id)!
    const css = file ? await file.text() : existing.css
    await saveTheme({ ...existing, name: editName.trim(), css })
    if (activeThemeId === id) {
      // Refresh injected style
      const style = document.getElementById('user-theme-style')
      if (style) style.textContent = css
    }
    setEditingId(null)
    setEditName('')
    if (editFileRef.current) editFileRef.current.value = ''
    reload()
  }

  const handleDelete = async (theme: Theme) => {
    await deleteTheme(theme.id)
    if (activeThemeId === theme.id) await setActiveThemeId(null)
    setDeleteTarget(null)
    reload()
  }

  return (
    <div className="settings-section">
      <h3 className="settings-section__title">Themes</h3>
      <p className="settings-section__desc">
        Upload a CSS file to create a custom theme. The CSS is injected globally.
      </p>

      {themes.length === 0 && (
        <p className="text-muted">No themes yet. Add one below.</p>
      )}

      <div className="item-list">
        <div className="item-list__row item-list__row--header">
          <label>
            <input
              type="radio"
              name="activeTheme"
              checked={!activeThemeId}
              onChange={() => setActiveThemeId(null)}
            />
            <span style={{ marginLeft: 8 }}>None (default)</span>
          </label>
        </div>

        {themes.map(theme => (
          <div key={theme.id} className="item-list__row">
            {editingId === theme.id ? (
              <div className="item-edit-form">
                <input
                  className="input input--sm"
                  value={editName}
                  onChange={e => setEditName(e.target.value)}
                  placeholder="Theme name"
                />
                <label className="file-label">
                  <span>CSS file (optional, replaces current)</span>
                  <input ref={editFileRef} type="file" accept=".css" />
                </label>
                <div className="btn-row">
                  <button className="btn btn--primary btn--sm" onClick={() => handleEdit(theme.id)}>Save</button>
                  <button className="btn btn--secondary btn--sm" onClick={() => setEditingId(null)}>Cancel</button>
                </div>
                {error && <p className="settings-error">{error}</p>}
              </div>
            ) : (
              <>
                <label className="item-label">
                  <input
                    type="radio"
                    name="activeTheme"
                    checked={activeThemeId === theme.id}
                    onChange={() => setActiveThemeId(theme.id)}
                  />
                  <span className="item-name">{theme.name}</span>
                </label>
                <div className="item-actions">
                  <button className="btn btn--secondary btn--sm" onClick={() => { setEditingId(theme.id); setEditName(theme.name); setError('') }}>
                    Edit
                  </button>
                  <button className="btn btn--danger-soft btn--sm" onClick={() => setDeleteTarget(theme)}>
                    Delete
                  </button>
                </div>
              </>
            )}
          </div>
        ))}
      </div>

      <div className="settings-add-form">
        <h4 className="settings-subsection-title">Add New Theme</h4>
        <input
          className="input"
          value={newName}
          onChange={e => { setNewName(e.target.value); setError('') }}
          placeholder="Theme name"
        />
        <label className="file-label">
          <span>CSS file</span>
          <input ref={fileRef} type="file" accept=".css" />
        </label>
        {error && <p className="settings-error">{error}</p>}
        <button className="btn btn--primary" onClick={handleAdd}>Add Theme</button>
      </div>

      {deleteTarget && (
        <ConfirmDialog
          title="Delete Theme"
          message={`Delete "${deleteTarget.name}"? This cannot be undone.`}
          confirmLabel="Delete"
          onConfirm={() => handleDelete(deleteTarget)}
          onCancel={() => setDeleteTarget(null)}
          danger
        />
      )}
    </div>
  )
}
