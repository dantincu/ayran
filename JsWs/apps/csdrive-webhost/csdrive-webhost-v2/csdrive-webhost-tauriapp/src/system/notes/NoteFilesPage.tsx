import { useEffect, useMemo, useState } from 'react'
import type { FileSource } from './sources'
import NotesApp from './NotesApp'
import { ensureNoteFiles, readNote } from './noteModel'
import { reportNotePlace, type Place, type Tab } from './tabs'
import { useNotesSources } from './useSources'

const join = (...parts: string[]) => parts.map((p) => p.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/')

/** The explorer of a note's files: the File Manager, scoped to the note's `01` folder — the pair of folders, made when the note has
 * none, that holds what is uploaded to the note. It is a page of its own, apart from the note's markdown and from its child
 * notes. Every entry can be shown in the File Manager, where it sits among the rest of the source. */
export default function NoteFilesPage({
  tab,
  sourceId,
  folder,
  onPlace,
}: {
  tab: Tab | null
  sourceId: string
  folder: string
  onPlace: (place: Place) => void
}) {
  const { ready, sourceOf } = useNotesSources()
  const source: FileSource | null = useMemo(() => sourceOf(sourceId), [sourceOf, sourceId])
  const [title, setTitle] = useState<string | null>(null)
  const [root, setRoot] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

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
    if (tab && title !== null) reportNotePlace(tab, { view: 'noteFiles', sourceId, folder, path: '' }, title)
  }, [tab, title, sourceId, folder])

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
      initial={{ sourceId, branch: null, path: '' }}
      onHome={() => onPlace({ view: 'notes', sourceId, folder })}
      scope={{
        sourceId,
        root,
        label: `${title} · files`,
        onBack: () => onPlace({ view: 'notes', sourceId, folder }),
        onOpenInFileManager: (path) => onPlace({ view: 'files', location: { sourceId, branch: null, path: join(root, path) } }),
      }}
    />
  )
}
