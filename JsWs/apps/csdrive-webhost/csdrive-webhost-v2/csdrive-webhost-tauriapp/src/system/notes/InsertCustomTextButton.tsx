import { useEffect, useState } from 'react'
import type { RefObject } from 'react'
import { Braces } from 'lucide-react'
import IconButton from '../../components/IconButton'
import InsertCustomTextModal from './InsertCustomTextModal'
import { loadNotebooks, type NotebookEntry } from './notebooks'
import { notebookContaining } from './userAction'
import { pathsForMode, readCustomTextLocations } from './customTextLocations'
import type { FileSource } from './sources'

/** **Insert custom text** for a plain *item-name* field (a note's/folder pair's own title, today) — the same
 * mechanism "Insert custom text at the caret" already gives an editor, offered here too (item 1 of the todo:
 * "let's also make that option available for when typing the item name... the set of locations will be the
 * same in both cases"). Self-contained, the same way `UserActionButton` is: given where it is (`sourceId`/
 * `folder`), it finds its own notebook (or renders nothing — there's no "item name" location concept outside
 * one, same as the editor's own menu), reads that notebook's locations fresh every time it's opened (cheap —
 * one small json file), and filters them to the ones whose own "applies to" is `itemName` or `both` before
 * building the browsable hierarchy (`pathsForMode`).
 *
 * Unlike the editor, there is no `CodeEditorHandle` to splice text into — just a plain, single-line
 * `<input>` the caller already owns the `value`/`onChange` of. `inputRef` is read for the field's own current
 * selection (so the inserted text replaces whatever was selected, or lands at the caret, exactly like typing
 * it would) and is given the focus — and the new caret position — back once the text lands. */
export default function InsertCustomTextButton({
  source,
  sourceId,
  folder,
  inputRef,
  value,
  onChange,
}: {
  source: FileSource
  sourceId: string
  folder: string
  inputRef: RefObject<HTMLInputElement | null>
  value: string
  onChange: (next: string) => void
}) {
  const [notebook, setNotebook] = useState<NotebookEntry | null>(null)
  const [open, setOpen] = useState(false)
  const [locationPaths, setLocationPaths] = useState<string[] | null>(null)

  useEffect(() => {
    let cancelled = false
    loadNotebooks().then(
      (list) => !cancelled && setNotebook(notebookContaining(list, sourceId, folder)),
      () => !cancelled && setNotebook(null),
    )
    return () => {
      cancelled = true
    }
  }, [sourceId, folder])

  if (!notebook) return null

  function openPicker() {
    setLocationPaths(null)
    setOpen(true)
    readCustomTextLocations(source, notebook!).then(
      (locations) => setLocationPaths(pathsForMode(locations, 'itemName', notebook!.folder)),
      () => setLocationPaths([]),
    )
  }

  function insert(text: string, caretOffset: number | null) {
    const el = inputRef.current
    const start = el?.selectionStart ?? value.length
    const end = el?.selectionEnd ?? value.length
    onChange(value.slice(0, start) + text + value.slice(end))
    setOpen(false)
    // The field's own content hasn't re-rendered with the new value yet at this point (`onChange` only just
    // queued it) — placing the caret has to wait for that commit, the same reason every other "insert, then
    // put the caret inside what was inserted" path in this app defers to the next frame.
    requestAnimationFrame(() => {
      const target = inputRef.current
      if (!target) return
      const pos = start + (caretOffset ?? text.length)
      target.focus()
      target.setSelectionRange(pos, pos)
    })
  }

  return (
    <>
      <IconButton icon={Braces} label="Insert custom text here…" onClick={openPicker} />
      {open && locationPaths !== null && (
        <InsertCustomTextModal source={source} locationPaths={locationPaths} persistKey={`itemName|${sourceId}|${folder}`} onInsert={insert} onClose={() => setOpen(false)} />
      )}
    </>
  )
}
