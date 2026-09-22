import { useEffect, useRef, useState } from 'react'
import { File as FileIcon, Film, Folder, Image as ImageIcon, MoreHorizontal, Music } from 'lucide-react'
import ContextMenu, { contextTrigger, type MenuItem } from '../../components/ContextMenu'
import IconButton from '../../components/IconButton'
import { kbdItem } from '../../lib/keyboard'
import { joinRelative } from '../../lib/localFs'
import { mediaKindOf } from '../../lib/media'
import type { Entry, FileSource } from './sources'
import { selectBaseName } from './renaming'
import { thumbnailOf } from './thumbnails'

interface Props {
  source: FileSource
  /** The folder shown. */
  path: string
  /** The entries of the page on screen. */
  entries: Entry[]
  /** Size and date the listing didn't carry (a folder of this device), asked for the page on screen. */
  meta: Record<string, { size: number | null; mtimeMs: number | null }>
  /** The index in the whole listing of the first entry shown (for the keyboard's focus). */
  firstIndex: number
  focused: number
  onFocus: (index: number) => void
  onOpen: (entry: Entry) => void
  menuFor: (entry: Entry) => MenuItem[]
  /** The entry being renamed, and how — its name is then a box. */
  renaming: { name: string; value: string; onChange: (value: string) => void; onCommit: () => void; onCancel: () => void; onStep: (step: -1 | 1) => void; isDirectory: boolean } | null
}

/** The folder as **thumbnails**: a card per entry — a picture's or a video's small image (made when the card comes into view; see
 * `thumbnails.ts`), an icon for the rest. A press opens (a folder, a picture in the viewer, a file in the editor); the card's
 * three dots — or a right click, or a long press — offer the rest. */
export default function ThumbnailGrid({ source, path, entries, meta, firstIndex, focused, onFocus, onOpen, menuFor, renaming }: Props) {
  const [menu, setMenu] = useState<{ entry: Entry; x: number; y: number } | null>(null)
  return (
    <>
      <div className="thumb-grid">
        {entries.length === 0 && <div className="muted">This folder is empty.</div>}
        {entries.map((entry, i) => (
          <div
            key={entry.name}
            className="thumb-card"
            {...kbdItem(focused, firstIndex + i, onFocus)}
            {...contextTrigger((x, y) => setMenu({ entry, x, y }))}
          >
            <button type="button" className="thumb-open" onClick={() => onOpen(entry)} title={entry.name}>
              <Preview source={source} path={path} entry={entry} meta={meta[entry.name]} />
            </button>
            <div className="thumb-name">
              {renaming?.name === entry.name ? (
                <input
                  autoFocus
                  data-ua-field="notes.thumbnails.rename"
                  value={renaming.value}
                  onChange={(e) => renaming.onChange(e.target.value)}
                  onFocus={(e) => selectBaseName(e.currentTarget, renaming.isDirectory)}
                  onBlur={renaming.onCommit}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') renaming.onCommit()
                    if (e.key === 'Escape') renaming.onCancel()
                    // As in Total Commander: Up and Down submit the new name and go on to rename the item before / after.
                    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                      e.preventDefault()
                      renaming.onStep(e.key === 'ArrowDown' ? 1 : -1)
                    }
                  }}
                />
              ) : (
                <span title={entry.name}>{entry.name}</span>
              )}
              <IconButton
                icon={MoreHorizontal}
                label="More…"
                onClick={(e) => {
                  const box = e.currentTarget.getBoundingClientRect()
                  setMenu({ entry, x: box.right, y: box.bottom })
                }}
              />
            </div>
          </div>
        ))}
      </div>
      {menu && <ContextMenu items={menuFor(menu.entry)} x={menu.x} y={menu.y} onClose={() => setMenu(null)} />}
    </>
  )
}

/** The picture of a card: the thumbnail once it is made (a card starts on it only when it comes into view), else an icon. */
function Preview({ source, path, entry, meta }: { source: FileSource; path: string; entry: Entry; meta: { size: number | null; mtimeMs: number | null } | undefined }) {
  const kind = entry.isDirectory ? null : mediaKindOf(entry.name)
  const holder = useRef<HTMLSpanElement>(null)
  const [visible, setVisible] = useState(false)
  const [src, setSrc] = useState<string | null>(null)
  const size = entry.size ?? meta?.size ?? null
  const mtimeMs = entry.mtimeMs ?? meta?.mtimeMs ?? null

  useEffect(() => {
    const el = holder.current
    if (!el || kind === null) return
    const observer = new IntersectionObserver((seen) => seen.some((s) => s.isIntersecting) && setVisible(true), { rootMargin: '200px' })
    observer.observe(el)
    return () => observer.disconnect()
  }, [kind])

  // A folder of this device has no size or date in its listing: they come with the page (`meta`), and are waited for so the
  // thumbnail is made once, for the version that is there.
  const ready = source.kind === 'filen' || (size !== null && mtimeMs !== null)
  useEffect(() => {
    if (!visible || !ready || kind === null) return
    let cancelled = false
    const file = joinRelative(path, entry.name)
    thumbnailOf(source, file, size, mtimeMs, entry.cached).then((url) => !cancelled && setSrc(url))
    return () => {
      cancelled = true
    }
  }, [visible, ready, kind, source, path, entry.name, entry.cached, size, mtimeMs])

  if (src) return <img src={src} alt="" loading="lazy" draggable={false} />
  const Icon = entry.isDirectory ? Folder : kind === 'image' ? ImageIcon : kind === 'video' ? Film : kind === 'audio' ? Music : FileIcon
  return (
    <span ref={holder} aria-hidden="true">
      <Icon size={40} strokeWidth={1.5} />
    </span>
  )
}
