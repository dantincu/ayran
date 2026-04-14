import { useState } from 'react'
import { Modal } from '../common/Modal'
import { useRecordingStore } from '../../store/useRecordingStore'
import { saveRecording } from '../../db/recordingsDb'
import { stopRecordingAndGetBlob, downloadBlob } from '../../audio/recorder'
import { Recording } from '../../db/schema'
import './RecordingControls.css'

interface SaveRecordingPopupProps {
  recordingBlob: Blob | null
  onClose: () => void
}

export function SaveRecordingPopup({ recordingBlob, onClose }: SaveRecordingPopupProps) {
  const [filename, setFilename] = useState('my-recording')
  const [saving, setSaving] = useState(false)
  const { currentBlueprint, currentStartedAt, closeSavePopup } = useRecordingStore()

  const handleSave = async () => {
    if (!filename.trim()) return
    setSaving(true)
    try {
      // Download the audio file
      if (recordingBlob) {
        const ext = recordingBlob.type.includes('webm') ? 'webm' : 'mp3'
        downloadBlob(recordingBlob, `${filename.trim()}.${ext}`)
      }

      // Save blueprint to recordings list
      const rec: Recording = {
        id: crypto.randomUUID(),
        name: filename.trim(),
        savedAt: Date.now(),
        blueprint: currentBlueprint ?? [],
        createdAt: currentStartedAt ?? Date.now()
      }
      await saveRecording(rec)
      closeSavePopup()
    } finally {
      setSaving(false)
    }
  }

  const handleCancel = () => {
    onClose()
  }

  return (
    <Modal title="Save Recording" onClose={handleCancel} size="sm">
      <div className="save-recording">
        <p className="save-recording__desc">
          Enter a filename for the audio download.
          The recording blueprint will also be saved.
        </p>
        <div className="save-recording__row">
          <input
            className="input"
            value={filename}
            onChange={e => setFilename(e.target.value)}
            placeholder="Recording name"
            autoFocus
            onKeyDown={e => e.key === 'Enter' && handleSave()}
          />
        </div>
        <div className="save-recording__actions">
          <button className="btn btn--secondary" onClick={handleCancel}>Cancel</button>
          <button className="btn btn--primary" onClick={handleSave} disabled={saving || !filename.trim()}>
            {saving ? 'Saving...' : 'Save & Download'}
          </button>
        </div>
      </div>
    </Modal>
  )
}
