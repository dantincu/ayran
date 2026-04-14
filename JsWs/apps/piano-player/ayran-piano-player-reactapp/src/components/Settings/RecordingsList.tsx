import { useState, useEffect } from 'react'
import { useRecordingStore } from '../../store/useRecordingStore'
import { getAllRecordings, deleteRecording, saveRecording } from '../../db/recordingsDb'
import { clearCurrentRecording } from '../../db/recordingsDb'
import { Recording } from '../../db/schema'
import { blueprintToMp3Blob } from '../../audio/blueprintPlayer'
import { downloadBlob } from '../../audio/recorder'
import { useSettingsStore } from '../../store/useSettingsStore'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { PlaybackPopup } from './PlaybackPopup'
import './Settings.css'

export function RecordingsList() {
  const [recordings, setRecordings] = useState<Recording[]>([])
  const [deleteTarget, setDeleteTarget] = useState<Recording | null>(null)
  const [playTarget, setPlayTarget] = useState<Recording | null>(null)
  const [downloadingId, setDownloadingId] = useState<string | null>(null)
  const { currentBlueprint, currentStartedAt, clearCurrentRecording: clearStoreRecording } = useRecordingStore()
  const { activeSoundsetId, fadeMs } = useSettingsStore()

  const reload = () =>
    getAllRecordings().then(r =>
      setRecordings(
        r.filter(x => x.savedAt !== null)
          .sort((a, b) => (b.savedAt ?? 0) - (a.savedAt ?? 0))
      )
    )

  useEffect(() => { reload() }, [])

  const handleSaveCurrent = async () => {
    const name = prompt('Enter a name for this recording:')
    if (!name?.trim()) return
    const rec: Recording = {
      id: crypto.randomUUID(),
      name: name.trim(),
      savedAt: Date.now(),
      blueprint: currentBlueprint ?? [],
      createdAt: currentStartedAt ?? Date.now()
    }
    await saveRecording(rec)
    await clearCurrentRecording()
    clearStoreRecording()
    reload()
  }

  const handleDownload = async (rec: Recording) => {
    setDownloadingId(rec.id)
    try {
      const blob = await blueprintToMp3Blob(rec.blueprint, activeSoundsetId, fadeMs)
      downloadBlob(blob, `${rec.name}.mp3`)
    } finally {
      setDownloadingId(null)
    }
  }

  const handleDelete = async (rec: Recording) => {
    await deleteRecording(rec.id)
    setDeleteTarget(null)
    reload()
  }

  const formatDate = (ts: number) => new Date(ts).toLocaleString()
  const formatDuration = (blueprint: Recording['blueprint']) => {
    if (!blueprint.length) return '0s'
    const last = blueprint[blueprint.length - 1]
    const ms = last.timestamp + last.duration
    const s = Math.floor(ms / 1000)
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
  }

  return (
    <div className="settings-section">
      <h3 className="settings-section__title">Recordings</h3>

      {currentBlueprint && currentBlueprint.length > 0 && (
        <div className="current-recording-banner">
          <span>Unsaved recording ({currentBlueprint.length} note events)</span>
          <button className="btn btn--primary btn--sm" onClick={handleSaveCurrent}>
            Save to List
          </button>
        </div>
      )}

      {recordings.length === 0 ? (
        <p className="text-muted">No saved recordings yet.</p>
      ) : (
        <div className="item-list">
          {recordings.map(rec => (
            <div key={rec.id} className="item-list__row">
              <div className="item-label" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
                <span className="item-name">{rec.name}</span>
                <span className="item-meta">
                  {formatDate(rec.savedAt!)} · {formatDuration(rec.blueprint)} · {rec.blueprint.length} notes
                </span>
              </div>
              <div className="item-actions">
                <button
                  className="btn btn--secondary btn--sm"
                  onClick={() => setPlayTarget(rec)}
                  title="Play"
                >
                  ▶ Play
                </button>
                <button
                  className="btn btn--secondary btn--sm"
                  onClick={() => handleDownload(rec)}
                  disabled={downloadingId === rec.id}
                  title="Download MP3"
                >
                  {downloadingId === rec.id ? '…' : '⬇ MP3'}
                </button>
                <button
                  className="btn btn--danger-soft btn--sm"
                  onClick={() => setDeleteTarget(rec)}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {playTarget && (
        <PlaybackPopup
          name={playTarget.name ?? 'Recording'}
          blueprint={playTarget.blueprint}
          onClose={() => setPlayTarget(null)}
        />
      )}

      {deleteTarget && (
        <ConfirmDialog
          title="Delete Recording"
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
