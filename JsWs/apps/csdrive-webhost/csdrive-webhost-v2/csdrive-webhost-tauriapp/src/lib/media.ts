import { mediaUrl as backendMediaUrl, type FileRef } from './secondaryWindows'

/** Which files the media viewer shows, by their extension: pictures, video and audio — as far as the webview can play them. */
export type MediaKind = 'image' | 'video' | 'audio'

const KINDS: Record<MediaKind, string[]> = {
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif', 'ico'],
  video: ['mp4', 'm4v', 'webm', 'ogv', 'mov'],
  audio: ['mp3', 'm4a', 'aac', 'wav', 'oga', 'ogg', 'opus', 'flac'],
}

/** What kind of media the file is, or `null` when it is none (or the viewer can't show it). */
export function mediaKindOf(name: string): MediaKind | null {
  const dot = name.lastIndexOf('.')
  if (dot < 0) return null
  const extension = name.slice(dot + 1).toLowerCase()
  for (const kind of Object.keys(KINDS) as MediaKind[]) if (KINDS[kind].includes(extension)) return kind
  return null
}

/** `83.4` → `1:23`, `3725` → `1:02:05`. */
export function clock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const whole = Math.floor(seconds)
  const [h, m, s] = [Math.floor(whole / 3600), Math.floor((whole % 3600) / 60), whole % 60]
  const two = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`
}

/** The address at which the page can load the file as a picture or media — served from disk a piece at a time, so a big video is
 * never held whole in memory (see `file_serving.rs`). */
export function mediaUrl(file: FileRef): Promise<string> {
  return backendMediaUrl(file)
}
