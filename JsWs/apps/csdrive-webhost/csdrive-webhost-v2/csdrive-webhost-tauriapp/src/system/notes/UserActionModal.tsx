import { useCallback, useEffect, useState } from 'react'
import { Info, RotateCcw, Settings2 } from 'lucide-react'
import IconButton from '../../components/IconButton'
import Modal from '../../components/Modal'
import LocationPicker, { type Picked } from './LocationPicker'
import {
  pageHere,
  resetNotebookPage,
  saveGlobalPage,
  saveNotebookPage,
  type UserActionPage,
  type UserActionScope,
} from './userAction'
import { useNotesSources } from './useSources'
import { NOTEBOOK_INTERNALS_INDEX } from './noteModel'
import { USER_ACTION_JSON } from '../../lib/appConfig'

/** The dialog that **chooses the page** of the User Action (right click or long press on its button, or the button when no page was chosen
 * yet): the page that is set for the place being shown — its notebook's, or the app's outside every notebook (see `userAction.ts`) — with
 * the buttons to choose or change it, to forget it and to have it explained. The page itself is not shown here: it is launched in a window
 * of its own (`UserActionButton.tsx`). */
export default function UserActionModal({ onClose }: { onClose: () => void }) {
  const { roots, accounts, ready, addRoot, sourceOf } = useNotesSources()
  const [scope, setScope] = useState<UserActionScope | null>(null)
  const [page, setPage] = useState<UserActionPage | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [choosing, setChoosing] = useState(false)
  const [explaining, setExplaining] = useState(false)

  // Which setting this is — the notebook the place is in, else the app's — and what it says.
  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const here = await pageHere()
      setScope(here.scope)
      setPage(here.page)
    } catch (e) {
      setPage(null)
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function choose(picked: Picked) {
    setChoosing(false)
    if (!picked.fileName || !scope) return
    const next: UserActionPage = { sourceId: picked.source.id, path: [picked.folder, picked.fileName].filter(Boolean).join('/') }
    try {
      if (scope.kind === 'notebook') {
        const source = sourceOf(scope.notebook.sourceId)
        if (!source) throw new Error("This notebook's place isn't available.")
        await saveNotebookPage(source, scope.notebook, next)
      } else {
        await saveGlobalPage(next)
      }
      setError(null)
      setPage(next)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function reset() {
    if (!scope) return
    try {
      if (scope.kind === 'notebook') {
        const source = sourceOf(scope.notebook.sourceId)
        if (!source) throw new Error("This notebook's place isn't available.")
        await resetNotebookPage(source, scope.notebook)
      } else {
        await saveGlobalPage(null)
      }
      setError(null)
      setPage(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const where = scope === null ? '' : scope.kind === 'notebook' ? `The notebook “${scope.notebook.title}”` : 'The Notes app (outside any notebook)'
  const shown = page ? `${sourceOf(page.sourceId)?.label ?? page.sourceId} · /${page.path}` : null

  const actions = (
    <>
      <IconButton icon={Settings2} label={page ? 'Change the page…' : 'Choose the page…'} onClick={() => setChoosing(true)} disabled={loading || scope === null || !ready} />
      <IconButton icon={RotateCcw} label="Reset — forget the chosen page" onClick={reset} disabled={loading || page === null} />
      <IconButton icon={Info} label="What is this?" onClick={() => setExplaining(true)} />
    </>
  )

  return (
    <>
      <Modal title="User Action" onClose={onClose} actions={actions}>
        <div className="user-action">
          <div className="user-action-scope muted" title={shown ?? undefined}>
            {where}
            {shown && <> · {shown}</>}
          </div>
          {error && <div className="error-banner">{error}</div>}
          {loading ? (
            <div className="muted user-action-empty">Loading…</div>
          ) : page === null ? (
            <div className="user-action-empty">
              <p className="muted">{scope?.kind === 'notebook' ? 'This notebook has no User Action page yet.' : 'The Notes app has no User Action page yet.'}</p>
              <button type="button" className="primary" onClick={() => setChoosing(true)} disabled={!ready}>
                Choose the page…
              </button>
            </div>
          ) : (
            <p className="muted">The page is launched in a window of its own with the ⚡ button (it is reused: the same window each time). It is closed with the button next to it.</p>
          )}
        </div>
      </Modal>

      {choosing && (
        <LocationPicker
          mode="page"
          title="Choose the page of the User Action"
          roots={roots}
          accounts={accounts}
          onAddRoot={addRoot}
          listed={[]}
          initial={page ? { sourceId: page.sourceId, path: page.path.includes('/') ? page.path.slice(0, page.path.lastIndexOf('/')) : '' } : undefined}
          onPick={choose}
          onCancel={() => setChoosing(false)}
        />
      )}

      {explaining && (
        <Modal title="User Action" onClose={() => setExplaining(false)} wide>
          <p>
            A <strong>User Action</strong> is a page of your own — an html file you choose — that opens in <strong>a window of its own</strong> from any page of Notes, and from
            any text box (the ⚡ next to the “…” button of the box you are typing in). Use it for whatever you want at hand while you work: a dashboard, a small tool, a checklist.
          </p>
          <p>
            <strong>The window is reused.</strong> Launching it again brings the same window to the front; going somewhere else in Notes doesn't close it. Two events tell the
            page what happens — <code>user-action-launched</code> (every time you launch it: it carries the resource identifier of what opened it, and where from — a button, or a
            text box, it also tells which one — a stable id distinct for every text box of Notes, never what is in it) and <code>user-action-scope-left</code> (you went elsewhere: what opened it is out of scope, so the page may go back to
            its default state). If the window was closed, it is opened and the first event waits until the page has started. The ✕ next to the ⚡ closes it. To hand it text from a box, copy the selection to the app's clipboard (the box's “…” menu); the page can read the app's clipboard, and what it puts there you can paste back.
          </p>
          <p>
            <strong>Which page.</strong> Inside a notebook, the page is that notebook's: which file it is is written in the notebook itself
            (<code>{`${NOTEBOOK_INTERNALS_INDEX}/${USER_ACTION_JSON}`}</code>, in the notebook's own internals folder), so it goes wherever the notebook goes. Anywhere else —
            the home page, the notebooks list, a folder that isn't in a notebook — there is one page for the whole app, kept in the Notes settings on this device.
            Right click (or a long press) on the ⚡ opens this dialog to choose, change or forget it.
          </p>
          <p>
            <strong>What the page can do.</strong> It is a window like any web app's: the same rights — your files, SQLite, Filen, the clipboards — through{' '}
            <code>window.__TAURI__.core.invoke</code>, an app state of its own that Notes can't reach and that can't reach Notes', and its own place in the window manager (listed under
            the Notes tab that launched it). It counts as one of the app's windows — at most ten are open at once. Exporting a file to the device asks you first, every time.
          </p>
        </Modal>
      )}
    </>
  )
}
