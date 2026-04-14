import { useEffect, useRef, useState } from 'react'
import { Modal } from '../common/Modal'
import { NoteEvent } from '../../db/schema'
import { blueprintToMp3Blob } from '../../audio/blueprintPlayer'
import { useSettingsStore } from '../../store/useSettingsStore'
import './PlaybackPopup.css'

interface PlaybackPopupProps {
  name: string
  blueprint: NoteEvent[]
  onClose: () => void
}

function formatTime(sec: number): string {
  if (!isFinite(sec)) return '0:00'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

export function PlaybackPopup({ name, blueprint, onClose }: PlaybackPopupProps) {
  const { activeSoundsetId, fadeMs } = useSettingsStore()

  const audioRef = useRef<HTMLAudioElement>(null)
  const blobUrlRef = useRef<string | null>(null)

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)

  // Synthesize and load audio on mount
  useEffect(() => {
    let cancelled = false
    blueprintToMp3Blob(blueprint, activeSoundsetId, fadeMs)
      .then(blob => {
        if (cancelled) return
        const url = URL.createObjectURL(blob)
        blobUrlRef.current = url
        if (audioRef.current) {
          audioRef.current.src = url
          audioRef.current.load()
        }
        setLoading(false)
      })
      .catch(e => {
        if (!cancelled) setError(String(e))
        setLoading(false)
      })
    return () => {
      cancelled = true
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current)
        blobUrlRef.current = null
      }
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const handlePlayPause = () => {
    const audio = audioRef.current
    if (!audio) return
    if (playing) {
      audio.pause()
    } else {
      audio.play()
    }
  }

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const audio = audioRef.current
    if (!audio || !duration) return
    audio.currentTime = parseFloat(e.target.value) * duration
  }

  const progress = duration > 0 ? currentTime / duration : 0

  return (
    <Modal title={`Playing: ${name}`} onClose={onClose} size="sm">
      <div className="playback-popup">
        <audio
          ref={audioRef}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
          onTimeUpdate={() => setCurrentTime(audioRef.current?.currentTime ?? 0)}
          onLoadedMetadata={() => setDuration(audioRef.current?.duration ?? 0)}
        />

        {loading && <p className="playback-popup__status">Generating audio…</p>}
        {error && <p className="playback-popup__error">{error}</p>}

        {!loading && !error && (
          <>
            <div className="playback-popup__controls">
              <button
                className="btn btn--primary playback-popup__playbtn"
                onClick={handlePlayPause}
              >
                {playing ? '⏸' : '▶'}
              </button>

              <div className="playback-popup__scrubber">
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.001}
                  value={progress}
                  onChange={handleSeek}
                  className="scrubber"
                />
                <div className="playback-popup__times">
                  <span>{formatTime(currentTime)}</span>
                  <span>{formatTime(duration)}</span>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}
