import { mediaKindOf, mediaUrl } from '../../lib/media'
import type { FileSource } from './sources'

/** **Thumbnails** for the listings' "View thumbnails" mode: a small JPEG of a picture, or of a video's first seconds, made in the
 * page (the webview decodes whatever it can play), then remembered:
 * - in a Filen account or branch, on disk with the cache (`files/t`, `files/tb` — see `files_cache.rs`), per version of the file
 *   (its modification time and size), so they outlive the session and go with the branch when it is committed or discarded;
 * - on this device, for the session only (a Map of blob addresses) — the files are right there to be decoded again.
 * A file that can't be shown (not a picture the webview knows, too big to fetch just for a preview) has none, and the listing
 * draws an icon. */

const SIDE = 256
const QUALITY = 0.8
const TIMEOUT_MS = 20000
/** A Filen file is fetched whole into the cache before it can be read: for a preview that is only worth it when it is small
 * — or already there. */
const FILEN_PREVIEW_LIMIT = 32 * 1024 * 1024
/** Nothing above this is decoded as a picture just for its thumbnail. */
const IMAGE_LIMIT = 200 * 1024 * 1024

const made = new Map<string, Promise<string | null>>()
let running = 0
const waiting: Array<() => void> = []
const PARALLEL = 3

async function turn<T>(work: () => Promise<T>): Promise<T> {
  if (running >= PARALLEL) await new Promise<void>((resolve) => waiting.push(resolve))
  running++
  try {
    return await work()
  } finally {
    running--
    waiting.shift()?.()
  }
}

function withTimeout<T>(promise: Promise<T>, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(`${what} took too long.`)), TIMEOUT_MS)
    promise.then(
      (value) => {
        window.clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        window.clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/** Draws `source` (`width` × `height`) small, as a JPEG. */
async function jpegOf(source: CanvasImageSource, width: number, height: number): Promise<Blob> {
  const scale = Math.min(1, SIDE / Math.max(width, height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width * scale))
  canvas.height = Math.max(1, Math.round(height * scale))
  const context = canvas.getContext('2d')
  if (!context) throw new Error('No canvas.')
  context.fillStyle = '#ffffff' // a transparent picture on white, as JPEG has no transparency
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.drawImage(source, 0, 0, canvas.width, canvas.height)
  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('No thumbnail.'))), 'image/jpeg', QUALITY))
}

async function fromImage(url: string): Promise<Blob> {
  const image = new Image()
  image.crossOrigin = 'anonymous'
  image.src = url
  await withTimeout(image.decode(), 'Decoding the picture')
  return jpegOf(image, image.naturalWidth, image.naturalHeight)
}

async function fromVideo(url: string): Promise<Blob> {
  const video = document.createElement('video')
  video.crossOrigin = 'anonymous'
  video.muted = true
  video.preload = 'metadata'
  video.playsInline = true
  const once = (event: string) => new Promise<void>((resolve, reject) => {
    video.addEventListener(event, () => resolve(), { once: true })
    video.addEventListener('error', () => reject(new Error('The video can not be read.')), { once: true })
  })
  try {
    video.src = url
    await withTimeout(once('loadedmetadata'), 'Reading the video')
    const seeking = once('seeked')
    video.currentTime = Math.min(1, (video.duration || 2) / 10) // a moment in, past a fade-in
    await withTimeout(seeking, 'Seeking in the video')
    return await jpegOf(video, video.videoWidth, video.videoHeight)
  } finally {
    video.removeAttribute('src')
    video.load()
  }
}

/** The address of a thumbnail (a blob URL) for the file, or `null` when it has none. `size` and `mtimeMs` are what the listing said
 * (they say which version of a Filen file a stored thumbnail is for); `cached`: the file's content is already in the cache. */
export function thumbnailOf(source: FileSource, path: string, size: number | null, mtimeMs: number | null, cached = false): Promise<string | null> {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const kind = mediaKindOf(name)
  if (kind !== 'image' && kind !== 'video') return Promise.resolve(null)
  const key = `${source.viewKey}|${path}|${mtimeMs ?? ''}|${size ?? ''}`
  let existing = made.get(key)
  if (!existing) {
    existing = turn(() => make(source, path, kind, size, mtimeMs, cached)).catch(() => null)
    made.set(key, existing)
  }
  return existing
}

async function make(source: FileSource, path: string, kind: 'image' | 'video', size: number | null, mtimeMs: number | null, cached: boolean): Promise<string | null> {
  const store = source.thumbnails
  const version = { mtime: mtimeMs ?? 0, size: size ?? 0 }
  if (store && mtimeMs !== null && size !== null) {
    const kept = await store.get(path, version.mtime, version.size).catch(() => null)
    if (kept && kept.length > 0) return URL.createObjectURL(new Blob([kept as BlobPart], { type: 'image/jpeg' }))
  }
  if (source.kind === 'filen' && !cached && (size === null || size > FILEN_PREVIEW_LIMIT)) return null
  if (kind === 'image' && size !== null && size > IMAGE_LIMIT) return null
  if (!source.fileRef) return null
  const url = await mediaUrl(source.fileRef(path))
  const jpeg = kind === 'image' ? await fromImage(url) : await fromVideo(url)
  if (store && mtimeMs !== null && size !== null) {
    store.put(path, version.mtime, version.size, new Uint8Array(await jpeg.arrayBuffer())).catch(() => {})
  }
  return URL.createObjectURL(jpeg)
}
