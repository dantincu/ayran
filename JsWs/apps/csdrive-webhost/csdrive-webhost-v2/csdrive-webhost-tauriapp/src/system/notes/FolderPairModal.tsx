import { useMemo, useState } from 'react'
import { CircleHelp, FolderPlus, X } from 'lucide-react'
import IconButton from '../../components/IconButton'
import Modal from '../../components/Modal'
import { INVALID_NAME_CHARACTERS, keepFile, MAX_PART, nextPairIndex, pairNames, shortNameFrom } from '../../lib/folderPairs'
import { joinRelative } from '../../lib/localFs'
import { namePartFromTitle } from './notebookFile'
import { markdownName, markdownTitle } from './noteModel'
import type { FileSource } from './sources'

/** **Add Folders Pair** in a file manager: makes a pair of sibling folders in the folder shown — a short folder (`001`, or any name the
 * person gives) and beside it the full folder (`<short>-<title>`) holding only a `.keep` (`docs/strategies/folder-pairs-strategy.md`).
 *
 * The title is made into a name part the way a note's title is: the characters a file name can't have are **stripped** (not refused —
 * the hint says which they are), `/` becomes `%`, `%` becomes `%%`, and it is cut to the longest part. The index defaults to the first
 * free one and can be any text a folder can be called. With the box ticked a markdown file is made inside the short folder too, named
 * like a note's markdown and starting with the title as a heading. */
export default function FolderPairModal({
  source,
  folder,
  taken,
  onDone,
  onClose,
}: {
  source: FileSource
  /** The folder the pair is made in. */
  folder: string
  /** The names in it now. */
  taken: string[]
  onDone: (created: string) => void
  onClose: () => void
}) {
  const [title, setTitle] = useState('')
  const suggested = useMemo(() => nextPairIndex(taken), [taken])
  const [shortText, setShortText] = useState(suggested)
  const [withMarkdown, setWithMarkdown] = useState(false)
  const [hint, setHint] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const part = namePartFromTitle(title)
  const short = shortNameFrom(shortText)
  const names = pairNames(short, part)
  const lower = new Set(taken.map((name) => name.toLowerCase()))
  const problem =
    title.trim() === '' ? 'Give the pair a title.'
    : part === '' ? 'Nothing is left of that title once the characters a file name cannot have are stripped.'
    : short === '' ? 'Give the short folder a name.'
    : lower.has(names.short.toLowerCase()) ? `"${names.short}" is already here.`
    : lower.has(names.full.toLowerCase()) ? `"${names.full}" is already here.`
    : null

  async function create() {
    if (problem || busy) return
    setBusy(true)
    setError(null)
    try {
      await source.mkdir(joinRelative(folder, names.short))
      await source.mkdir(joinRelative(folder, names.full))
      const keep = keepFile()
      await source.write(joinRelative(folder, names.full, keep.name), keep.content)
      if (withMarkdown) {
        await source.write(joinRelative(folder, names.short, markdownName(title.trim())), new TextEncoder().encode(`${markdownTitle(title.trim())}\n`))
      }
      onDone(names.short)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <Modal title="Add a folders pair" onClose={onClose} wide>
      <div className="pair-modal">
        <label className="notes-field">
          <span>
            Title{' '}
            <button type="button" className="link-button pair-hint-button" aria-label="Which characters are not allowed in a folder name" title="Which characters are not allowed in a folder name" onClick={() => setHint((h) => !h)}>
              <CircleHelp size={14} aria-hidden="true" />
            </button>
          </span>
          <input
            autoFocus
            data-ua-field="notes.folderPair.title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && create()}
            placeholder="What the pair is for — it becomes the readable half of the full folder's name"
          />
        </label>
        {hint && (
          <div className="status-banner pair-hint">
            A folder name can't contain <code>{INVALID_NAME_CHARACTERS}</code> or control characters — they are <strong>stripped</strong> from the title. A <code>/</code> becomes <code>%</code> and a <code>%</code> becomes <code>%%</code>; the result is cut to {MAX_PART} characters, and the dots and spaces
            Windows drops at the end are removed.
          </div>
        )}
        <label className="notes-field">
          <span>Short folder's name (its index — any name a folder can have)</span>
          <input data-ua-field="notes.folderPair.shortName" value={shortText} onChange={(e) => setShortText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && create()} />
        </label>
        <label className="pair-check">
          <input type="checkbox" checked={withMarkdown} onChange={(e) => setWithMarkdown(e.target.checked)} /> Create a markdown file inside the short folder (as a note has)
        </label>
        <div className="muted pair-preview">
          {problem === null || part !== '' ? (
            <>
              Makes <code>{names.short || '…'}</code> and <code>{part ? names.full : `${names.short || '…'}-…`}</code>
              {' '}(with a <code>{keepFile().name}</code> in it){withMarkdown && part ? (
                <>
                  , and <code>{names.short}/{markdownName(title.trim())}</code>
                </>
              ) : null}
            </>
          ) : null}
        </div>
        {(error ?? (title.trim() !== '' ? problem : null)) && <div className="error-banner">{error ?? problem}</div>}
        <div className="toolbar-actions" style={{ justifyContent: 'flex-end' }}>
          <IconButton icon={FolderPlus} label="Create the pair" onClick={create} disabled={problem !== null || busy} />
          <IconButton icon={X} label="Cancel" onClick={onClose} />
        </div>
      </div>
    </Modal>
  )
}
