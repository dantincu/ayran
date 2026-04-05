import { useState } from 'react'
import './SetupModal.css'

interface Props {
  onComplete: (rootHandle: FileSystemDirectoryHandle, dataFolderPath: string) => Promise<void>
}

export function SetupModal({ onComplete }: Props) {
  const [rootHandle, setRootHandle] = useState<FileSystemDirectoryHandle | null>(null)
  const [dataPath, setDataPath] = useState('.video-player')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState('')

  async function pickDirectory() {
    try {
      const handle = await window.showDirectoryPicker({ mode: 'readwrite' })
      setRootHandle(handle)
      setError('')
    } catch (e) {
      if (e instanceof Error && e.name !== 'AbortError') {
        setError('Could not open the directory. Please try again.')
      }
    }
  }

  async function handleConfirm() {
    if (!rootHandle) return
    const trimmed = dataPath.trim().replace(/^[/\\]+|[/\\]+$/g, '')
    if (!trimmed) {
      setError('Data folder path cannot be empty.')
      return
    }
    setIsLoading(true)
    setError('')
    try {
      await onComplete(rootHandle, trimmed)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'An error occurred.')
      setIsLoading(false)
    }
  }

  const previewPath = rootHandle
    ? `${rootHandle.name}/${dataPath.trim() || '.video-player'}/state.json`
    : null

  return (
    <div className="setup-overlay">
      <div className="setup-dialog">
        <div className="setup-icon">&#9654;</div>
        <h1 className="setup-title">Video Player</h1>
        <p className="setup-subtitle">Choose a folder containing your video files to get started.</p>

        <div className="setup-field">
          <label className="setup-label">Video library folder</label>
          <button
            className={`setup-pick-btn ${rootHandle ? 'setup-pick-btn--chosen' : ''}`}
            onClick={pickDirectory}
            disabled={isLoading}
          >
            {rootHandle ? (
              <>
                <span className="setup-pick-check">&#10003;</span>
                <span className="setup-pick-name">{rootHandle.name}</span>
                <span className="setup-pick-change">Change</span>
              </>
            ) : (
              'Choose Directory\u2026'
            )}
          </button>
        </div>

        <div className="setup-field">
          <label className="setup-label" htmlFor="data-path">
            App data folder
            <span className="setup-label-hint">&#8202;(relative path inside chosen directory)</span>
          </label>
          <input
            id="data-path"
            className="setup-input"
            value={dataPath}
            onChange={e => setDataPath(e.target.value)}
            placeholder=".video-player"
            disabled={isLoading}
          />
          {previewPath && (
            <p className="setup-preview">
              Will store data at: <code>{previewPath}</code>
            </p>
          )}
        </div>

        {error && <p className="setup-error">{error}</p>}

        <button
          className="setup-confirm-btn"
          disabled={!rootHandle || isLoading}
          onClick={handleConfirm}
        >
          {isLoading ? 'Opening\u2026' : 'Open Library'}
        </button>
      </div>
    </div>
  )
}
