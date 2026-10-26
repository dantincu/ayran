import { useEffect, useMemo, useState } from 'react'
import { Folder, Trash2 } from 'lucide-react'
import Modal from '../../components/Modal'
import IconButton from '../../components/IconButton'
import { readCustomTextLocations, saveCustomTextLocations } from './customTextLocations'
import { notebookTitle, type NotebookEntry } from './notebooks'
import { useNotesSources } from './useSources'
import type { DirListing } from './sources'

const parentOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')
const joinPath = (folder: string, name: string) => (folder ? `${folder}/${name}` : name)

/** **Set its custom-text locations…** — the notebook row action that configures what "Insert custom text at
 * the caret" (item 2 of the todo) browses: one or more folders, chosen here, *inside the notebook's own
 * source* ("locations inside the current root," read as "this notebook's own root," the same source a
 * folder-as-notebook or a listed one's own root already means elsewhere in this app — never a cross-account
 * pick, unlike `LocationPicker.tsx`'s own root-switcher, which this deliberately doesn't reuse: a template's
 * own *text* has no path to reference, so there's no technical reason to restrict sources the way "Insert a
 * path…"/the image-from-clipboard picker do, but the spec's own wording ("inside the current root") is a
 * single, fixed root, not a free choice of any). Every add/remove persists immediately — there is no
 * separate "Save" step, the same immediacy tag editing and picked-root management already have elsewhere. */
export default function CustomTextLocationsModal({ notebook, onClose }: { notebook: NotebookEntry; onClose: () => void }) {
  const { ready, sourceOf } = useNotesSources()
  // A real bug, found live: `sourceOf` builds a *fresh* `FileSource` object on every call (`localSource`/
  // `filenSource` aren't cached), so calling it directly in the render body gave `source` a new identity on
  // every render — the browse effect below depends on it, so it never stopped re-firing: each run called
  // `setListing(null)`, which (being a new state value after the browse had just resolved) re-rendered the
  // component, which recomputed a new `source`, which re-triggered the effect, forever — the browser only
  // ever caught the fleeting instants of "real listing just landed" before the loop reset it, which is why
  // this looked, live, like a permanently stuck "Loading…" rather than a flicker. `useMemo` keeps the same
  // `source` reference across renders as long as `sourceOf`/`notebook.sourceId` themselves don't change.
  const source = useMemo(() => sourceOf(notebook.sourceId), [sourceOf, notebook.sourceId])
  const [paths, setPaths] = useState<string[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [browsing, setBrowsing] = useState(false)
  const [browsePath, setBrowsePath] = useState('')
  const [listing, setListing] = useState<DirListing | null>(null)

  useEffect(() => {
    if (!ready) return
    if (!source) {
      setError("This notebook's place isn't available.")
      return
    }
    readCustomTextLocations(source, notebook).then(setPaths, (e) => setError(e instanceof Error ? e.message : String(e)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready])

  useEffect(() => {
    if (!browsing || !source) return
    let alive = true
    setListing(null)
    source.list(browsePath).then(
      (result) => alive && setListing(result),
      (e) => alive && setError(e instanceof Error ? e.message : String(e)),
    )
    return () => {
      alive = false
    }
  }, [source, browsePath, browsing])

  async function save(next: string[]) {
    if (!source) return
    setPaths(next)
    try {
      await saveCustomTextLocations(source, notebook, next)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  function addLocation() {
    if (!paths) return
    const normalized = browsePath.replace(/^\/+|\/+$/g, '')
    if (!paths.includes(normalized)) save([...paths, normalized])
    setBrowsing(false)
  }

  if (browsing) {
    const segments = browsePath ? browsePath.split('/') : []
    return (
      <Modal title="Choose a folder" onClose={() => setBrowsing(false)}>
        {error && <div className="error-banner">{error}</div>}
        <div className="breadcrumbs">
          <button type="button" className="link-button" onClick={() => setBrowsePath('')}>
            /
          </button>
          {segments.map((segment, i) => (
            <span key={i}>
              <span className="crumb-sep">/</span>
              <button type="button" className="link-button" onClick={() => setBrowsePath(segments.slice(0, i + 1).join('/'))}>
                {segment}
              </button>
            </span>
          ))}
        </div>
        <ul className="picker-list">
          {listing === null && <li className="muted">Loading…</li>}
          {listing?.entries.filter((e) => e.isDirectory).length === 0 && <li className="muted">No subfolders here.</li>}
          {listing?.entries
            .filter((e) => e.isDirectory)
            .map((entry) => (
              <li key={entry.name}>
                <button type="button" className="link-button entry-name" onClick={() => setBrowsePath(joinPath(browsePath, entry.name))}>
                  <Folder size={15} strokeWidth={2} aria-hidden="true" /> {entry.name}
                </button>
              </li>
            ))}
        </ul>
        <div className="dialog-actions">
          <IconButton icon={Folder} label="Up a folder" onClick={() => setBrowsePath(parentOf(browsePath))} disabled={!browsePath} />
          <button type="button" onClick={() => setBrowsing(false)}>
            Cancel
          </button>
          <button type="button" className="primary" onClick={addLocation}>
            Add this folder
          </button>
        </div>
      </Modal>
    )
  }

  return (
    <Modal title={`"${notebookTitle(notebook)}" — custom-text locations`} onClose={onClose}>
      {error && <div className="error-banner">{error}</div>}
      <p className="muted">
        Folders inside this notebook's own root whose files (and folders) make up what "Insert custom text at the caret" offers — see the
        editor's own three-dots menu for any file in this notebook.
      </p>
      {paths === null ? (
        <p className="muted">Loading…</p>
      ) : paths.length === 0 ? (
        <p className="muted">No locations chosen yet.</p>
      ) : (
        <ul className="picker-list">
          {paths.map((path) => (
            <li key={path}>
              <span className="entry-name">
                <Folder size={15} strokeWidth={2} aria-hidden="true" /> /{path}
              </span>
              <IconButton icon={Trash2} label={`Remove /${path}`} onClick={() => save(paths.filter((p) => p !== path))} />
            </li>
          ))}
        </ul>
      )}
      <div className="dialog-actions">
        <button type="button" onClick={onClose}>
          Close
        </button>
        <button
          type="button"
          className="primary"
          onClick={() => {
            setBrowsePath('')
            setBrowsing(true)
          }}
          disabled={paths === null}
        >
          Add a location…
        </button>
      </div>
    </Modal>
  )
}
