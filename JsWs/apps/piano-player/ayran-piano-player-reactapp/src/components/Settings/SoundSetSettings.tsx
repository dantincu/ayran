import { useState, useEffect, useRef } from 'react'
import { useSettingsStore } from '../../store/useSettingsStore'
import { getAllSoundsets, saveSoundset, deleteSoundset, saveSoundsetNote, getSoundsetNote, deleteSoundsetNote } from '../../db/soundsetsDb'
import { Soundset } from '../../db/schema'
import { parseFolderForNotes, parseFilesForNotes } from '../../utils/fileUtils'
import { NOTE_CODES } from '../../constants/piano'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { clearBufferCache } from '../../audio/soundsetPlayer'
import './Settings.css'

export function SoundSetSettings() {
  const { activeSoundsetId, setActiveSoundsetId } = useSettingsStore()
  const [soundsets, setSoundsets] = useState<Soundset[]>([])
  const [newName, setNewName] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<Soundset | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editMode, setEditMode] = useState<'folder' | 'files'>('folder')
  const [progress, setProgress] = useState<string>('')
  const editFilesRef = useRef<HTMLInputElement>(null)

  const reload = () => getAllSoundsets().then(setSoundsets)
  useEffect(() => { reload() }, [])

  const importFromFolder = async (soundsetId: string) => {
    if (!('showDirectoryPicker' in window)) {
      throw new Error('Directory picker not supported in this browser')
    }
    const dirHandle = await (window as any).showDirectoryPicker()
    const notes = await parseFolderForNotes(dirHandle)
    return notes
  }

  const importNotes = async (soundsetId: string, useFolderPicker: boolean) => {
    setLoading(true)
    setProgress('Scanning files...')
    try {
      let notes
      if (useFolderPicker) {
        notes = await importFromFolder(soundsetId)
      } else {
        const files = editFilesRef.current?.files
        if (!files?.length) return
        notes = await parseFilesForNotes(files)
      }

      setProgress(`Importing ${notes.length} notes...`)
      let count = 0
      for (const { noteCode, file } of notes) {
        const blob = new Blob([await file.arrayBuffer()], { type: 'audio/mp3' })
        await saveSoundsetNote({ soundsetId, noteCode, blob })
        count++
        setProgress(`Imported ${count}/${notes.length}...`)
      }

      clearBufferCache(soundsetId)
      setProgress('')
      return notes.length
    } finally {
      setLoading(false)
    }
  }

  const handleAdd = async (useFolder: boolean) => {
    if (!newName.trim()) { setError('Enter a soundset name'); return }
    const id = crypto.randomUUID()
    setError('')
    try {
      const count = await importNotes(id, useFolder) ?? 0
      const soundset: Soundset = {
        id,
        name: newName.trim(),
        noteCount: count,
        createdAt: Date.now()
      }
      await saveSoundset(soundset)
      setNewName('')
      if (editFilesRef.current) editFilesRef.current.value = ''
      reload()
    } catch (e: any) {
      if (e?.name !== 'AbortError') setError(e?.message ?? 'Failed to import')
    }
  }

  const handleEdit = async (id: string, useFolder: boolean) => {
    try {
      const count = await importNotes(id, useFolder)
      if (count !== undefined) {
        const ss = soundsets.find(s => s.id === id)!
        await saveSoundset({ ...ss, noteCount: count })
        clearBufferCache(id)
      }
      setEditingId(null)
      reload()
    } catch (e: any) {
      if (e?.name !== 'AbortError') setError(e?.message ?? 'Failed to import')
    }
  }

  const handleEditSingleNote = async (soundsetId: string, noteCode: string) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.mp3,audio/mp3'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return
      const blob = new Blob([await file.arrayBuffer()], { type: 'audio/mp3' })
      await saveSoundsetNote({ soundsetId, noteCode, blob })
      clearBufferCache(soundsetId)
    }
    input.click()
  }

  const handleDelete = async (ss: Soundset) => {
    await deleteSoundset(ss.id)
    clearBufferCache(ss.id)
    if (activeSoundsetId === ss.id) await setActiveSoundsetId(null)
    setDeleteTarget(null)
    reload()
  }

  const hasFolder = 'showDirectoryPicker' in window

  return (
    <div className="settings-section">
      <h3 className="settings-section__title">Sound Sets</h3>
      <p className="settings-section__desc">
        Add sets of MP3 files for all 88 notes. Files must be named{' '}
        <code>note-&lt;note-code&gt;.mp3</code> (e.g. <code>note-C4.mp3</code>).
        Missing notes will use synthesized audio.
      </p>

      <div className="item-list">
        <div className="item-list__row item-list__row--header">
          <label>
            <input
              type="radio"
              name="activeSoundset"
              checked={!activeSoundsetId}
              onChange={() => setActiveSoundsetId(null)}
            />
            <span style={{ marginLeft: 8 }}>Synthesized (default)</span>
          </label>
        </div>

        {soundsets.map(ss => (
          <div key={ss.id} className="item-list__row">
            {editingId === ss.id ? (
              <div className="item-edit-form">
                <p className="text-muted" style={{ margin: '0 0 0.5rem' }}>
                  Update notes for <strong>{ss.name}</strong>:
                </p>
                <div className="btn-row">
                  {hasFolder && (
                    <button
                      className="btn btn--primary btn--sm"
                      onClick={() => handleEdit(ss.id, true)}
                      disabled={loading}
                    >
                      {loading ? progress : 'Pick Folder'}
                    </button>
                  )}
                  <button
                    className="btn btn--secondary btn--sm"
                    onClick={() => setEditMode('files')}
                  >
                    Pick Individual Files
                  </button>
                  <button className="btn btn--secondary btn--sm" onClick={() => setEditingId(null)}>Cancel</button>
                </div>
                {editMode === 'files' && (
                  <div>
                    <input ref={editFilesRef} type="file" accept=".mp3,audio/mp3" multiple
                      // @ts-ignore
                      webkitdirectory=""
                    />
                    <button className="btn btn--primary btn--sm" onClick={() => handleEdit(ss.id, false)} disabled={loading}>
                      Import
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <>
                <label className="item-label">
                  <input
                    type="radio"
                    name="activeSoundset"
                    checked={activeSoundsetId === ss.id}
                    onChange={() => setActiveSoundsetId(ss.id)}
                  />
                  <span className="item-name">{ss.name}</span>
                  <span className="item-meta">{ss.noteCount}/88 notes</span>
                </label>
                <div className="item-actions">
                  <button className="btn btn--secondary btn--sm" onClick={() => setEditingId(ss.id)}>Edit</button>
                  <button className="btn btn--danger-soft btn--sm" onClick={() => setDeleteTarget(ss)}>Delete</button>
                </div>
              </>
            )}
          </div>
        ))}
      </div>

      {error && <p className="settings-error">{error}</p>}

      <div className="settings-add-form">
        <h4 className="settings-subsection-title">Add New Sound Set</h4>
        <input
          className="input"
          value={newName}
          onChange={e => { setNewName(e.target.value); setError('') }}
          placeholder="Sound set name"
        />
        <div className="btn-row">
          {hasFolder && (
            <button className="btn btn--primary" onClick={() => handleAdd(true)} disabled={loading}>
              {loading ? progress : 'Pick Folder'}
            </button>
          )}
          <button className="btn btn--secondary" onClick={() => handleAdd(false)} disabled={loading}>
            {loading ? progress : 'Pick Files'}
          </button>
        </div>
        {!hasFolder && (
          <p className="text-muted" style={{ fontSize: '0.8rem' }}>
            Note: Directory picker not supported in this browser. Use "Pick Files" instead.
          </p>
        )}
      </div>

      {deleteTarget && (
        <ConfirmDialog
          title="Delete Sound Set"
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
