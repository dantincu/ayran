import { useCallback, useEffect, useMemo, useState } from 'react'
import { Folder, RefreshCw, Trash2 } from 'lucide-react'
import Modal from '../../components/Modal'
import IconButton from '../../components/IconButton'
import { TagList } from '../../components/Tags'
import { listTags, type TagRecord } from '../../lib/secondaryWindows'
import { confirm } from '../../lib/dialogs'
import {
  customTextLocationTagGuid,
  randomId,
  readCustomTextLocations,
  saveCustomTextLocations,
  type CustomTextLocation,
  type CustomTextLocationMode,
} from './customTextLocations'
import { notebookTitle, type NotebookEntry } from './notebooks'
import { useNotesSources } from './useSources'
import type { DirListing } from './sources'

const parentOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')
const joinPath = (folder: string, name: string) => (folder ? `${folder}/${name}` : name)

const MODE_LABEL: Record<CustomTextLocationMode, string> = {
  both: 'Editor & item names',
  editor: 'Editor only',
  itemName: 'Item names only',
}

/** **Set its custom-text locations…** — the notebook row action that configures what "Insert custom text"
 * (item 2 of the todo, and its own item-1 follow-up for item names) browses: one or more folders, chosen here,
 * *inside the notebook's own source* — never a cross-account pick, unlike `LocationPicker.tsx`'s own root-
 * switcher: a template's own *text* has no path to reference, but the spec's own wording ("inside the current
 * root") is a single, fixed root, not a free choice of any. Every add/remove/edit persists immediately — there
 * is no separate "Save" step, the same immediacy tag editing and picked-root management already have
 * elsewhere.
 *
 * **Each location now has its own "applies to" (editor / item names / both) and its own colored tags** (item
 * 1's follow-up), and **adding is never a one-shot thing** — the browsing sub-view is its own self-contained
 * flow (`browsing`), opened and closed independently of how many locations already exist, so there's nothing
 * left over from a previous add that could block the next one. */
export default function CustomTextLocationsModal({ notebook, onClose }: { notebook: NotebookEntry; onClose: () => void }) {
  const { ready, sourceOf } = useNotesSources()
  // `sourceOf` builds a *fresh* `FileSource` object on every call (`localSource`/`filenSource` aren't cached)
  // — `useMemo` keeps the same reference across renders as long as `sourceOf`/`notebook.sourceId` don't
  // change, which is what a stable dependency for the effects below needs (see the identical fix, and the
  // real stuck-"Loading…" bug it closed, in `NoteViewerScriptModal.tsx`'s own history).
  const source = useMemo(() => sourceOf(notebook.sourceId), [sourceOf, notebook.sourceId])
  const [locations, setLocations] = useState<CustomTextLocation[] | null>(null)
  const [tags, setTags] = useState<TagRecord[]>([])
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [browsing, setBrowsing] = useState(false)
  const [browsePath, setBrowsePath] = useState('')
  const [listing, setListing] = useState<DirListing | null>(null)

  useEffect(() => {
    if (!ready) return
    if (!source) {
      setError("This notebook's place isn't available.")
      return
    }
    readCustomTextLocations(source, notebook).then(setLocations, (e) => setError(e instanceof Error ? e.message : String(e)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready])

  const refreshTags = useCallback(() => {
    if (!locations || locations.length === 0) {
      setTags([])
      return
    }
    listTags(locations.map((l) => customTextLocationTagGuid(l.id))).then(setTags, (e) => setError(String(e)))
  }, [locations])

  useEffect(() => {
    refreshTags()
  }, [refreshTags])

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

  async function persist(next: CustomTextLocation[]) {
    if (!source) return
    setLocations(next)
    try {
      await saveCustomTextLocations(source, notebook, next)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  function addLocation() {
    if (!locations) return
    const normalized = browsePath.replace(/^\/+|\/+$/g, '')
    setBrowsing(false)
    if (locations.some((l) => l.path === normalized)) return
    persist([...locations, { id: randomId(), path: normalized, appliesTo: 'both' }])
  }

  async function removeLocation(location: CustomTextLocation) {
    if (!locations) return
    setError(null)
    // The cache (if this source has one) is wiped before the location itself is removed — asked for directly:
    // "when removing a location, its cache should be wiped." A clear failure still goes ahead with the
    // removal (shown as an error, not something that traps the person into being unable to drop a
    // misconfigured or offline location).
    if (source?.cache) {
      try {
        await source.cache.clear(location.path)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    }
    await persist(locations.filter((l) => l.id !== location.id))
  }

  async function refreshCache(location: CustomTextLocation) {
    if (!source?.cache) return
    setError(null)
    setNotice(null)
    try {
      await source.cache.hardRefresh(location.path)
      setNotice(`Refreshed the cache of /${location.path}.`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  function setMode(location: CustomTextLocation, mode: CustomTextLocationMode) {
    if (!locations) return
    persist(locations.map((l) => (l.id === location.id ? { ...l, appliesTo: mode } : l)))
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
    <Modal title={`"${notebookTitle(notebook)}" — custom-text locations`} onClose={onClose} wide>
      {error && <div className="error-banner">{error}</div>}
      {notice && <div className="status-banner">{notice}</div>}
      <p className="muted">
        Folders inside this notebook's own root whose files (and folders) make up what "Insert custom text" offers — in the editor's own
        three-dots menu, and (for a location set to item names, or both) beside a title field when creating or naming something.
      </p>
      {locations === null ? (
        <p className="muted">Loading…</p>
      ) : locations.length === 0 ? (
        <p className="muted">No locations chosen yet.</p>
      ) : (
        <ul className="window-list">
          {locations.map((location) => (
            <li key={location.id} className="window-item">
              <div className="window-item-row">
                <span className="entry-name window-item-main">
                  <Folder size={15} strokeWidth={2} aria-hidden="true" /> /{location.path}
                </span>
                <select value={location.appliesTo} onChange={(e) => setMode(location, e.target.value as CustomTextLocationMode)} aria-label={`What /${location.path} applies to`}>
                  {(Object.keys(MODE_LABEL) as CustomTextLocationMode[]).map((mode) => (
                    <option key={mode} value={mode}>
                      {MODE_LABEL[mode]}
                    </option>
                  ))}
                </select>
                <span className="row-actions">
                  {source?.cache && <IconButton icon={RefreshCw} label="Refresh its cache" onClick={() => refreshCache(location)} />}
                  <IconButton
                    icon={Trash2}
                    label={`Remove /${location.path}`}
                    onClick={async () => {
                      if (await confirm(`Stop using /${location.path} as a custom-text location?${source?.cache ? ' Its cache is cleared too.' : ''}`)) removeLocation(location)
                    }}
                  />
                </span>
              </div>
              <TagList
                guid={customTextLocationTagGuid(location.id)}
                tags={tags.filter((t) => t.guid === customTextLocationTagGuid(location.id))}
                className="window-item-tags"
                onChanged={refreshTags}
                onError={setError}
                showWhenEmpty
              />
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
          disabled={locations === null}
        >
          Add a location…
        </button>
      </div>
    </Modal>
  )
}
