import { useEffect, useMemo, useState } from 'react'
import { File as FileIcon, Folder, Search as SearchIcon } from 'lucide-react'
import Modal from '../../components/Modal'
import IconButton from '../../components/IconButton'
import Pagination from '../../components/Pagination'
import { getAppState, setAppState } from '../../lib/appState'
import { DEFAULT_PAGE_SIZE, getGlobalPageSize, getPagePageSize, setPagePageSize, PAGE_IDS } from '../../lib/listPageSize'
import { buildCustomTextHierarchy, filterHierarchyLevel, type HierarchyFile, type HierarchyLevel, type HierarchySource } from '../../lib/customTextHierarchy'
import { parseCustomTextTemplate, renderCustomTextTemplate, templateVariables, type CustomTextVariable } from '../../lib/customTextTemplate'

/** Where the browser's own navigation (its breadcrumb path, and its search query) is persisted, per
 * `persistKey` (the note/file this modal was opened from — "the state of this... modal should be persisted
 * along with the current page", item 2 of the todo). */
const BROWSE_STATE_KEY = 'notes.customTextBrowse'
/** Where a user variable's own *typed value* is persisted — **not** scoped by `persistKey**: the same custom-
 * text snippet is meant to be inserted from many different notes over time, and the whole point of
 * remembering what was typed into one of its variables is so it isn't retyped the next time that same
 * snippet is used, from *any* page — scoped instead by the snippet's own identity (its breadcrumb path) and
 * the variable's name. A variable marked `:nopersist` in the template never reaches this map at all. */
const VARIABLE_VALUES_KEY = 'notes.customTextVarValues'

interface BrowseState {
  breadcrumb: string[]
  query: string
}

async function loadBrowseState(persistKey: string): Promise<BrowseState> {
  const all = await getAppState<Record<string, BrowseState>>(BROWSE_STATE_KEY).catch(() => undefined)
  return all?.[persistKey] ?? { breadcrumb: [], query: '' }
}

async function saveBrowseState(persistKey: string, state: BrowseState): Promise<void> {
  const all = (await getAppState<Record<string, BrowseState>>(BROWSE_STATE_KEY).catch(() => undefined)) ?? {}
  await setAppState(BROWSE_STATE_KEY, { ...all, [persistKey]: state }).catch(() => {})
}

async function loadVariableValues(fileIdentity: string): Promise<Record<string, string>> {
  const all = await getAppState<Record<string, Record<string, string>>>(VARIABLE_VALUES_KEY).catch(() => undefined)
  return all?.[fileIdentity] ?? {}
}

async function saveVariableValues(fileIdentity: string, values: Record<string, string>): Promise<void> {
  const all = (await getAppState<Record<string, Record<string, string>>>(VARIABLE_VALUES_KEY).catch(() => undefined)) ?? {}
  await setAppState(VARIABLE_VALUES_KEY, { ...all, [fileIdentity]: values }).catch(() => {})
}

/** Walks `root` down `breadcrumb` (a chain of folder names), returning the level found there — or `null`
 * if a name in the chain no longer exists (the hierarchy changed underneath a persisted breadcrumb). */
function levelAt(root: HierarchyLevel, breadcrumb: string[]): HierarchyLevel | null {
  let level = root
  for (const name of breadcrumb) {
    const folder = level.folders.find((f) => f.name === name)
    if (!folder) return null
    level = folder
  }
  return level
}

/** **Insert custom text at the caret** — the second, genuinely new notebook-only action in the three-dots
 * menu (item 2 of the todo). Browses the merged hierarchy (`lib/customTextHierarchy.ts`) of whatever
 * locations the notebook has configured (`customTextLocations.ts`): folders list like anywhere else in the
 * app, files show in a 2-column (name, text) table — clicking a row either inserts its template right away
 * (nothing to fill in) or opens a small form for its user variables first. */
