import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../../index.css'
import '../../App.css'
import './notes.css'
import NotesApp from './NotesApp'
import { decodeLocation, registerTab } from './tabs'

// The Notes app: a system app, one page of this frontend (see `system_apps.rs`). It registers itself
// as a tab with the window manager first — which also hands it the code every page applies (keeping
// clear of Android's system bars) — and then shows the place its tab names, if it names one.
registerTab().then((tab) => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <NotesApp tab={tab} initial={tab ? decodeLocation(tab.resourceId) : null} />
    </StrictMode>,
  )
})
