import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../../index.css'
import '../../App.css'
import './pdf-viewer.css'
import PdfViewerApp from './PdfViewerApp'
import { initWindowTab, onTabNavigate, type FileRef } from '../../lib/secondaryWindows'
import { applyCodeSnippets } from '../../lib/codeSnippets'
import { initAppearance } from '../../lib/appearance'

/** Decodes the query the window was opened with (`secondary_windows::open_pdf_viewer_window` sets the
 * tab's own resource id to exactly this before the window ever opens — see that function's own doc for why
 * a system app needs this, unlike a plain web app whose own address already names its file): `path` plus
 * either `root` (the user folder's own sentinel `user`, or a picked folder's id) or `userId`/`branch` (a
 * Filen account, and the branch's index when the file was opened in one). */
function fileFromResourceId(resourceId: string): FileRef | null {
  const q = resourceId.split('?')[1]
  if (!q) return null
  const params = new URLSearchParams(q)
  const path = params.get('path')
  if (path == null) return null
  const userId = params.get('userId')
  if (userId != null) {
    const branch = params.get('branch')
    return { storage: 'FilenCloud', userId: Number(userId), branch: branch == null ? null : Number(branch), path }
  }
  const root = params.get('root')
  if (root == null) return null
  return root === 'user' ? { storage: 'UserFolder', path } : { storage: 'DeviceFolder', root, path }
}

/** The pdf-viewer system app's own bootstrap — see CLAUDE.md's "PDF conversion and viewing". Registers
 * itself as a tab like any other page, then shows whichever file the tab's own resource id names;
 * switching this window to *another* tab (another PDF) is handled in place, the same as Notes handles
 * `tab-navigate` for its own places — the page is never reloaded for it. */
function Root() {
  const [tabGuid, setTabGuid] = useState<string | null>(null)
  const [file, setFile] = useState<FileRef | null>(null)

  useEffect(() => {
    let cancelled = false
    onTabNavigate((tab) => {
      applyCodeSnippets(tab.codeSnippets ?? [])
      setTabGuid(tab.tabGuid)
      setFile(fileFromResourceId(tab.resourceId))
    }).then(() => {
      if (cancelled) return
      initWindowTab(1, location.href).then((tab) => {
        applyCodeSnippets(tab.codeSnippets ?? [])
        setTabGuid(tab.tabGuid)
        setFile(fileFromResourceId(tab.resourceId))
      })
    })
    return () => {
      cancelled = true
    }
  }, [])

  return <PdfViewerApp key={tabGuid ?? 'loading'} file={file} />
}

initAppearance()
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