export default function InsertCustomTextModal({
  source,
  locationPaths,
  persistKey,
  onInsert,
  onClose,
}: {
  source: HierarchySource
  locationPaths: string[]
  persistKey: string
  onInsert: (text: string, caretOffset: number | null) => void
  onClose: () => void
}) {
  const [root, setRoot] = useState<HierarchyLevel | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [breadcrumb, setBreadcrumb] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const [restored, setRestored] = useState(false)
  const [filePage, setFilePage] = useState(0)
  const [pageSize, setPageSizeState] = useState(DEFAULT_PAGE_SIZE)
  const [filling, setFilling] = useState<{ file: HierarchyFile; identity: string; variables: CustomTextVariable[] } | null>(null)

  useEffect(() => {
    getPagePageSize(PAGE_IDS.notesInsertCustomText, getGlobalPageSize).then(setPageSizeState, () => {})
  }, [])

  useEffect(() => {
    let alive = true
    if (locationPaths.length === 0) {
      setRoot({ files: [], folders: [] })
      return
    }
    buildCustomTextHierarchy(source, locationPaths).then(
      (result) => alive && setRoot(result),
      (e) => alive && setError(e instanceof Error ? e.message : String(e)),
    )
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Restored once the hierarchy is in — a breadcrumb naming a folder that no longer exists just falls back
  // to the root, rather than being trusted blindly (the same "what was saved is never trusted blindly" rule
  // every other persisted place in this app already follows).
  useEffect(() => {
    if (!root || restored) return
    loadBrowseState(persistKey).then((state) => {
      setBreadcrumb(levelAt(root, state.breadcrumb) ? state.breadcrumb : [])
      setQuery(state.query)
      setRestored(true)
    })
  }, [root, restored, persistKey])

  useEffect(() => {
    if (restored) saveBrowseState(persistKey, { breadcrumb, query })
  }, [breadcrumb, query, restored, persistKey])

  useEffect(() => {
    setFilePage(0)
  }, [breadcrumb, query])

  const level = root && levelAt(root, breadcrumb)
  const shown = useMemo(() => (level ? filterHierarchyLevel(level, query) : null), [level, query])

  function openFile(file: HierarchyFile) {
    const identity = [...breadcrumb, file.name].join('/')
    const tokens = parseCustomTextTemplate(file.content)
    const variables = templateVariables(tokens)
    if (variables.length === 0) {
      const result = renderCustomTextTemplate(tokens, {})
      onInsert(result.text, result.caretOffset)
      return
    }
    setFilling({ file, identity, variables })
  }

  async function confirmInsert(values: Record<string, string>) {
    if (!filling) return
    const tokens = parseCustomTextTemplate(filling.file.content)
    const result = renderCustomTextTemplate(tokens, values)
    const toPersist = Object.fromEntries(filling.variables.filter((v) => v.persist).map((v) => [v.name, values[v.name] ?? '']))
    await saveVariableValues(filling.identity, toPersist)
    onInsert(result.text, result.caretOffset)
  }

  if (error) {
    return (
      <Modal title="Insert custom text" onClose={onClose}>
        <div className="error-banner">{error}</div>
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </Modal>
    )
  }

  if (!root || !shown) return null

  if (locationPaths.length === 0) {
    return (
      <Modal title="Insert custom text" onClose={onClose}>
        <p className="muted">This notebook has no custom-text locations chosen yet (Manage notebooks → this notebook → "Set its custom-text locations…").</p>
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </Modal>
    )
  }

  if (filling) {
    return (
      <VariableFormModal
        heading={filling.file.name}
        variables={filling.variables}
        identity={filling.identity}
        onSubmit={confirmInsert}
        onCancel={() => setFilling(null)}
      />
    )
  }

  const pageCount = Math.max(1, Math.ceil(shown.files.length / pageSize))
  const currentPage = Math.min(filePage, pageCount - 1)
  const shownFiles = shown.files.slice(currentPage * pageSize, (currentPage + 1) * pageSize)

  return (
    <Modal title="Insert custom text" onClose={onClose} wide>
      <div className="breadcrumbs">
        <button type="button" className="link-button" onClick={() => setBreadcrumb([])}>
          /
        </button>
        {breadcrumb.map((name, i) => (
          <span key={i}>
            <span className="crumb-sep">/</span>
            <button type="button" className="link-button" onClick={() => setBreadcrumb(breadcrumb.slice(0, i + 1))}>
              {name}
            </button>
          </span>
        ))}
      </div>
      <label className="notes-field">
        <span>
          <SearchIcon size={14} aria-hidden="true" /> Search
        </span>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Name or text" aria-label="Search by name or text" />
      </label>
      {shown.folders.length === 0 && shown.files.length === 0 && <p className="muted">Nothing here.</p>}
      {shown.folders.length > 0 && (
        <ul className="picker-list">
          {shown.folders.map((folder, i) => (
            <li key={`${folder.name}#${i}`}>
              <button type="button" className="link-button entry-name" onClick={() => setBreadcrumb([...breadcrumb, folder.name])}>
                <Folder size={15} strokeWidth={2} aria-hidden="true" /> {folder.name}
              </button>
            </li>
          ))}
        </ul>
      )}
      {shown.files.length > 0 && (
        <>
          <table className="custom-text-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Text</th>
              </tr>
            </thead>
            <tbody>
              {shownFiles.map((file, i) => (
                <tr key={`${file.name}#${i}`}>
                  <td>
                    <button type="button" className="link-button entry-name" onClick={() => openFile(file)}>
                      <FileIcon size={15} strokeWidth={2} aria-hidden="true" /> {file.name}
                    </button>
                  </td>
                  <td className="muted custom-text-preview">{file.content}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pagination
            page={currentPage}
            pageSize={pageSize}
            totalItems={shown.files.length}
            onPageChange={setFilePage}
            onPageSizeChange={(size) => {
              setPageSizeState(size)
              setPagePageSize(PAGE_IDS.notesInsertCustomText, size).catch(() => {})
            }}
          />
        </>
      )}
      <div className="dialog-actions">
        <IconButton icon={Folder} label="Up a folder" onClick={() => setBreadcrumb(breadcrumb.slice(0, -1))} disabled={breadcrumb.length === 0} />
        <button type="button" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Modal>
  )
}

/** The form for a template's own user variables — one textbox per variable (a `<textarea>` for `multi`line
 * ones, a plain `<input>` otherwise), pre-filled from whatever was persisted for this exact snippet last time
 * (or the template's own default, the first time) — the persisted value is read once, here, rather than
 * threaded in from the caller, since only this component actually needs it. */
function VariableFormModal({
  heading,
  variables,
  identity,
  onSubmit,
  onCancel,
}: {
  heading: string
  variables: CustomTextVariable[]
  identity: string
  onSubmit: (values: Record<string, string>) => void
  onCancel: () => void
}) {
  const [values, setValues] = useState<Record<string, string> | null>(null)

  useEffect(() => {
    let alive = true
    loadVariableValues(identity).then((persisted) => {
      if (!alive) return
      setValues(Object.fromEntries(variables.map((v) => [v.name, persisted[v.name] ?? v.default])))
    })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity])

  if (!values) return null

  return (
    <Modal title={heading} onClose={onCancel}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          onSubmit(values)
        }}
      >
        {variables.map((v) => (
          <label key={v.name} className="notes-field notes-field-leading">
            <span>{v.name}</span>
            {v.multiline ? (
              <textarea rows={4} value={values[v.name] ?? ''} onChange={(e) => setValues({ ...values, [v.name]: e.target.value })} aria-label={v.name} />
            ) : (
              <input value={values[v.name] ?? ''} onChange={(e) => setValues({ ...values, [v.name]: e.target.value })} aria-label={v.name} />
            )}
          </label>
        ))}
        <div className="dialog-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="primary">
            Insert
          </button>
        </div>
      </form>
    </Modal>
  )
}
