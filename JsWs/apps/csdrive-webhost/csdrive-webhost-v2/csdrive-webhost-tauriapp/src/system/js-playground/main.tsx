import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../../index.css'
import '../../App.css'
import './js-playground.css'
import JsPlaygroundApp from './JsPlaygroundApp'
import { initWindowTab, onTabNavigate } from '../../lib/secondaryWindows'
import { applyCodeSnippets } from '../../lib/codeSnippets'
import { initAppearance } from '../../lib/appearance'

/** The JS Playground system app's own bootstrap — see CLAUDE.md's "JS Playground". Unlike Notes or the
 * pdf-viewer, this page has exactly one view and nothing to navigate to within it, so `tab-navigate`
 * (another window switching this same tab, or this one reloading) only ever means "reapply whatever code
 * snippets this load brought" — there's no place/resource of its own to restore. */
function Root() {
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let cancelled = false
    onTabNavigate((tab) => {
      applyCodeSnippets(tab.codeSnippets ?? [])
    }).then(() => {
      if (cancelled) return
      initWindowTab(1, location.href).then((tab) => {
        applyCodeSnippets(tab.codeSnippets ?? [])
        if (!cancelled) setReady(true)
      })
    })
    return () => {
      cancelled = true
    }
  }, [])

  if (!ready) {
    return (
      <div className="app-splash" role="status" aria-label="Loading">
        <div className="app-spinner" />
      </div>
    )
  }
  return <JsPlaygroundApp />
}

initAppearance()
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
