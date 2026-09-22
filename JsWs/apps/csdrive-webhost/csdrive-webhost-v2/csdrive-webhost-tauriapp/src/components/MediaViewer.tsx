import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight, FastForward, Maximize, Minimize, Minus, Music, Pause, Play, Plus, Rewind, RectangleHorizontal, Volume2, VolumeX, X } from 'lucide-react'
import IconButton from './IconButton'
import { clock, mediaUrl, type MediaKind } from '../lib/media'
import type { FileRef } from '../lib/secondaryWindows'

/** **The media viewer**: a picture, a video or a sound of a folder, over the whole window, with the folder's other media a step
 * away (the arrows, PageUp/PageDown). The file is not read into the page: it is an address the webview loads by itself, served from
 * disk a piece at a time (see `file_serving.rs`), so a big video is never held whole in memory.
 *
 * - **Picture**: opens showing the whole of it. Zoom with the wheel, a pinch, the buttons or a double click; drag it when it is
 *   bigger than the window — it can't be dragged off, so once it is zoomed in enough the window is filled by it. One press on the
 *   picture hides the menus, the next brings them back.
 * - **Video / sound**: a bar of its own — play, back and forward ten seconds (on the press, not on the release), a progress that can
 *   be dragged, the time, the volume. Playing a video hides the bars; a press on it brings them back and, if it is still playing,
 *   they go again after a few seconds.
 * - **Full screen** for any of them (Esc leaves it). */

export interface MediaItem {
  name: string
  kind: MediaKind
  file: FileRef
}

interface Props {
  items: MediaItem[]
  /** The one shown first. */
  start: number
  onClose: () => void
  /** What the host puts in the bar for the item shown — the cache options of a file that has a cache. `reload` loads the media again
   * (after its cache was refreshed or cleared). */
  renderCache?: (item: MediaItem, reload: () => void) => ReactNode
}

/** How long the bars of a playing video stay after they were brought back. */
const HIDE_AFTER_MS = 3000
const SKIP_SECONDS = 10
const MAX_ZOOM = 16

export default function MediaViewer({ items, start, onClose, renderCache }: Props) {
  const [index, setIndex] = useState(Math.min(Math.max(start, 0), items.length - 1))
  const item = items[index]
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [bars, setBars] = useState(true)
  const [fullscreen, setFullscreen] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  /** How many times the media was asked to load again: the address gets it as a query, so the webview doesn't show what it kept. */
  const [reloads, setReloads] = useState(0)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    setUrl(null)
    setError(null)
    setBars(true)
    mediaUrl(item.file).then(
      (address) => !cancelled && setUrl(reloads > 0 ? `${address}${address.includes('?') ? '&' : '?'}r=${reloads}` : address),
      (e) => !cancelled && setError(String(e)),
    )
    return () => {
      cancelled = true
    }
  }, [item, reloads])

  const step = useCallback(
    (by: number) => setIndex((i) => Math.min(items.length - 1, Math.max(0, i + by))),
    [items.length],
  )

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen()
      else await root.current?.requestFullscreen()
    } catch {
      setNotice("This window can't go full screen.")
      window.setTimeout(() => setNotice(null), 2500)
    }
  }

  useEffect(() => {
    const changed = () => setFullscreen(document.fullscreenElement !== null)
    document.addEventListener('fullscreenchange', changed)
    return () => document.removeEventListener('fullscreenchange', changed)
  }, [])

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      } else if (e.key === 'PageDown' || (item.kind === 'image' && e.key === 'ArrowRight')) {
        e.preventDefault()
        step(1)
      } else if (e.key === 'PageUp' || (item.kind === 'image' && e.key === 'ArrowLeft')) {
        e.preventDefault()
        step(-1)
      } else if (e.key === 'f' || e.key === 'F') {
        e.preventDefault()
        void toggleFullscreen()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.kind, onClose, step])

  return (
    <div ref={root} className="media-viewer" role="dialog" aria-label={item.name}>
      {error ? (
        <div className="media-message">{error}</div>
      ) : url === null ? (
        <div className="media-message">Loading…</div>
      ) : item.kind === 'image' ? (
        <ImageStage key={url} url={url} name={item.name} bars={bars} setBars={setBars} />
      ) : (
        <PlayerStage key={url} url={url} kind={item.kind} name={item.name} bars={bars} setBars={setBars} />
      )}

      <div className={`media-bar media-bar-top ${bars ? '' : 'media-bar-hidden'}`}>
        <span className="media-title" title={item.name}>
          {item.name}
        </span>
        <span className="muted media-count">
          {index + 1} / {items.length}
        </span>
        <IconButton icon={ChevronLeft} label="Previous (PageUp)" onClick={() => step(-1)} disabled={index === 0} />
        <IconButton icon={ChevronRight} label="Next (PageDown)" onClick={() => step(1)} disabled={index === items.length - 1} />
        {renderCache?.(item, () => setReloads((n) => n + 1))}
        <IconButton icon={fullscreen ? Minimize : Maximize} label={fullscreen ? 'Leave full screen (F)' : 'Full screen (F)'} onClick={toggleFullscreen} />
        <IconButton icon={X} label="Close (Esc)" onClick={onClose} />
      </div>
      {notice && <div className="media-notice">{notice}</div>}
    </div>
  )
}

