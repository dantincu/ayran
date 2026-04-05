import { useCallback, useEffect, useRef, useState } from 'react'
import type { FileNode } from '../types'
import { useVideoPlayer } from '../hooks/useVideoPlayer'
import './VideoPlayer.css'

interface Props {
  file: FileNode | null
  initialPosition: number
  onSavePosition: (path: string, position: number) => Promise<void>
  onMarkWatched: (path: string) => Promise<void>
}

function IconExpand() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
    </svg>
  )
}

function IconCompress() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3" />
    </svg>
  )
}

export function VideoPlayer({ file, initialPosition, onSavePosition, onMarkWatched }: Props) {
  const { videoRef, objectUrl, isLoading, loadError } = useVideoPlayer({
    file,
    initialPosition,
    onSavePosition,
    onMarkWatched,
  })

  const stageRef = useRef<HTMLDivElement>(null)
  const [isFullscreen, setIsFullscreen] = useState(false)

  useEffect(() => {
    function onFsChange() {
      setIsFullscreen(!!document.fullscreenElement)
    }
    document.addEventListener('fullscreenchange', onFsChange)
    return () => document.removeEventListener('fullscreenchange', onFsChange)
  }, [])

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen()
    } else if (stageRef.current) {
      void stageRef.current.requestFullscreen()
    }
  }, [])

  // F key shortcut (document-level, active while a video is loaded)
  useEffect(() => {
    if (!objectUrl) return
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (e.key === 'f' || e.key === 'F') {
        e.preventDefault()
        toggleFullscreen()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [objectUrl, toggleFullscreen])

  if (!file) {
    return (
      <div className="player player--empty">
        <div className="player-empty-content">
          <span className="player-empty-icon">&#9654;</span>
          <p className="player-empty-text">Select a video to play</p>
          <p className="player-empty-hint">Choose a file from the library on the left</p>
        </div>
      </div>
    )
  }

  return (
    <div className="player">
      <div className="player-titlebar">
        <span className="player-filename" title={file.path}>{file.name}</span>
        <button
          className="player-fs-btn player-fs-btn--bar"
          onClick={toggleFullscreen}
          title={isFullscreen ? 'Exit fullscreen (F)' : 'Fullscreen (F)'}
        >
          {isFullscreen ? <IconCompress /> : <IconExpand />}
        </button>
      </div>

      <div
        ref={stageRef}
        className="player-stage"
        onDoubleClick={objectUrl ? toggleFullscreen : undefined}
      >
        {isLoading && (
          <div className="player-overlay">
            <div className="player-spinner" />
          </div>
        )}

        {loadError && (
          <div className="player-overlay player-overlay--error">
            <p className="player-error-icon">&#9888;</p>
            <p className="player-error-msg">{loadError}</p>
          </div>
        )}

        {objectUrl && (
          <>
            <video
              ref={videoRef}
              className="player-video"
              src={objectUrl}
              controls
              autoPlay
            />
            {/* Floating button visible in fullscreen (hidden in normal mode via CSS) */}
            <button
              className="player-fs-btn player-fs-btn--float"
              onClick={e => { e.stopPropagation(); toggleFullscreen() }}
              title={isFullscreen ? 'Exit fullscreen (F)' : 'Fullscreen (F)'}
            >
              {isFullscreen ? <IconCompress /> : <IconExpand />}
            </button>
          </>
        )}
      </div>
    </div>
  )
}
