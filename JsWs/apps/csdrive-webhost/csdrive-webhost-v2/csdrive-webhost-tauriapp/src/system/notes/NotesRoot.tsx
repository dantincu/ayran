import { useEffect, useState } from 'react'
import NotebooksPage from './NotebooksPage'
import NotesApp from './NotesApp'
import NotesHome from './NotesHome'
import type { NotebookEntry } from './notebooks'
import { decodePlace, reportView, subscribeNavigate, type Place, type Tab } from './tabs'

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
    if (tab && place.view !== 'files') reportView(tab, place.view)
  }, [tab, place.view])

  const showFolder = (entry: NotebookEntry) =>
    setPlace({ view: 'files', location: { sourceId: entry.sourceId, branch: null, path: entry.folder } })

  switch (place.view) {
    case 'home':
      return <NotesHome onFiles={() => setPlace({ view: 'files', location: null })} onNotebooks={() => setPlace({ view: 'notebooks' })} />
    case 'notebooks':
      return <NotebooksPage onHome={() => setPlace({ view: 'home' })} onShowFolder={showFolder} />
    case 'files':
      return <NotesApp tab={tab} initial={place.location} onHome={() => setPlace({ view: 'home' })} />
  }
}
