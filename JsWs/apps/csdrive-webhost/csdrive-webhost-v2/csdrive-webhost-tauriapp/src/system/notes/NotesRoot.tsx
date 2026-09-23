import { useEffect, useState } from 'react'
import ChordHost from '../../components/ChordHost'
import TextFieldMenu from '../../components/TextFieldMenu'
import NoteEditPage from './NoteEditPage'
import NoteFilesPage from './NoteFilesPage'
import NotePage from './NotePage'
import NotebooksPage from './NotebooksPage'
import NotesSettingsPage from './NotesSettingsPage'
import NotesApp from './NotesApp'
import NotesHome from './NotesHome'
import NotesTopBar from './NotesTopBar'
import type { NotebookEntry } from './notebooks'
import { decodePlace, reportView, subscribeNavigate, type Place, type Tab } from './tabs'
import { UserActionDialogs, UserActionFieldButtons } from './UserActionButton'

/** What a Notes tab shows: the home page (where a tab that names no place starts), the page for managing notebooks, or the
 * file manager. The tab's place says which — see `Place` — and the window manager is told whenever it changes; the file
 * manager reports its own places, and listens for tab switches itself. */
export default function NotesRoot({ tab: initialTab, initial }: { tab: Tab | null; initial: Place | null }) {
  const [tab, setTab] = useState<Tab | null>(initialTab)
  const [place, setPlace] = useState<Place>(initial ?? { view: 'home' })

  // The user switched to another tab of this window: show its place, in place — no reload.
  useEffect(
    () =>
      subscribeNavigate((next) => {
        setTab(next)
        setPlace(decodePlace(next.resourceId) ?? { view: 'home' })
      }),
    [],
  )

  // The home page and the notebooks page say where the tab is (the file manager does it for itself).
  useEffect(() => {
    if (tab && (place.view === 'home' || place.view === 'notebooks' || place.view === 'settings')) reportView(tab, place.view)
  }, [tab, place.view])

  const showFolder = (entry: NotebookEntry) =>
    setPlace({ view: 'files', location: { sourceId: entry.sourceId, branch: null, path: entry.folder } })

  const view =
    place.view === 'home' ? (
      <NotesHome onFiles={() => setPlace({ view: 'files', location: null })} onNotebooks={() => setPlace({ view: 'notebooks' })} onSettings={() => setPlace({ view: 'settings' })} />
    ) : place.view === 'settings' ? (
      <NotesSettingsPage onHome={() => setPlace({ view: 'home' })} />
    ) : place.view === 'notebooks' ? (
      <NotebooksPage onHome={() => setPlace({ view: 'home' })} onShowFolder={showFolder} onOpenNotebook={(entry) => setPlace({ view: 'notes', sourceId: entry.sourceId, folder: entry.folder })} />
    ) : place.view === 'notes' ? (
      <NotePage key={`${place.sourceId}|${place.folder}`} tab={tab} sourceId={place.sourceId} folder={place.folder} onPlace={setPlace} onHome={() => setPlace({ view: 'home' })} />
    ) : place.view === 'noteEdit' ? (
      <NoteEditPage key={`${place.sourceId}|${place.folder}`} tab={tab} sourceId={place.sourceId} folder={place.folder} onPlace={setPlace} />
    ) : place.view === 'noteFiles' ? (
      <NoteFilesPage key={`${place.sourceId}|${place.folder}`} tab={tab} sourceId={place.sourceId} folder={place.folder} onPlace={setPlace} />
    ) : (
      <NotesApp key={place.location ? `${place.location.sourceId}|${place.location.path}` : 'last'} tab={tab} initial={place.location} onHome={() => setPlace({ view: 'home' })} />
    )
  return (
    <>
      <NotesTopBar tab={tab} />
      {view}
      {/* Every text box of Notes has the clipboard menu (with the app's own clipboard) and, beside it, the User Action's launch and close. */}
      <TextFieldMenu extra={(field) => <UserActionFieldButtons field={field} />} />
      <UserActionDialogs />
      <ChordHost />
    </>
  )
}
