import type { ReactNode } from 'react'
import { AppWindow, ChevronLeft, ChevronRight, File as FileIcon, FilePenLine, Folder, FolderOpen, FolderTree, Loader } from 'lucide-react'
import IconButton from '../../components/IconButton'
import { formatBytes } from '../../lib/format'
import { searchFiles, searchNotes, MAX_CONTENT_BYTES, type FileHit, type NoteHit, type SearchCriteria, type SortSpec } from './search'
import type { FileSource } from './sources'
import CacheMenu from './CacheMenu'
import { useResultPager, type PagedResults } from './useResultPager'

const formatWhen = (ms: number | null | undefined) => (ms === null || ms === undefined ? '' : new Date(ms).toLocaleString())

/** The status line and the page buttons of a search that is pulled a page at a time: how many were found so far (the total once the
 * whole tree was looked at), what it is looking at, and what could not be searched. */
function Shell<T>({ results, pageSize, children }: { results: PagedResults<T>; pageSize: number; children: ReactNode }) {
  const { page, known, done, searching, stats, hasNext } = results
  const first = known === 0 ? 0 : page * pageSize + 1
  const last = page * pageSize + results.items.length
  return (
    <div className="search-results">
      <div className="muted search-status">
        {searching ? <Loader size={13} className="spin" aria-hidden="true" /> : null}{' '}
        {done ? `${known} result${known === 1 ? '' : 's'}` : `${known} found so far`}
        {searching ? ' — searching…' : done ? '' : ' — more may follow'} · looked in {stats.folders} folder{stats.folders === 1 ? '' : 's'}
        {stats.skipped > 0 && ` · ${stats.skipped} not searched (over ${formatBytes(MAX_CONTENT_BYTES)} or not text)`}
        {stats.failed > 0 && ` · ${stats.failed} could not be read`}
      </div>
      {results.error && <div className="error-banner">{results.error}</div>}
      {known === 0 && done && !searching && <div className="muted">Nothing found.</div>}
      {children}
      {(page > 0 || hasNext) && (
        <div className="pagination">
          <span className="muted">{known > 0 ? `${first}–${last}${done ? ` of ${known}` : ''}` : ''}</span>
          <div className="pagination-controls">
            <IconButton icon={ChevronLeft} label="Previous page" onClick={results.previous} disabled={page === 0 || searching} />
            <span className="pagination-page">{page + 1}</span>
            <IconButton icon={ChevronRight} label="Next page" onClick={results.next} disabled={!hasNext || searching} />
          </div>
        </div>
      )}
    </div>
  )
}

/** The results of a search of **files and folders**: a table like the listing's — each result with the folder it is in (its
 * ancestors), and, when the contents were searched, the line that matched. */
export function FileSearchResults({
  source,
  folder,
  criteria,
  sort,
  pageSize,
  onOpen,
  onShow,
  onError,
  onNotice,
}: {
  /** What the cache options of a result say when they fail or are done. */
  onError?: (message: string) => void
  onNotice?: (message: string) => void
  source: FileSource
  /** Where the search started. */
  folder: string
  criteria: SearchCriteria
  sort: SortSpec
  pageSize: number
  onOpen: (hit: FileHit) => void
  /** Show the result in its own folder. */
  onShow: (hit: FileHit) => void
}) {
  const results = useResultPager<FileHit>((ctx) => searchFiles(source, folder, criteria, sort, ctx), pageSize, [source, folder, criteria, sort])
  return (
    <Shell results={results} pageSize={pageSize}>
      {results.items.length > 0 && (
        <table className="file-table search-table">
          <thead>
            <tr>
              <th>Name and where it is</th>
              <th>Size</th>
              <th>Modified</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {results.items.map((hit) => (
              <tr key={hit.path}>
                <td>
                  <button className="link-button entry-name" onClick={() => onOpen(hit)}>
                    {hit.entry.isDirectory ? <Folder size={15} strokeWidth={2} aria-hidden="true" /> : <FileIcon size={15} strokeWidth={2} aria-hidden="true" />} {hit.entry.name}
                  </button>
                  <div className="muted search-where" title="The folder it is in">
                    {hit.folder === '' ? '/' : `/${hit.folder}`}
                  </div>
                  {hit.match && (
                    <div className="search-snippet">
                      <span className="muted">line {hit.match.line}:</span> {hit.match.snippet}
                    </div>
                  )}
                </td>
                <td className="muted">{!hit.entry.isDirectory && hit.entry.size !== null ? formatBytes(hit.entry.size) : ''}</td>
                <td className="muted">{formatWhen(hit.entry.mtimeMs)}</td>
                <td className="row-actions">
                  <CacheMenu source={source} path={hit.path} isDirectory={hit.entry.isDirectory} onDone={() => {}} onError={(m) => onError?.(m)} onNotice={(m) => onNotice?.(m)} />
                  <IconButton icon={FolderOpen} label="Show it in its folder" onClick={() => onShow(hit)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Shell>
  )
}

/** The results of a search of **notes**: each with its index, its title and — where it is — the titles of the notes above it. */
export function NoteSearchResults({
  source,
  folder,
  criteria,
  sort,
  pageSize,
  showIndexes,
  onOpen,
  onEdit,
  onChildren,
  onShow,
  onError,
  onNotice,
}: {
  onError?: (message: string) => void
  onNotice?: (message: string) => void
  source: FileSource
  folder: string
  criteria: SearchCriteria
  sort: SortSpec
  pageSize: number
  showIndexes: boolean
  onOpen: (hit: NoteHit) => void
  onEdit: (hit: NoteHit) => void
  onChildren: (hit: NoteHit) => void
  /** Show the note among its siblings (the page of its parent). */
  onShow: (hit: NoteHit) => void
}) {
  const results = useResultPager<NoteHit>((ctx) => searchNotes(source, folder, criteria, sort, ctx), pageSize, [source, folder, criteria, sort])
  return (
    <Shell results={results} pageSize={pageSize}>
      {results.items.length > 0 && (
        <table className="file-table search-table">
          <tbody>
            {results.items.map((hit) => (
              <tr key={hit.note.folder} className="note-row">
                <td>
                  <div className="note-title-line">
                    {showIndexes && <span className="note-index">{hit.note.index}</span>}
                    <button className="link-button entry-name" onClick={() => onOpen(hit)} title="Open it as a web app, in a tab of this window">
                      {hit.note.title}
                    </button>
                  </div>
                  {hit.trail.length > 0 && (
                    <div className="muted search-where" title="The notes above it">
                      {hit.trail.join(' › ')}
                    </div>
                  )}
                  {hit.match && (
                    <div className="search-snippet">
                      <span className="muted">line {hit.match.line}:</span> {hit.match.snippet}
                    </div>
                  )}
                  <div className="muted notebook-where">{formatWhen(Date.parse(hit.note.updatedAt ?? hit.note.createdAt))}</div>
                </td>
                <td className="row-actions">
                  <IconButton icon={AppWindow} label="Open it as a web app (in a tab of this window)" onClick={() => onOpen(hit)} />
                  <IconButton icon={FilePenLine} label="Edit its markdown" onClick={() => onEdit(hit)} />
                  <IconButton icon={FolderTree} label="Its child notes" onClick={() => onChildren(hit)} />
                  <CacheMenu source={source} path={hit.note.folder} isDirectory onDone={() => {}} onError={(m) => onError?.(m)} onNotice={(m) => onNotice?.(m)} />
                  <IconButton icon={FolderOpen} label="Show it among the notes next to it" onClick={() => onShow(hit)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Shell>
  )
}
