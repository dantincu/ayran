import { useState } from 'react'
import { useRecordingStore } from '../../store/useRecordingStore'
import { saveCurrentRecording, clearCurrentRecording as clearIdbRecording } from '../../db/recordingsDb'
import {
  startRecording as startAudioRec,
  pauseRecording as pauseAudioRec,
  resumeMediaRecording,
  stopRecordingAndGetBlob
} from '../../audio/recorder'
import { SaveRecordingPopup } from './SaveRecordingPopup'
import './RecordingControls.css'

export function RecordingControls() {
  const {
    state,
    startRecording,
    pauseRecording,
    resumeRecording,
    stopRecording,
    showSavePopup,
    currentBlueprint,
    currentStartedAt,
    clearCurrentRecording: clearStoreRecording
  } = useRecordingStore()

  const [recordingBlob, setRecordingBlob] = useState<Blob | null>(null)

  const handleStart = () => {
    // Clear previous unsaved recording
    clearIdbRecording()
    clearStoreRecording()
    startAudioRec()
    startRecording()
  }

  const handlePause = () => {
    pauseAudioRec()
    pauseRecording()
  }

  const handleResume = () => {
    resumeMediaRecording()
    resumeRecording()
  }

  const handleStop = async () => {
    // Capture blueprint before stopRecording() clears it
    const { blueprint, startedAt } = useRecordingStore.getState()
    const blob = await stopRecordingAndGetBlob()
    setRecordingBlob(blob)
    stopRecording()
    // Persist current recording blueprint to IDB
    if (blueprint.length > 0 && startedAt !== null) {
      await saveCurrentRecording(blueprint, startedAt)
    }
  }

  const handleClosePopup = () => {
    useRecordingStore.getState().closeSavePopup()
  }

  return (
    <>
      <div className="recording-controls">
        {state === 'idle' && (
          <>
            <button className="btn btn--record" onClick={handleStart} title="Start Recording">
              <span className="rec-dot" /> Record
            </button>
            {currentBlueprint && currentBlueprint.length > 0 && (
              <button
                className="btn btn--secondary btn--sm"
                onClick={() => {
                  clearIdbRecording()
                  clearStoreRecording()
                }}
                title="Discard unsaved recording"
              >
                Discard
              </button>
            )}
          </>
        )}

        {(state === 'recording' || state === 'paused') && (
          <>
            <span className="recording-badge">
              <span className={`rec-dot ${state === 'paused' ? 'rec-dot--paused' : 'rec-dot--active'}`} />
              {state === 'recording' ? 'Recording...' : 'Paused'}
            </span>

            {state === 'recording' ? (
              <button className="btn btn--secondary btn--sm" onClick={handlePause} title="Pause Recording">
                ⏸ Pause
              </button>
            ) : (
              <button className="btn btn--primary btn--sm" onClick={handleResume} title="Resume Recording">
                ▶ Resume
              </button>
            )}

            <button className="btn btn--stop btn--sm" onClick={handleStop} title="Stop Recording">
              ⏹ Stop
            </button>
          </>
        )}
      </div>

      {showSavePopup && (
        <SaveRecordingPopup
          recordingBlob={recordingBlob}
          onClose={handleClosePopup}
        />
      )}
    </>
  )
}