// ── A picture ─────────────────────────────────────────────────────────────────

interface View {
  scale: number
  x: number
  y: number
}

const distance = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y)

function ImageStage({ url, name, bars, setBars }: { url: string; name: string; bars: boolean; setBars: (visible: boolean) => void }) {
  const stage = useRef<HTMLDivElement>(null)
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null)
  const [failed, setFailed] = useState(false)
  const [room, setRoom] = useState({ w: 0, h: 0 })
  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0 })
  /** The picture is at its "whole picture" size: it stays so when the window changes size. */
  const [fitted, setFitted] = useState(true)
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const gesture = useRef({ moved: false, pinchFrom: 0, scaleFrom: 1, downAt: { x: 0, y: 0 } })

  const fit = natural && room.w > 0 ? Math.min(1, room.w / natural.w, room.h / natural.h) : 1

  /** `v` kept where the picture can be: centred when it is smaller than the window along an axis, else with no gap at either edge. */
  const clamp = useCallback(
    (v: View): View => {
      if (!natural) return v
      const w = natural.w * v.scale
      const h = natural.h * v.scale
      return {
        scale: v.scale,
        x: w <= room.w ? (room.w - w) / 2 : Math.min(0, Math.max(room.w - w, v.x)),
        y: h <= room.h ? (room.h - h) / 2 : Math.min(0, Math.max(room.h - h, v.y)),
      }
    },
    [natural, room],
  )

  useEffect(() => {
    const el = stage.current
    if (!el) return
    const measure = () => setRoom({ w: el.clientWidth, h: el.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // Whole picture, until the person zooms.
  useEffect(() => {
    if (fitted) setView(clamp({ scale: fit, x: 0, y: 0 }))
    else setView((v) => clamp(v))
  }, [fitted, fit, clamp])

  const zoomTo = useCallback(
    (scale: number, cx = room.w / 2, cy = room.h / 2) => {
      setView((v) => {
        const next = Math.min(MAX_ZOOM, Math.max(fit, scale))
        const k = next / v.scale
        return clamp({ scale: next, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k })
      })
      setFitted(scale <= fit * 1.001)
    },
    [clamp, fit, room],
  )

  // The wheel zooms about the pointer (a listener of its own: React's are passive, and the page must not scroll).
  useEffect(() => {
    const el = stage.current
    if (!el) return
    function onWheel(e: WheelEvent) {
      e.preventDefault()
      const box = el!.getBoundingClientRect()
      zoomTo(view.scale * Math.exp(-e.deltaY * 0.0015), e.clientX - box.left, e.clientY - box.top)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [view.scale, zoomTo])

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (e.key === '+' || e.key === '=') zoomTo(view.scale * 1.4)
      else if (e.key === '-') zoomTo(view.scale / 1.4)
      else if (e.key === '0') zoomTo(fit)
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [fit, view.scale, zoomTo])

  function point(e: React.PointerEvent) {
    const box = stage.current!.getBoundingClientRect()
    return { x: e.clientX - box.left, y: e.clientY - box.top }
  }

  function onPointerDown(e: React.PointerEvent) {
    try {
      stage.current?.setPointerCapture(e.pointerId)
    } catch {
      // a pointer that is already gone (a script's, a fast lift): nothing to capture
    }
    pointers.current.set(e.pointerId, point(e))
    const g = gesture.current
    if (pointers.current.size === 1) {
      g.moved = false
      g.downAt = point(e)
    } else if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()]
      g.pinchFrom = distance(a, b)
      g.scaleFrom = view.scale
      g.moved = true // a pinch is not a press
    }
  }

  function onPointerMove(e: React.PointerEvent) {
    const before = pointers.current.get(e.pointerId)
    if (!before) return
    const now = point(e)
    pointers.current.set(e.pointerId, now)
    const g = gesture.current
    if (pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()]
      if (g.pinchFrom > 0) zoomTo(g.scaleFrom * (distance(a, b) / g.pinchFrom), (a.x + b.x) / 2, (a.y + b.y) / 2)
      return
    }
    if (!g.moved && distance(now, g.downAt) > 6) g.moved = true
    if (g.moved) setView((v) => clamp({ ...v, x: v.x + now.x - before.x, y: v.y + now.y - before.y }))
  }

  function onPointerUp(e: React.PointerEvent) {
    const wasOne = pointers.current.size === 1
    pointers.current.delete(e.pointerId)
    if (wasOne && !gesture.current.moved) setBars(!bars) // a press on the picture: the menus go, or come back
  }

  return (
    <>
      <div
        ref={stage}
        className="media-stage media-stage-image"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={(e) => pointers.current.delete(e.pointerId)}
        onDoubleClick={(e) => {
          const box = stage.current!.getBoundingClientRect()
          zoomTo(fitted ? Math.max(1, fit * 3) : fit, e.clientX - box.left, e.clientY - box.top)
        }}
      >
        {failed && <div className="media-message">This picture can't be shown.</div>}
        <img
          src={url}
          alt={name}
          draggable={false}
          className="media-image"
          onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth || 512, h: e.currentTarget.naturalHeight || 512 })}
          onError={() => setFailed(true)}
          style={
            natural
              ? { width: natural.w, height: natural.h, transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }
              : { visibility: 'hidden' }
          }
        />
      </div>
      <div className={`media-bar media-bar-bottom ${bars ? '' : 'media-bar-hidden'}`}>
        <IconButton icon={Minus} label="Zoom out (-)" onClick={() => zoomTo(view.scale / 1.4)} />
        <span className="media-zoom">{Math.round(view.scale * 100)}%</span>
        <IconButton icon={Plus} label="Zoom in (+)" onClick={() => zoomTo(view.scale * 1.4)} />
        <IconButton icon={RectangleHorizontal} label="Show the whole picture (0)" onClick={() => zoomTo(fit)} />
      </div>
    </>
  )
}

