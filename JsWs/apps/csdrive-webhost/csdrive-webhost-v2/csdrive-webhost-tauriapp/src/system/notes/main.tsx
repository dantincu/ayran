import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../../index.css'
import '../../App.css'
import './notes.css'
import NotesRoot from './NotesRoot'
import { decodePlace, registerTab } from './tabs'
import { initAppearance } from '../../lib/appearance'

// The Notes app: a system app, one page of this frontend (see `system_apps.rs`). It registers itself
// as a tab with the window manager first — which also hands it the code every page applies (keeping
// clear of Android's system bars) — and then shows the place its tab names: the file manager at a place, the page for
// managing notebooks, or — for a tab that names nothing — the home page.
Promise.all([registerTab(), initAppearance()]).then(([tab]) => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <NotesRoot tab={tab} initial={tab ? decodePlace(tab.resourceId) : null} />
    </StrictMode>,
  )
})
