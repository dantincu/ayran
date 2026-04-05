import { useAppInit } from './hooks/useAppInit'
import { SetupModal } from './components/SetupModal'
import { FileExplorer } from './components/FileExplorer'
import { VideoPlayer } from './components/VideoPlayer'
import './App.css'

export default function App() {
  const {
    phase,
    config,
    appState,
    tree,
    currentFile,
    errorMessage,
    warnings,
    onSetupComplete,
    onOpenLibrary,
    onSelectFile,
    onSavePosition,
    onMarkWatched,
    onRefresh,
    onReset,
    onDismissWarnings,
  } = useAppInit()

  const initialPosition = currentFile
    ? (appState.positions[currentFile.path] ?? 0)
    : 0

  if (phase === 'initializing') {
    return (
      <div className="fullscreen-center">
        <div className="spinner" />
      </div>
    )
  }

  if (phase === 'setup') {
    return <SetupModal onComplete={onSetupComplete} />
  }

  if (phase === 'restoring') {
    return (
      <div className="fullscreen-center">
        <div className="restore-card">
          <div className="restore-icon">&#9654;</div>
          <h2 className="restore-title">Video Player</h2>
          {config && (
            <p className="restore-dir">
              Library: <strong>{config.rootDirName}</strong>
            </p>
          )}
          <div className="restore-actions">
            <button className="btn-primary" onClick={onOpenLibrary}>
              Open Library
            </button>
            <button className="btn-ghost" onClick={onReset}>
              Choose Different Folder
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (phase === 'error') {
    return (
      <div className="fullscreen-center">
        <div className="error-card">
          <p className="error-icon">&#9888;</p>
          <p className="error-msg">{errorMessage ?? 'An unexpected error occurred.'}</p>
          <button className="btn-primary" onClick={onReset}>
            Start Over
          </button>
        </div>
      </div>
    )
  }

  // phase === 'loading' | 'ready'
  return (
    <div className="app-layout">
      <div className="app-sidebar">
        {phase === 'loading' ? (
          <div className="sidebar-loading">
            <div className="spinner spinner--small" />
            <span>Loading library\u2026</span>
          </div>
        ) : (
          <FileExplorer
            tree={tree}
            appState={appState}
            currentFilePath={currentFile?.path ?? null}
            onSelectFile={onSelectFile}
            onRefresh={onRefresh}
          />
        )}
      </div>

      <div className="app-main">
        <div className="app-topbar">
          <span className="app-topbar-title">
            {config?.rootDirName ?? ''}
          </span>
          <button className="app-topbar-btn" onClick={onReset} title="Change directory">
            <span>&#9881;</span> Change Folder
          </button>
        </div>

        {warnings.length > 0 && (
          <div className="app-warnings">
            <div className="app-warnings-header">
              <span>&#9888; {warnings.length} file{warnings.length > 1 ? 's' : ''} could not be read and were skipped:</span>
              <button className="app-warnings-dismiss" onClick={onDismissWarnings}>&#10005;</button>
            </div>
            <ul className="app-warnings-list">
              {warnings.map(w => <li key={w}>{w}</li>)}
            </ul>
          </div>
        )}

        <div className="app-player">
          <VideoPlayer
            file={currentFile}
            initialPosition={initialPosition}
            onSavePosition={onSavePosition}
            onMarkWatched={onMarkWatched}
          />
        </div>
      </div>
    </div>
  )
}
