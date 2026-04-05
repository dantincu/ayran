import { useEffect, useRef, useState } from 'react'
import { useVideoPlayer as useExpoVideoPlayer } from 'expo-video'
import type { VideoPlayer } from 'expo-video'
import type { FileNode } from '../types'

interface Options {
  file: FileNode | null
  initialPosition: number
  onSavePosition: (path: string, position: number) => Promise<void>
  onMarkWatched: (path: string) => Promise<void>
}

interface Result {
  player: VideoPlayer
  isLoading: boolean
  loadError: string | null
}

const WATCHED_THRESHOLD = 0.92
// expo-video timeUpdateEventInterval controls how often 'timeUpdate' fires (seconds).
// We use it as our periodic-save interval.
const SAVE_INTERVAL_SEC = 5

export function useVideoPlayer({ file, initialPosition, onSavePosition, onMarkWatched }: Options): Result {
  const [isLoading, setIsLoading] = useState(!!file)
  const [loadError, setLoadError] = useState<string | null>(null)

  // Keep callbacks in refs so event handlers never capture stale closures
  const onSavePositionRef = useRef(onSavePosition)
  onSavePositionRef.current = onSavePosition
  const onMarkWatchedRef = useRef(onMarkWatched)
  onMarkWatchedRef.current = onMarkWatched

  const fileRef = useRef(file)
  const initialPositionRef = useRef(initialPosition)
  const seekedRef = useRef(false)
  const wasPlayingRef = useRef(false)

  const player = useExpoVideoPlayer(
    file ? { uri: file.uri } : null,
    p => {
      p.timeUpdateEventInterval = SAVE_INTERVAL_SEC
      if (file) p.play()
    },
  )

  // Swap source and reset tracking state whenever the active file changes
  useEffect(() => {
    fileRef.current = file
    initialPositionRef.current = initialPosition
    seekedRef.current = false
    wasPlayingRef.current = false

    if (file) {
      setIsLoading(true)
      setLoadError(null)
      player.replace({ uri: file.uri })
      player.play()
    } else {
      setIsLoading(false)
      setLoadError(null)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file?.uri])

  // Subscribe to all player events
  useEffect(() => {
    const onStatus = player.addListener('statusChange', ({ status, error }) => {
      if (status === 'loading') {
        setIsLoading(true)
        setLoadError(null)
      } else if (status === 'readyToPlay') {
        setIsLoading(false)
        // Seek to resume position once, after the duration is known
        if (!seekedRef.current) {
          seekedRef.current = true
          const saved = initialPositionRef.current
          const dur = player.duration
          if (saved > 0 && dur > 0 && saved < dur - 3) {
            player.currentTime = saved
          }
        }
      } else if (status === 'error') {
        setIsLoading(false)
        setLoadError(error?.message ?? 'Failed to load video')
      }
    })

    const onPlaying = player.addListener('playingChange', ({ isPlaying }) => {
      const f = fileRef.current
      if (!f) return
      // Save position on pause (playing → paused transition)
      if (!isPlaying && wasPlayingRef.current) {
        void onSavePositionRef.current(f.path, player.currentTime)
      }
      wasPlayingRef.current = isPlaying
    })

    // timeUpdate fires every SAVE_INTERVAL_SEC while playing
    const onTime = player.addListener('timeUpdate', ({ currentTime }) => {
      const f = fileRef.current
      if (!f || !player.playing) return
      void onSavePositionRef.current(f.path, currentTime)
      const dur = player.duration
      if (dur > 0 && currentTime / dur >= WATCHED_THRESHOLD) {
        void onMarkWatchedRef.current(f.path)
      }
    })

    const onEnd = player.addListener('playToEnd', () => {
      const f = fileRef.current
      if (!f) return
      void onMarkWatchedRef.current(f.path)
      void onSavePositionRef.current(f.path, 0)
      wasPlayingRef.current = false
    })

    return () => {
      onStatus.remove()
      onPlaying.remove()
      onTime.remove()
      onEnd.remove()
    }
  }, [player])

  return { player, isLoading, loadError }
}
