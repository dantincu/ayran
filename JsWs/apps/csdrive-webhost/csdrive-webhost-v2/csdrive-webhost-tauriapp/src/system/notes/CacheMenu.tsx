import { useState } from 'react'
import { DatabaseZap, Eraser, RefreshCw, RotateCw } from 'lucide-react'
import ContextMenu, { type MenuItem } from '../../components/ContextMenu'
import IconButton from '../../components/IconButton'
import type { FileSource } from './sources'

/** **The cache options of one item** — a file, a folder, a note, a notebook — wherever the Notes app shows it: in a list, in a card
 * of the thumbnails, in a search result, in an editor, in the media viewer. They are offered for what has a cache (a Filen account's
 * files: `FileSource.cache`), like the lock is.
 *
 * - **Soft refresh** — show it again from the cache: what is cached is used while it is still valid, and fetched when it has expired.
 * - **Hard refresh** — fetch it again from Filen and replace what the cache holds of it (a folder: its listing, and what is below it
 *   is looked at again when opened). *Not allowed for a file that is being edited*, nor for a file locked against caching.
 * - **Clear its cache** — throw away what the cache holds of it (its content, its listing, its thumbnails); it is fetched again when
 *   it is needed. A file locked against caching keeps its frozen copy. */
export interface CacheTarget {
  source: FileSource | null | undefined
  /** The item, relative to the source's root. */
  path: string
  isDirectory: boolean
  /** The item is open in an editor: `dirty` when it has changes that are not saved — a soft refresh would lose them. */
  editing?: 'open' | 'dirty' | null
  /** The cache was dealt with: show the item again (a list lists again, a viewer loads again…). */
  onDone: (kind: 'soft' | 'hard' | 'clear') => void | Promise<void>
  onError: (message: string) => void
  /** Says what was done (optional). */
  onNotice?: (message: string) => void
}

const DONE = { soft: 'Shown again from the cache.', hard: 'Fetched again from Filen.', clear: 'Its cache was cleared.' } as const

async function run(target: CacheTarget, kind: 'soft' | 'hard' | 'clear'): Promise<void> {
  const cache = target.source?.cache
  if (!cache) return
  try {
    if (kind === 'hard') await cache.hardRefresh(target.path)
    else if (kind === 'clear') await cache.clear(target.path)
    await target.onDone(kind)
    target.onNotice?.(DONE[kind])
  } catch (e) {
    target.onError(String(e))
  }
}

/** The three actions as the entries of a context menu (none when the item has no cache); `appended`: they follow other entries, and are set apart by a line. */
export function cacheMenuItems(target: CacheTarget, appended = false): MenuItem[] {
  if (!target.source?.cache) return []
  const dirty = target.editing === 'dirty'
  const editing = !!target.editing
  return [
    {
      label: dirty ? 'Soft refresh — not while it has unsaved changes' : 'Soft refresh — show it again from the cache',
      icon: RefreshCw,
      disabled: dirty,
      separated: appended,
      onSelect: () => void run(target, 'soft'),
    },
    {
      label: editing ? 'Hard refresh — not while it is being edited' : 'Hard refresh — fetch it again from Filen',
      icon: RotateCw,
      disabled: editing,
      onSelect: () => void run(target, 'hard'),
    },
    { label: 'Clear its cache', icon: Eraser, onSelect: () => void run(target, 'clear') },
  ]
}

/** The button that opens the three actions. Renders nothing for an item that has no cache. */
export default function CacheMenu(target: CacheTarget & { size?: number }) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null)
  if (!target.source?.cache) return null
  return (
    <>
      <IconButton
        icon={DatabaseZap}
        size={target.size}
        label="Cache — soft refresh, hard refresh, clear"
        onClick={(e) => {
          const box = e.currentTarget.getBoundingClientRect()
          setAt({ x: box.left, y: box.bottom + 4 })
        }}
      />
      {at && <ContextMenu items={cacheMenuItems(target)} x={at.x} y={at.y} onClose={() => setAt(null)} />}
    </>
  )
}
