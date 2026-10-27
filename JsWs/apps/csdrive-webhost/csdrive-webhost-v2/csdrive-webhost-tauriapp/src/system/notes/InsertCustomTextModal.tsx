import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeftRight, File as FileIcon, Folder, RefreshCw, Search as SearchIcon } from 'lucide-react'
import Modal from '../../components/Modal'
import IconButton from '../../components/IconButton'
import Pagination from '../../components/Pagination'
import { getAppState, setAppState } from '../../lib/appState'
import { kbdItem, useModalListKeyboard } from '../../lib/keyboard'
import { DEFAULT_PAGE_SIZE, getGlobalPageSize, getPagePageSize, setPagePageSize, PAGE_IDS } from '../../lib/listPageSize'
import { offsetOfPage, pageOfOffset, validOffset } from '../../lib/pagedPosition'
import { buildCustomTextHierarchy, filterHierarchyLevel, type HierarchyFile, type HierarchyLevel, type HierarchySource } from '../../lib/customTextHierarchy'
import { parseCustomTextTemplate, renderCustomTextTemplate, templateVariables, type CustomTextVariable } from '../../lib/customTextTemplate'

/** Where the browser's own navigation (its breadcrumb path, its search query, and the files table's own
 * page — as the number of records skipped, never a bare page number, `pagedPosition.ts` — "the current page
 * should be persisted too", the todo's own follow-up once it noticed this modal didn't) is persisted, per
 * `persistKey` (the note/file this modal was opened from). */
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
  offset: number
  // Which of the two lists was showing — found live, while verifying the offset above: the offset alone
  // correctly restored the right *page*, but nothing told a reopened modal which list it belonged to, so it
  // landed back on the folders list and needed a second, manual toggle to actually show it. The existing
  // `effectiveView` fallback already treats an invalid value safely, so this is trusted exactly like
  // `breadcrumb`/`offset` are.
  view: 'folders' | 'files'
}

