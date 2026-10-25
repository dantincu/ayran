import { useEffect, useMemo, useState } from 'react'
import type { FileSource } from './sources'
import NotesApp, { type ScopedPlace } from './NotesApp'
import { ensureNoteFiles, readNote } from './noteModel'
import { reportNotePlace, type Place, type Tab } from './tabs'
import { useNotesSources } from './useSources'

const join = (...parts: string[]) => parts.map((p) => p.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/')

/** The explorer of a note's files: the File Manager, scoped to the note's `01` folder — the pair of folders, made when the note has
 * none, that holds what is uploaded to the note. It is a page of its own, apart from the note's markdown and from its child
 * notes. Every entry can be shown in the File Manager, where it sits among the rest of the source.
 *
 * **Its own current place (path, how far into the listing, and a file open in the editor or the media viewer)
 * is persisted** — the path first, asked for directly ("the note's file explorer's current relative path
 * should also be persisted"), then the rest once that shipped ("now that the current path is persisted, so
 * should the current page, and editing/viewing a media file") — the same way every other place already is,
 * through the tab's own resource id (`tabs.ts`'s own `encodeNotePlace`/`decodePlace` round-trip `offset`/
 * `edit`/`viewing` as `o=`/`e=`/`m=`, mirroring `Location`'s own shape). `offset`/`edit`/`viewing` are this
 * page's own incoming props — where a restored tab, or a tab switched back to, says it was — used only as
 * `NotesApp`'s *initial* place (its `initial` prop, read once at mount by `showLocation`, which already knows
 * how to restore all three regardless of `scope`); from then on, `NotesApp`'s own current scoped place is
 * mirrored back up live via `scope.onPlaceChange`, into `place`, which is what every `reportNotePlace` call
 * after the first actually sends — not the stale incoming props, which never change again once mounted. */
export default function NoteFilesPage({
  tab,
  sourceId,
  folder,
  path,
  offset,
  edit,
  viewing,
  onPlace,
}: {
  tab: Tab | null
  sourceId: string
  folder: string
  path: string
  offset?: number
  edit?: string
  viewing?: string
  onPlace: (place: Place) => void
}) {
  const { ready, sourceOf } = useNotesSources()
  const source: FileSource | null = useMemo(() => sourceOf(sourceId), [sourceOf, sourceId])
  const [title, setTitle] = useState<string | null>(null)
  const [root, setRoot] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [place, setPlace] = useState<ScopedPlace>({ path, ...(offset ? { offset } : {}), ...(edit ? { edit } : {}), ...(viewing ? { viewing } : {}) })

  useEffect(() => {
    if (!ready || !source) return
    let alive = true
    ;(async () => {
      try {
        const note = await readNote(source, folder)
        if (!note) throw new Error('That folder is not a note.')
        const files = await ensureNoteFiles(source, folder)
        if (alive) {
          setTitle(note.title)
          setRoot(files)
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      alive = false
    }
  }, [ready, source, folder])

  useEffect(() => {
    if (tab && title !== null) reportNotePlace(tab, { view: 'noteFiles', sourceId, folder, ...place }, title)
  }, [tab, title, sourceId, folder, place])

  if (!ready) return null
  if (error || !source) {
    return (
      <div className="app-shell">
        <main className="tab-content">
          <div className="tab-panel">
            <div className="error-banner">{error ?? "This note's place isn't available."}</div>
          </div>
        </main>
      </div>
    )
  }
  if (root === null || title === null) return null
  return (
    <NotesApp
      tab={tab}
      initial={{ sourceId, branch: null, path, ...(offset ? { offset } : {}), ...(edit ? { edit } : {}), ...(viewing ? { viewing } : {}) }}
      onHome={() => onPlace({ view: 'notes', sourceId, folder })}
      scope={{
        sourceId,
        root,
        label: `${title} · files`,
        onBack: () => onPlace({ view: 'notes', sourceId, folder }),
        onOpenInFileManager: (atPath) => onPlace({ view: 'files', location: { sourceId, branch: null, path: join(root, atPath) } }),
        onPlaceChange: setPlace,
      }}
    />
  )
}
