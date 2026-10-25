import { useCallback, useEffect, useState } from 'react'
import { FileCode, Info, RotateCcw } from 'lucide-react'
import IconButton from '../../components/IconButton'
import Modal from '../../components/Modal'
import LocationPicker, { type Picked } from './LocationPicker'
import { readNotebookScript, resetNotebookScript, saveNotebookScript, type NoteViewerScript } from './noteViewerScript'
import { notebookTitle, type NotebookEntry } from './notebooks'
import { useNotesSources } from './useSources'

/** The dialog that chooses a notebook's own **viewer script** (reached from the notebook's own row, "Set
 * its viewer script…"): the buttons to choose or change it, to forget it and to have it explained — the
 * script itself is never shown here, only run on the pages that apply it (see `note_viewer_script.rs`). */
export default function NoteViewerScriptModal({ notebook, onClose }: { notebook: NotebookEntry; onClose: () => void }) {
  const { roots, accounts, ready, addRoot, sourceOf } = useNotesSources()
  const [script, setScript] = useState<NoteViewerScript | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [choosing, setChoosing] = useState(false)
  const [explaining, setExplaining] = useState(false)

  const source = sourceOf(notebook.sourceId)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      if (!source) throw new Error("This notebook's place isn't available.")
      setScript(await readNotebookScript(source, notebook))
    } catch (e) {
      setScript(null)
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, notebook])

  useEffect(() => {
    load()
  }, [load])

  async function choose(picked: Picked) {
    setChoosing(false)
    if (!picked.fileName || !source) return
    const next: NoteViewerScript = { sourceId: picked.source.id, path: [picked.folder, picked.fileName].filter(Boolean).join('/') }
    try {
      await saveNotebookScript(source, notebook, next)
      setError(null)
      setScript(next)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function reset() {
    if (!source) return
    try {
      await resetNotebookScript(source, notebook)
      setError(null)
      setScript(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const shown = script ? `${sourceOf(script.sourceId)?.label ?? script.sourceId} · /${script.path}` : null

  const actions = (
    <>
      <IconButton icon={FileCode} label={script ? 'Change the script…' : 'Choose the script…'} onClick={() => setChoosing(true)} disabled={loading || !ready} />
      <IconButton icon={RotateCcw} label="Reset — forget the chosen script" onClick={reset} disabled={loading || script === null} />
      <IconButton icon={Info} label="What is this?" onClick={() => setExplaining(true)} />
    </>
  )

  return (
    <>
      <Modal title={`Viewer script — ${notebookTitle(notebook)}`} onClose={onClose} actions={actions}>
        <div className="user-action">
          {error && <div className="error-banner">{error}</div>}
          {!loading && !script && (
            <div className="warning-banner">
              This script runs with the same rights as the page itself — your files, SQLite, Filen, the clipboards — on every Note Viewer and
              markdown/html File Viewer page shown for a file inside this notebook (its subfolders included). Only choose a script you wrote
              yourself, or trust completely — the same caution as writing a <code>&lt;script&gt;</code> tag into the file by hand.
            </div>
          )}
          {loading ? (
            <div className="muted user-action-empty">Loading…</div>
          ) : script === null ? (
            <div className="user-action-empty">
              <p className="muted">This notebook has no viewer script yet.</p>
              <button type="button" className="primary" onClick={() => setChoosing(true)} disabled={!ready}>
                Choose the script…
              </button>
            </div>
          ) : (
            <p className="muted">
              {shown}
              <br />
              Re-read fresh every time a page in this notebook's scope loads — editing it and reopening or reloading that page picks up the change.
            </p>
          )}
        </div>
      </Modal>

      {choosing && (
        <LocationPicker
          mode="file"
          title="Choose the notebook's viewer script"
          roots={roots}
          accounts={accounts}
          onAddRoot={addRoot}
          listed={[]}
          initial={
            script
              ? { sourceId: script.sourceId, path: script.path.includes('/') ? script.path.slice(0, script.path.lastIndexOf('/')) : '' }
              : { sourceId: notebook.sourceId, path: notebook.folder }
          }
          onPick={choose}
          onCancel={() => setChoosing(false)}
        />
      )}

      {explaining && (
        <Modal title="A notebook's viewer script" onClose={() => setExplaining(false)} wide>
          <p>
            A notebook can run one script of your own — a plain JavaScript file — on every <strong>Note Viewer</strong> and{' '}
            <strong>markdown/html File Viewer</strong> page shown for a file inside this notebook's folder (its subfolders included). It runs
            inserted directly into that page's own DOM, with exactly the same rights as the page itself: the window's files, SQLite, Filen, the
            clipboards — nothing more, nothing less, the same as if you had written a <code>&lt;script&gt;</code> tag into the file by hand.
          </p>
          <p>
            <strong>Where it's kept.</strong> Which file is the script — not its content — is written in the notebook itself, in its own internals
            folder, so it goes wherever the notebook goes; the script file can be anywhere you point to (this folder, another one, a Filen
            account), the same as a User Action page can be. It is re-read fresh every time a page that shows it loads — editing the script and
            reopening or reloading that page picks up the change, with no separate "apply" step.
          </p>
          <p>
            <strong>Not covered.</strong> A page that opens another one by itself, through its own JavaScript rather than the ordinary "open as
            web app" action, keeps running whichever script it already started with rather than picking up a new one mid-page. The User Action
            page (the ⚡ button) is a separate mechanism with its own design and is never affected by this.
          </p>
        </Modal>
      )}
    </>
  )
}
