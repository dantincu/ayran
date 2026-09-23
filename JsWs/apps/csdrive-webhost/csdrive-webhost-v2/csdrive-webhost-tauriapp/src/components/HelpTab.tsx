import { useEffect, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Search } from 'lucide-react'
import CodeBlock from './CodeBlock'
import { API_REFERENCE } from '../lib/apiReference'

const QUICK_START = `// The smallest a page needs to participate in the window manager's tabs:
window.__TAURI__.webviewWindow.getCurrentWebviewWindow().listen('tab-navigate', (event) => {
  // The person switched to another tab of this window — show it in place, or:
  location.reload()
})

window.__TAURI__.core.invoke('init_window_tab', {
  appVersion: 1,
  url: location.href,
  resourceType: null,
}).then((info) => {
  // info.tabGuid, info.resourceId, info.codeSnippets, ...
})`

/** The admin-app's Help tab: an overview for someone writing their own web app, a couple of copyable code
 * snippets, and a reference of every backend command a web app may call (`lib/apiReference.ts`). */
export default function HelpTab() {
  const [sampleHtml, setSampleHtml] = useState<string | null>(null)
  const [sampleError, setSampleError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  useEffect(() => {
    invoke<string>('get_deployable_app_html', { appId: 'example-toolbar' }).then(setSampleHtml, (e) => setSampleError(String(e)))
  }, [])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return API_REFERENCE
    return API_REFERENCE.map((category) => ({
      ...category,
      entries: category.entries.filter((e) => e.call.toLowerCase().includes(q) || e.summary.toLowerCase().includes(q) || (e.note ?? '').toLowerCase().includes(q)),
    })).filter((category) => category.entries.length > 0)
  }, [query])

  return (
    <div className="tab-panel help-tab">
      <div className="toolbar">
        <strong>Ayran CsDrive WebHost</strong>
      </div>
      <p className="muted">
        A file manager for the <code>user</code> folder, any folders you pick, and connected Filen.io accounts — and a
        host for your own web apps: plain HTML/JS/CSS files that run in their own window and talk to this app's Rust
        backend for files, SQLite, Filen.io, and managing their own windows and tabs. This page is a starting point for
        writing one.
      </p>

      <div className="toolbar" style={{ marginTop: 24 }}>
        <strong>Making your own web app</strong>
      </div>
      <p className="muted">
        Write <code>.html</code>/<code>.js</code>/<code>.css</code> files under the <strong>Files</strong> tab — the
        user folder, or a folder you add with <em>Add root folder</em> — then use that file's <em>Open as web app</em>{' '}
        action (or, in the User Apps tab, <em>add a new window entry</em>) to give it a window. Markdown (
        <code>.md</code>) works the same way, rendered to HTML first. Your page runs under a strict content policy: it
        can reach its own files and the backend below, nothing on the network directly — a backend command is how a
        page reaches anything outside the app (Filen.io included).
      </p>
      <p className="muted">
        The fastest way to see a working page: Files tab → toolbar → <strong>Deploy apps…</strong> →{' '}
        <em>Example: a page's own toolbar</em> — it writes the same file shown below into a folder you pick, ready to
        open and edit.
      </p>

      <div className="toolbar" style={{ marginTop: 24 }}>
        <strong>The essentials</strong>
      </div>
      <p className="muted">
        Every page binds itself to the tab the app already made for its window, and listens for being switched back
        to. Nothing else is required to just show content — the calls below are the whole of it.
      </p>
      <CodeBlock code={QUICK_START} language="javascript" onError={setError} />

      <div className="toolbar" style={{ marginTop: 24 }}>
        <strong>Example: a page's own toolbar</strong>
      </div>
      <p className="muted">
        A page can draw its own buttons for things like suspending its window or closing its tab — there is nothing
        special about them, they just call back into the backend like any other button. The file below is split in
        two: a <strong>library</strong> part (copy it into any page of your own, unchanged) and an{' '}
        <strong>example</strong> part (this demo's own toolbar and content — replace it with yours). The same file is
        what <em>Deploy apps…</em> writes to disk, so the two never drift apart.
      </p>
      {sampleError && <div className="error-banner">{sampleError}</div>}
      {error && <div className="error-banner">{error}</div>}
      {sampleHtml === null && !sampleError ? <p className="muted">Loading…</p> : sampleHtml && <CodeBlock code={sampleHtml} language="html" onError={setError} />}

      <div className="toolbar" style={{ marginTop: 24 }}>
        <strong>API reference</strong>
      </div>
      <p className="muted">
        Every command a web app may call, as it's actually written from a page (
        <code>window.__TAURI__.core.invoke(...)</code>) — the admin-app's own internal helper functions aren't shipped
        to a web app's page, so these are the raw calls. A byte payload (writing a file, uploading, exporting) is sent
        as the request body with its other arguments as headers, not as a JSON field — `fs_write_file` below shows the
        pattern.
      </p>
      <label className="search-box">
        <Search size={16} aria-hidden="true" />
        <input
          type="search"
          placeholder="Search the API reference…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      {filtered.length === 0 && <p className="muted">Nothing matches "{query}".</p>}
      {filtered.map((category) => (
        <div key={category.title} className="api-category">
          <h3>{category.title}</h3>
          {category.intro && <p className="muted">{category.intro}</p>}
          <table className="api-table">
            <tbody>
              {category.entries.map((entry) => (
                <tr key={entry.call}>
                  <td>
                    <code className="api-call">{entry.call}</code>
                  </td>
                  <td className="api-summary">
                    {entry.summary}
                    {entry.note && <div className="muted api-note">{entry.note}</div>}
                    <div className="muted api-returns">→ {entry.returns}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  )
}
