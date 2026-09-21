import { useState } from 'react'
import { ArrowDownAZ, ArrowUpZA, Search, X } from 'lucide-react'
import IconButton from '../../components/IconButton'
import { criteriaOf, emptyForm, type SearchCriteria, type SearchForm, type SortKey, type SortSpec } from './search'

/** **The search and sort panel** of the Notes file managers (`kind: 'files'`) and of a list of notes (`kind: 'notes'`).
 *
 * Search by name (a note's title), by contents, by last modified and created time, by size and extension (files), by type, to the depth
 * asked (1 — the folder itself — by default, or no limit); each text can be a regular expression, and a regular expression on the
 * contents is applied line by line or to the whole contents. Time stamps and sizes are **intervals** whose either edge may be left
 * empty (infinity). **Sorting** — by name, extension, times or size, ascending or descending, folders first or not — takes effect at
 * once on the listing; **Search** runs the search and shows its results (grouped by folder, each with where it is) until **Clear**. */
export default function SearchPanel({
  kind,
  sort,
  onSort,
  searching,
  onSearch,
  onClear,
}: {
  kind: 'files' | 'notes'
  sort: SortSpec
  onSort: (sort: SortSpec) => void
  /** Results are showing. */
  searching: boolean
  onSearch: (criteria: SearchCriteria) => void
  onClear: () => void
}) {
  const [form, setForm] = useState<SearchForm>(emptyForm())
  const [problems, setProblems] = useState<string[]>([])
  const files = kind === 'files'
  const set = <K extends keyof SearchForm>(key: K, value: SearchForm[K]) => setForm((f) => ({ ...f, [key]: value }))

  function run() {
    const { criteria, problems: found } = criteriaOf(form)
    setProblems(found)
    if (found.length === 0) onSearch(criteria)
  }

  const check = (label: string, key: 'nameRegex' | 'nameCase' | 'extRegex' | 'contentRegex' | 'contentCase', title?: string) => (
    <label className="search-check" title={title}>
      <input type="checkbox" checked={form[key]} onChange={(e) => set(key, e.target.checked)} /> {label}
    </label>
  )

  const keys: Array<[SortKey, string]> = files
    ? [['default', 'As listed (folders first, by name)'], ['name', 'Name'], ['extension', 'Extension'], ['modified', 'Last modified'], ['created', 'Created'], ['size', 'Size']]
    : [['default', 'Index'], ['name', 'Title'], ['modified', 'Last updated'], ['created', 'Created']]

  return (
    <div className="search-panel" onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT' && (e.target as HTMLInputElement).type !== 'checkbox' && run()}>
      <div className="search-grid">
        <fieldset>
          <legend>{files ? 'Name' : 'Title'}</legend>
          <input value={form.nameText} onChange={(e) => set('nameText', e.target.value)} placeholder={files ? 'Part of a file or folder name' : 'Part of a title'} />
          <div className="search-options">
            {check('Regular expression', 'nameRegex')}
            {check('Match case', 'nameCase')}
          </div>
        </fieldset>

        <fieldset>
          <legend>Contents</legend>
          <input value={form.contentText} onChange={(e) => set('contentText', e.target.value)} placeholder={files ? 'Text inside the files' : 'Text inside the notes'} />
          <div className="search-options">
            {check('Regular expression', 'contentRegex')}
            {check('Match case', 'contentCase')}
            {form.contentRegex && (
              <select value={form.contentMode} onChange={(e) => set('contentMode', e.target.value as SearchForm['contentMode'])} aria-label="Apply the expression">
                <option value="lines">line by line</option>
                <option value="whole">to the whole contents</option>
              </select>
            )}
          </div>
          <div className="muted search-note">Text files up to 10 MB; larger and binary files are not searched.</div>
        </fieldset>

        {files && (
          <fieldset>
            <legend>Extension</legend>
            <input value={form.extText} onChange={(e) => set('extText', e.target.value)} placeholder="jpg, png — or a regular expression" />
            <div className="search-options">{check('Regular expression', 'extRegex')}</div>
          </fieldset>
        )}

        <fieldset>
          <legend>Last {files ? 'modified' : 'updated'}</legend>
          <label className="search-range">
            from <input type="datetime-local" value={form.modFrom} onChange={(e) => set('modFrom', e.target.value)} />
          </label>
          <label className="search-range">
            to <input type="datetime-local" value={form.modTo} onChange={(e) => set('modTo', e.target.value)} />
          </label>
        </fieldset>

        <fieldset>
          <legend>Created</legend>
          <label className="search-range">
            from <input type="datetime-local" value={form.creFrom} onChange={(e) => set('creFrom', e.target.value)} />
          </label>
          <label className="search-range">
            to <input type="datetime-local" value={form.creTo} onChange={(e) => set('creTo', e.target.value)} />
          </label>
          {files && <div className="muted search-note">A Filen file has no creation time; a folder of this device may not keep one either.</div>}
        </fieldset>

        {files && (
          <fieldset>
            <legend>Size (files)</legend>
            <label className="search-range">
              from <input inputMode="decimal" value={form.sizeFrom} onChange={(e) => set('sizeFrom', e.target.value)} placeholder="no minimum" />
            </label>
            <label className="search-range">
              to <input inputMode="decimal" value={form.sizeTo} onChange={(e) => set('sizeTo', e.target.value)} placeholder="no maximum" />
            </label>
            <select value={form.sizeUnit} onChange={(e) => set('sizeUnit', e.target.value as SearchForm['sizeUnit'])} aria-label="Unit">
              <option value="B">bytes</option>
              <option value="KB">KB</option>
              <option value="MB">MB</option>
              <option value="GB">GB</option>
            </select>
          </fieldset>
        )}

        <fieldset>
          <legend>Where</legend>
          {files && (
            <select value={form.kind} onChange={(e) => set('kind', e.target.value as SearchForm['kind'])} aria-label="Files or folders">
              <option value="any">Files and folders</option>
              <option value="files">Files only</option>
              <option value="folders">Folders only</option>
            </select>
          )}
          <label className="search-range">
            Depth{' '}
            <input type="number" min={1} value={form.depthText} disabled={form.unlimited} onChange={(e) => set('depthText', e.target.value)} />
          </label>
          <label className="search-check">
            <input type="checkbox" checked={form.unlimited} onChange={(e) => set('unlimited', e.target.checked)} /> No limit
          </label>
          <div className="muted search-note">1 is this folder only.</div>
        </fieldset>

        <fieldset>
          <legend>Sort</legend>
          <select value={sort.key} onChange={(e) => onSort({ ...sort, key: e.target.value as SortKey })} aria-label="Sort by">
            {keys.map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
          <div className="search-options">
            <IconButton
              icon={sort.descending ? ArrowUpZA : ArrowDownAZ}
              label={sort.descending ? 'Descending — press for ascending' : 'Ascending — press for descending'}
              onClick={() => onSort({ ...sort, descending: !sort.descending })}
            />
            {files && (
              <label className="search-check">
                <input type="checkbox" checked={sort.foldersFirst} onChange={(e) => onSort({ ...sort, foldersFirst: e.target.checked })} /> Folders first
              </label>
            )}
          </div>
          <div className="muted search-note">In a search, each folder's results are sorted (a deep search is grouped by folder).</div>
        </fieldset>
      </div>

      {problems.length > 0 && <div className="error-banner">{problems.map((p) => <div key={p}>{p}</div>)}</div>}
      <div className="toolbar-actions">
        <IconButton icon={Search} label="Search" onClick={run} />
        <IconButton
          icon={X}
          label={searching ? 'Clear the search' : 'Clear the fields'}
          onClick={() => {
            setForm(emptyForm())
            setProblems([])
            onClear()
          }}
        />
      </div>
    </div>
  )
}