async function loadBrowseState(persistKey: string): Promise<BrowseState> {
  const all = await getAppState<Record<string, BrowseState>>(BROWSE_STATE_KEY).catch(() => undefined)
  return all?.[persistKey] ?? { breadcrumb: [], query: '', offset: 0, view: 'folders' }
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
  // The files table's own position, as the number of records skipped — never a bare page number, so it
  // still means the same records if the page size changes between saving it and restoring it.
  const [offset, setOffset] = useState(0)
  const [pageSize, setPageSizeState] = useState(DEFAULT_PAGE_SIZE)
  /** Which of the two lists is shown when a level has **both** folders/object-properties and files/string-
   * properties — reported live: with both present, the files/strings had no way to be reached at all (the
   * folder list's own `max-height: 40vh; overflow-y: auto` traps the scroll wheel the moment the folders
   * alone fill it, so there was never a way to scroll the modal body far enough to reach the file table
   * stacked underneath). Fixed by never stacking the two — exactly one is rendered at a time, with a toggle
   * button to switch, rather than trying to patch the scroll-trapping instead. Only matters, and only shows,
   * when a level genuinely has both; a level with just one kind is unaffected and needs no toggle at all. */
  const [view, setView] = useState<'folders' | 'files'>('folders')
  const [filling, setFilling] = useState<{ file: HierarchyFile; identity: string; variables: CustomTextVariable[] } | null>(null)
  // The keyboard's own focus — a global index into whichever list (`effectiveView`) is currently shown, -1
  // meaning nothing yet (the first arrow press then focuses the shown page's first item, same as every other
  // keyboard-navigable list in this app). Navigable the instant the modal opens — the keys are heard on the
  // whole window (`useModalListKeyboard`), so nothing has to be clicked or focused first.
  const [kbdFocus, setKbdFocus] = useState(-1)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    getPagePageSize(PAGE_IDS.notesInsertCustomText, getGlobalPageSize).then(setPageSizeState, () => {})
  }, [])

  /** Every real navigation (not the one-time restore below) goes through these two, so the files table's own
   * position and the keyboard focus always reset together with the place they belonged to — directly, at the
   * point of the change, rather than a reactive effect watching `[breadcrumb, query]`: that would also have
   * to fire, and so reset the just-restored offset right back to 0, the moment the restore effect below sets
   * `breadcrumb`/`query` to what was saved. */
  function goTo(next: string[]) {
    setBreadcrumb(next)
    setOffset(0)
    setKbdFocus(-1)
  }
  function search(next: string) {
    setQuery(next)
    setOffset(0)
    setKbdFocus(-1)
  }
  function toggleView() {
    setView(effectiveView === 'folders' ? 'files' : 'folders')
    setKbdFocus(-1)
  }

  // "when I ... made some changes to the files and folders structure ... reopened ... and saw the old
  // listing" — read closely, there is no cache behind this at all: `buildCustomTextHierarchy` always reads
  // every location fresh (`source.list`/`source.read`, straight to the real filesystem or, for Filen, through
  // its own account-wide cache — a separate, already-documented thing with its own refresh elsewhere), the
  // same for a local root as for a Filen one, and this very effect already re-runs it on every mount, i.e.
  // every time the modal is opened. What there wasn't, until now, is a way to see a change made *while the
  // modal stays open*, short of closing and reopening it — this is that: a plain re-run of the same fetch,
  // on demand, for either kind of location alike (unlike `CustomTextLocationsModal.tsx`'s own per-location
  // "Refresh its cache" button, which only ever does anything for a Filen location).
  const [refreshing, setRefreshing] = useState(false)
  function loadHierarchy(): Promise<HierarchyLevel | null> {
    if (locationPaths.length === 0) {
      const empty: HierarchyLevel = { files: [], folders: [] }
      setRoot(empty)
      return Promise.resolve(empty)
    }
    return buildCustomTextHierarchy(source, locationPaths).then(
      (result) => {
        setRoot(result)
        return result
      },
      (e) => {
        setError(e instanceof Error ? e.message : String(e))
        return null
      },
    )
  }
  async function refresh() {
    setRefreshing(true)
    setError(null)
    const result = await loadHierarchy()
    // A refreshed tree may no longer have the folder being browsed (it, or something above it, was deleted
    // or renamed underneath this modal) — the same "what was saved is never trusted blindly" rule the
    // restore above already follows, falling back to the root rather than showing nothing at all.
    if (result && !levelAt(result, breadcrumb)) goTo([])
    else setKbdFocus(-1)
    setRefreshing(false)
  }

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
      setOffset(validOffset(state.offset) ?? 0)
      // `state.view` is `undefined` for a value saved before this field existed — kept, not just the brand
      // new "nothing saved yet" default, out of the same "what was saved is never trusted blindly" caution.
      setView(state.view === 'files' ? 'files' : 'folders')
      setRestored(true)
    })
  }, [root, restored, persistKey])

  useEffect(() => {
    if (restored) saveBrowseState(persistKey, { breadcrumb, query, offset, view })
  }, [breadcrumb, query, offset, view, restored, persistKey])

  const level = root && levelAt(root, breadcrumb)
  const shown = useMemo(() => (level ? filterHierarchyLevel(level, query) : null), [level, query])
  const hasFolders = !!shown && shown.folders.length > 0
  const hasFiles = !!shown && shown.files.length > 0
  // A level with only one kind just shows that one — the toggle only ever matters, and only ever shows,
  // once a level genuinely has both.
  const effectiveView: 'folders' | 'files' = hasFolders && hasFiles ? view : hasFolders ? 'folders' : 'files'
  const pageCount = Math.max(1, Math.ceil((shown?.files.length ?? 0) / pageSize))
  const currentPage = Math.min(pageOfOffset(offset, pageSize), pageCount - 1)

  // The page shown follows the keyboard focus — found live, missing, while testing Page Down: the files
  // table's own `useModalListKeyboard` call below only ever moves `kbdFocus` itself (the same `focused`-is-a-
  // global-index design `FilesTab.tsx` already uses), it never decides which page is *displayed* — that is
  // always this component's own job, the same as `FilesTab.tsx`'s identical "the page shown follows the
  // focus" effect. Only for the files view: the folders list isn't paginated, so a folder's own index is
  // never off the one page it's always shown on.
  useEffect(() => {
    if (effectiveView === 'files' && kbdFocus >= 0) setOffset(Math.floor(kbdFocus / pageSize) * pageSize)
  }, [kbdFocus, pageSize, effectiveView])

  // Navigable with the keyboard the instant the modal opens (item 1 of the todo): Up/Down/Home/End/Page
  // Up/Page Down/the fast-nav Alt+ combinations from `useModalListKeyboard`, Left up a folder, Right (or
  // Enter, which falls back to `onOpen` when `onActivate` isn't given) into the focused folder, Enter applies
  // the focused file, Ctrl+Enter swaps between the two lists where a level has both, Ctrl+S focuses the
  // search box — all of it still working while that search box has the focus, asked for directly. Called
  // unconditionally, before the early returns below, with safe fallbacks for a level not loaded yet.
  useModalListKeyboard({
    count: effectiveView === 'folders' ? (shown?.folders.length ?? 0) : (shown?.files.length ?? 0),
    focused: kbdFocus,
    setFocused: setKbdFocus,
    pageSize: effectiveView === 'files' ? pageSize : undefined,
    page: effectiveView === 'files' ? currentPage : undefined,
    enabled: !filling && !error && !refreshing && !!shown && locationPaths.length > 0,
    onParent: breadcrumb.length > 0 ? () => goTo(breadcrumb.slice(0, -1)) : undefined,
    onOpen:
      effectiveView === 'folders'
        ? (i) => {
            const folder = shown?.folders[i]
            if (folder) goTo([...breadcrumb, folder.name])
          }
        : undefined,
    onActivate:
      effectiveView === 'files'
        ? (i) => {
            const file = shown?.files[i]
            if (file) openFile(file)
          }
        : undefined,
    onToggleView: hasFolders && hasFiles ? toggleView : undefined,
    onFocusSearch: () => searchRef.current?.focus(),
  })

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

  const shownFiles = shown.files.slice(currentPage * pageSize, (currentPage + 1) * pageSize)

  return (
    <Modal title="Insert custom text" onClose={onClose} wide>
      <div className="breadcrumbs">
        <button type="button" className="link-button" onClick={() => goTo([])}>
          /
        </button>
        {breadcrumb.map((name, i) => (
          <span key={i}>
            <span className="crumb-sep">/</span>
            <button type="button" className="link-button" onClick={() => goTo(breadcrumb.slice(0, i + 1))}>
              {name}
            </button>
          </span>
        ))}
        <IconButton
          icon={RefreshCw}
          label="Refresh — read this folder's files and folders again, without closing this dialog"
          onClick={refresh}
          disabled={refreshing}
          style={{ marginLeft: 'auto' }}
        />
        {hasFolders && hasFiles && (
          <IconButton
            icon={ArrowLeftRight}
            label={effectiveView === 'folders' ? 'Show files instead of folders (Ctrl+Enter)' : 'Show folders instead of files (Ctrl+Enter)'}
            onClick={toggleView}
          />
        )}
      </div>
      {/* No clipboard menu or User Action buttons for this one — asked for directly: a search box over the
       * pieces being browsed has no use for either, unlike the path box in "Add a location…" below, which
       * genuinely does. */}
      <label className="notes-field" data-no-text-menu>
        <span>
          <SearchIcon size={14} aria-hidden="true" /> Search (Ctrl+S)
        </span>
        <input ref={searchRef} value={query} onChange={(e) => search(e.target.value)} placeholder="Name or text" aria-label="Search by name or text" />
      </label>
      {!hasFolders && !hasFiles && <p className="muted">Nothing here.</p>}
      {effectiveView === 'folders' && hasFolders && (
        <ul className="picker-list">
          {shown.folders.map((folder, i) => (
            <li key={`${folder.name}#${i}`} {...kbdItem(kbdFocus, i, setKbdFocus)}>
              <button type="button" className="link-button entry-name" onClick={() => goTo([...breadcrumb, folder.name])}>
                <Folder size={15} strokeWidth={2} aria-hidden="true" /> {folder.name}
              </button>
            </li>
          ))}
        </ul>
      )}
      {effectiveView === 'files' && hasFiles && (
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
                <tr key={`${file.name}#${i}`} {...kbdItem(kbdFocus, currentPage * pageSize + i, setKbdFocus)}>
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
            onPageChange={(p) => setOffset(offsetOfPage(p, pageSize))}
            onPageSizeChange={(size) => {
              setPageSizeState(size)
              setPagePageSize(PAGE_IDS.notesInsertCustomText, size).catch(() => {})
            }}
          />
        </>
      )}
      <div className="dialog-actions">
        <IconButton icon={Folder} label="Up a folder" onClick={() => goTo(breadcrumb.slice(0, -1))} disabled={breadcrumb.length === 0} />
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