// ── Video and sound ───────────────────────────────────────────────────────────

function PlayerStage({
  url,
  kind,
  name,
  bars,
  setBars,
}: {
  url: string
  kind: 'video' | 'audio'
  name: string
  bars: boolean
  setBars: (visible: boolean) => void
}) {
  const media = useRef<HTMLVideoElement | HTMLAudioElement | null>(null)
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [muted, setMuted] = useState(false)
  const [failed, setFailed] = useState(false)
  const dragging = useRef(false)
  const hideTimer = useRef<number | undefined>(undefined)
  const isVideo = kind === 'video'

  // The bars of a playing video go after a while; a sound keeps them (there is nothing else to look at).
  const scheduleHide = useCallback(() => {
    window.clearTimeout(hideTimer.current)
    if (isVideo) hideTimer.current = window.setTimeout(() => setBars(false), HIDE_AFTER_MS)
  }, [isVideo, setBars])

  useEffect(() => {
    if (isVideo && playing && bars) scheduleHide()
    else window.clearTimeout(hideTimer.current)
    return () => window.clearTimeout(hideTimer.current)
  }, [isVideo, playing, bars, scheduleHide])

  const toggle = useCallback(() => {
    const el = media.current
    if (!el) return
    if (el.paused) void el.play().catch(() => setFailed(true))
    else el.pause()
  }, [])

  const skip = useCallback((seconds: number) => {
    const el = media.current
    if (!el) return
    el.currentTime = Math.min(el.duration || Infinity, Math.max(0, el.currentTime + seconds))
    setTime(el.currentTime)
  }, [])

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.ctrlKey || e.metaKey || e.altKey || (e.target instanceof HTMLElement && ['INPUT', 'BUTTON'].includes(e.target.tagName) && e.key === ' ')) return
      if (e.key === ' ') toggle()
      else if (e.key === 'ArrowLeft') skip(-SKIP_SECONDS)
      else if (e.key === 'ArrowRight') skip(SKIP_SECONDS)
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [skip, toggle])

  const shared = {
    ref: media as React.RefObject<never>,
    src: url,
    preload: 'metadata' as const,
    onPlay: () => {
      setPlaying(true)
      if (isVideo) setBars(false) // playing: the menu goes
    },
    onPause: () => {
      setPlaying(false)
      setBars(true)
    },
    onEnded: () => setBars(true),
    onLoadedMetadata: () => setDuration(media.current?.duration ?? 0),
    onDurationChange: () => setDuration(media.current?.duration ?? 0),
    onTimeUpdate: () => {
      if (!dragging.current) setTime(media.current?.currentTime ?? 0)
    },
    onError: () => setFailed(true),
  }

  return (
    <>
      <div
        className="media-stage media-stage-player"
        onClick={() => {
          if (isVideo) setBars(!bars) // a press on the video: the menu comes back (and goes again if it keeps playing)
        }}
      >
        {isVideo ? (
          <video {...shared} className="media-video" playsInline />
        ) : (
          <>
            <audio {...shared} />
            <div className="media-sound">
              <Music size={64} strokeWidth={1.5} aria-hidden="true" />
              <div>{name}</div>
            </div>
          </>
        )}
        {failed && <div className="media-message">This {kind === 'video' ? 'video' : 'sound'} can't be played here.</div>}
      </div>

      <div className={`media-bar media-bar-bottom media-player ${bars ? '' : 'media-bar-hidden'}`} onPointerDown={scheduleHide}>
        <IconButton icon={playing ? Pause : Play} label={playing ? 'Pause (Space)' : 'Play (Space)'} onClick={toggle} />
        {/* On the press, not the release: a skip is as quick as the finger. */}
        <button
          type="button"
          className="icon-button media-skip"
          title={`Back ${SKIP_SECONDS} seconds (Left)`}
          aria-label={`Back ${SKIP_SECONDS} seconds`}
          onPointerDown={(e) => {
            e.preventDefault()
            skip(-SKIP_SECONDS)
          }}
          onKeyDown={(e) => (e.key === 'Enter' ? skip(-SKIP_SECONDS) : undefined)}
        >
          <Rewind size={16} strokeWidth={2} aria-hidden="true" />
          <span>{SKIP_SECONDS}</span>
        </button>
        <span className="media-time">{clock(time)}</span>
        <input
          type="range"
          className="media-progress"
          min={0}
          max={duration || 0}
          step="any"
          value={Math.min(time, duration || 0)}
          aria-label="Position"
          onPointerDown={() => (dragging.current = true)}
          onPointerUp={() => (dragging.current = false)}
          onChange={(e) => {
            const at = Number(e.target.value)
            setTime(at)
            if (media.current) media.current.currentTime = at
          }}
        />
        <span className="media-time">{clock(duration)}</span>
        <button
          type="button"
          className="icon-button media-skip"
          title={`Forward ${SKIP_SECONDS} seconds (Right)`}
          aria-label={`Forward ${SKIP_SECONDS} seconds`}
          onPointerDown={(e) => {
            e.preventDefault()
            skip(SKIP_SECONDS)
          }}
          onKeyDown={(e) => (e.key === 'Enter' ? skip(SKIP_SECONDS) : undefined)}
        >
          <FastForward size={16} strokeWidth={2} aria-hidden="true" />
          <span>{SKIP_SECONDS}</span>
        </button>
        <IconButton
          icon={muted ? VolumeX : Volume2}
          label={muted ? 'Sound on' : 'Sound off'}
          onClick={() => {
            const el = media.current
            if (el) el.muted = !el.muted
            setMuted((m) => !m)
          }}
        />
      </div>
    </>
  )
}
