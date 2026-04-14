import { useEffect, useState } from 'react'
import { useSettingsStore } from './store/useSettingsStore'
import { useRecordingStore } from './store/useRecordingStore'
import { getCurrentRecording } from './db/recordingsDb'
import { useTheme } from './hooks/useTheme'
import { PianoKeyboard } from './components/PianoKeyboard/PianoKeyboard'
import { RecordingControls } from './components/RecordingControls/RecordingControls'
import { SettingsModal } from './components/Settings/SettingsModal'
import './styles/base.css'
import './App.css'

export default function App() {
  const loadSettings = useSettingsStore(s => s.loadSettings)
  const loaded = useSettingsStore(s => s.loaded)
  const setCurrentRecording = useRecordingStore(s => s.setCurrentRecording)
  const [showSettings, setShowSettings] = useState(false)

  useTheme()

  useEffect(() => {
    loadSettings()
  }, [loadSettings])

  // Restore current recording from IDB on startup
  useEffect(() => {
    if (!loaded) return
    getCurrentRecording().then(rec => {
      if (rec) {
        setCurrentRecording(rec.blueprint, rec.startedAt)
      }
    })
  }, [loaded, setCurrentRecording])

  if (!loaded) {
    return (
      <div className="app-loading">
        <span>Loading...</span>
      </div>
    )
  }

  return (
    <div className="app">
      <header className="app-toolbar">
        <div className="app-toolbar__left">
          <span className="app-title">🎹 Ayran Piano</span>
        </div>
        <div className="app-toolbar__center">
          <RecordingControls />
        </div>
        <div className="app-toolbar__right">
          <button
            className="btn btn--secondary btn--sm"
            onClick={() => setShowSettings(true)}
            title="Settings"
          >
            ⚙ Settings
          </button>
        </div>
      </header>

      <main className="app-main">
        <PianoKeyboard />
      </main>

      {showSettings && (
        <SettingsModal onClose={() => setShowSettings(false)} />
      )}
    </div>
  )
}
