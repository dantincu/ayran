import { useEffect, useRef, useState } from 'react'
import type { FileNode } from '../types'
import { getFileObjectUrl } from '../utils/fileSystem'

interface UseVideoPlayerOptions {
  file: FileNode | null
  initialPosition: number
  onSavePosition: (path: string, position: number) => Promise<void>
  onMarkWatched: (path: string) => Promise<void>
}

interface UseVideoPlayerResult {
  videoRef: React.RefObject<HTMLVideoElement | null>
  objectUrl: string | null
  isLoading: boolean
  loadError: string | null
}

const SAVE_INTERVAL_MS = 5_000
const WATCHED_THRESHOLD = 0.92

export function useVideoPlayer({
  file,
  initialPosition,
  onSavePosition,
  onMarkWatched,
}: UseVideoPlayerOptions): UseVideoPlayerResult {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [objectUrl, setObjectUrl] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  // Keep callbacks in refs so effects don't need to re-run when they change
  const onSavePositionRef = useRef(onSavePosition)
  onSavePositionRef.current = onSavePosition
  const onMarkWatchedRef = useRef(onMarkWatched)
  onMarkWatchedRef.current = onMarkWatched
  const initialPositionRef = useRef(initialPosition)

  // Update initialPosition ref only when file changes (not on every position update)
  const filePathRef = useRef<string | null>(null)
  if (file?.path !== filePathRef.current) {
    filePathRef.current = file?.path ?? null
    initialPositionRef.current = initialPosition
  }

  // Load object URL when file changes
  useEffect(() => {
    if (!file || file.kind !== 'file') {
      setObjectUrl(prev => {
        if (prev) URL.revokeObjectURL(prev)
        return null
      })
      setLoadError(null)
      return
    }

    let cancelled = false
    let createdUrl: string | null = null

    setIsLoading(true)
    setLoadError(null)

    getFileObjectUrl(file.handle as FileSystemFileHandle)
      .then(url => {
        if (cancelled) {
          URL.revokeObjectURL(url)
          return
        }
        createdUrl = url
        setObjectUrl(prev => {
          if (prev) URL.revokeObjectURL(prev)
          return url
        })
        setIsLoading(false)
      })
      .catch(e => {
        if (!cancelled) {
          setLoadError(e instanceof Error ? e.message : 'Failed to load file')
          setIsLoading(false)
        }
      })

    return () => {
      cancelled = true
      if (createdUrl) URL.revokeObjectURL(createdUrl)
    }
  }, [file])

  // Restore position and start playback once metadata is loaded.
  // We call play() here instead of using the autoPlay attribute so that
  // the browser treats it as continuing a user gesture (the file-click),
  // which is required for unmuted audio on Android Chrome.
  useEffect(() => {
    if (!objectUrl || !videoRef.current) return
    const video = videoRef.current
    const savedPos = initialPositionRef.current

    function handleMeta() {
      if (savedPos > 0 && savedPos < video.duration - 3) {
        video.currentTime = savedPos
      }
      // Only call play() if autoPlay was blocked by the browser (e.g. Android Chrome).
      // On desktop, autoPlay already started playback; calling play() again here
      // causes Chrome to treat it as a new unprompted request and mute the audio.
      if (video.paused) {
        void video.play()
      }
    }

    video.addEventListener('loadedmetadata', handleMeta)
    return () => video.removeEventListener('loadedmetadata', handleMeta)
  }, [objectUrl])

  // Playback event listeners and periodic save
  useEffect(() => {
    const video = videoRef.current
    const filePath = file?.path
    if (!video || !filePath || !objectUrl) return

    function handlePause() {
      if (filePath) void onSavePositionRef.current(filePath, video!.currentTime)
    }

    function handleSeeked() {
      if (filePath) void onSavePositionRef.current(filePath, video!.currentTime)
    }

    function handleTimeUpdate() {
      if (!video || !filePath) return
      if (video.duration > 0 && video.currentTime / video.duration >= WATCHED_THRESHOLD) {
        void onMarkWatchedRef.current(filePath)
      }
    }

    function handleEnded() {
      if (filePath) {
        void onMarkWatchedRef.current(filePath)
        void onSavePositionRef.current(filePath, 0)
      }
    }

    video.addEventListener('pause', handlePause)
    video.addEventListener('seeked', handleSeeked)
    video.addEventListener('timeupdate', handleTimeUpdate)
    video.addEventListener('ended', handleEnded)

    const intervalId = setInterval(() => {
      if (video && !video.paused && video.currentTime > 0 && filePath) {
        void onSavePositionRef.current(filePath, video.currentTime)
      }
    }, SAVE_INTERVAL_MS)

    return () => {
      video.removeEventListener('pause', handlePause)
      video.removeEventListener('seeked', handleSeeked)
      video.removeEventListener('timeupdate', handleTimeUpdate)
      video.removeEventListener('ended', handleEnded)
      clearInterval(intervalId)
    }
  }, [file, objectUrl])

  return { videoRef, objectUrl, isLoading, loadError }
}
