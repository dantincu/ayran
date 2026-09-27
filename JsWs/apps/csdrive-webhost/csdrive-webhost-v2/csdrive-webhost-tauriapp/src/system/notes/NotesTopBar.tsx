import { useEffect, useState } from 'react'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { ArrowLeft, Pause, X, XCircle, XSquare } from 'lucide-react'
import IconButton from '../../components/IconButton'
import { closeSecondaryWindow, closeTab, onShowTopBar, setTabTopBarHidden, suspendSecondaryWindow, windowGoBack } from '../../lib/secondaryWindows'
import { subscribeTopBarInfo } from './topBarInfo'
import type { Tab } from './tabs'

/** A closable bar at the top of every page of Notes (mounted once, in `NotesRoot.tsx` — never in a user web app,
 * and never in a note opened as a web app, which is a different page entirely; see CLAUDE.md's "The top bar").
 * Starts shown or hidden following the tab's own `topBarHidden` (the person's last close, or — absent one —
 * the global autohide setting), shown again when the admin-app's "Show the top bar" — a tab's own row, or the
 * global one for every open window — sends this window the `show-top-bar` event, or hidden again with its own
 * × (which persists that choice). Besides the label/tags/root markup the backend renders for it (`topBarHtml`),
 * lets the person go back one navigation step, suspend the window or close the current tab without the page
 * itself having to offer it. */
export default function NotesTopBar({ tab }: { tab: Tab | null }) {
  const [shown, setShown] = useState(false)
  const [info, setInfo] = useState<{ html: string; hidden: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => subscribeTopBarInfo((i) => setInfo(i)), [])
  // A fresh tab (or a tab switch) decides the starting visibility from its own `hidden`; the admin-app's
  // "show top bar" (below) can then reveal it immediately without waiting for another round trip.
  useEffect(() => {
    if (info) setShown(!info.hidden)
  }, [info])

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
        icon={ArrowLeft}
        label="Go back one step"
        onClick={() => windowGoBack().catch((e) => setError(String(e)))}
      />
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
      <IconButton
        icon={XSquare}
        label="Close this window — closes the window and removes its entry from the System Apps tab"
        onClick={() => closeSecondaryWindow(getCurrentWebviewWindow().label).catch((e) => setError(String(e)))}
      />
      {info?.html && <span className="notes-top-bar-info" dangerouslySetInnerHTML={{ __html: info.html }} />}
      {error && (
        <span className="error-banner notes-top-bar-error" title={error}>
          {error}
        </span>
      )}
      <IconButton
        icon={X}
        label="Hide the top bar"
        onClick={() => {
          setShown(false)
          if (tab) setTabTopBarHidden(tab.tabGuid, true).catch((e) => setError(String(e)))
        }}
        className="notes-top-bar-close"
      />
    </div>
  )
}
