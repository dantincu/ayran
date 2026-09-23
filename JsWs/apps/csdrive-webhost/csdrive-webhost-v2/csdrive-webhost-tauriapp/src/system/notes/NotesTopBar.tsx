import { useEffect, useState } from 'react'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { Pause, X, XCircle } from 'lucide-react'
import IconButton from '../../components/IconButton'
import { closeTab, onShowTopBar, suspendSecondaryWindow } from '../../lib/secondaryWindows'
import type { Tab } from './tabs'

/** A closable bar at the top of every page of Notes (mounted once, in `NotesRoot.tsx` — never in a user web app,
 * and never in a note opened as a web app, which is a different page entirely; see CLAUDE.md's "The top bar").
 * Hidden by default; shown when the admin-app's "Show the top bar" — on a tab's own row, or the global one for
 * every open window — sends this window the `show-top-bar` event, or hidden again with its own × button. Lets the
 * person suspend the window or close the current tab without the page itself having to offer it. */
export default function NotesTopBar({ tab }: { tab: Tab | null }) {
  const [shown, setShown] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const stop = onShowTopBar(() => setShown(true))
    return () => {
      stop.then((unlisten) => unlisten())
    }
  }, [])

  if (!shown) return null

  return (
    <div className="notes-top-bar">
      <IconButton
        icon={Pause}
        label="Suspend this window — closes the window, keeps its entry in the System Apps tab"
        onClick={() => suspendSecondaryWindow(getCurrentWebviewWindow().label).catch((e) => setError(String(e)))}
      />
      <IconButton
        icon={XCircle}
        label="Close this tab"
        onClick={() => tab && closeTab(tab.tabGuid).catch((e) => setError(String(e)))}
        disabled={!tab}
      />
      {error && (
        <span className="error-banner notes-top-bar-error" title={error}>
          {error}
        </span>
      )}
      <IconButton icon={X} label="Hide the top bar" onClick={() => setShown(false)} className="notes-top-bar-close" />
    </div>
  )
}
