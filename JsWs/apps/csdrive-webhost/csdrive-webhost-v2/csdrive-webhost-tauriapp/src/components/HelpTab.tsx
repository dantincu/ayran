import { useEffect, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { List, Search } from 'lucide-react'
import CodeBlock from './CodeBlock'
import IconButton from './IconButton'
import Modal from './Modal'
import { API_REFERENCE } from '../lib/apiReference'
import { subscribeShowHelpHeader } from '../lib/helpHeader'
import { useScrollAutohide } from '../lib/scrollAutohide'

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

/** The page's own sections, in order — what the table of contents lists and what its links scroll to
 * (`document.getElementById(id)`, each section's own `id`). A new section gets an entry here too. */
const SECTIONS = [
  { id: 'help-overview', label: 'Overview' },
  { id: 'help-keyboard-shortcuts', label: 'Keyboard shortcuts' },
  { id: 'help-making-your-own-web-app', label: 'Making your own web app' },
  { id: 'help-the-essentials', label: 'The essentials' },
  { id: 'help-example-toolbar', label: "Example: a page's own toolbar" },
  { id: 'help-api-reference', label: 'API reference' },
  { id: 'help-codecs', label: 'Installing audio/video codecs' },
]

/** The Help tab's own autohiding header: the page's title, and a button opening the table of contents. Hides
 * on scrolling down and comes back on scrolling up, on reaching the top, or when told to (`showHelpHeader`,
 * called when the Help tab's own button is pressed again while already showing it) — the scroll-direction
 * mechanics themselves are `useScrollAutohide` (shared with Notes' top bar and its editor pages' own headers). */
function HelpHeader() {
  const [hidden, show, hide] = useScrollAutohide()
  const [tocOpen, setTocOpen] = useState(false)

  useEffect(() => subscribeShowHelpHeader(show), [show])

  function goTo(id: string) {
    setTocOpen(false)
    // Collapse the header — if it's currently shown — and let that transition finish *before* scrolling: the
    // header's own height is real layout space (`position: sticky` still reserves it), so collapsing it while
    // `scrollIntoView`'s own animation is also under way shifts the very thing the browser is scrolling toward
    // mid-flight, landing well past the target instead of right below the header (found live: the target ended
    // up ~140px further down than the header's own height should allow, exactly the concurrent-collapse gap).
    hide()
    window.setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 260)
  }

  return (
    <div className={`help-header ${hidden ? 'help-header-hidden' : ''}`} data-primary-actions>
      <strong>Ayran CsDrive WebHost — Help</strong>
      <IconButton icon={List} label="Table of contents…" onClick={() => setTocOpen(true)} />
      {tocOpen && (
        <Modal title="Table of contents" onClose={() => setTocOpen(false)}>
          <ul className="help-toc-list">
            {SECTIONS.map((s) => (
              <li key={s.id}>
                <button type="button" className="link-button" onClick={() => goTo(s.id)}>
                  {s.label}
                </button>
              </li>
            ))}
          </ul>
        </Modal>
      )}
    </div>
  )
}

/** The admin-app's Help tab: an overview for someone writing their own web app, a couple of copyable code
 * snippets, a reference of every backend command a web app may call (`lib/apiReference.ts`), and the full
 * keyboard-shortcuts reference (`docs/keyboard-shortcuts.md`, fetched and rendered by the backend so the two can
 * never drift apart — `help_docs::get_keyboard_shortcuts_html`). `HelpHeader` above is this page's own autohiding
 * header with a table-of-contents popup. */
export default function HelpTab() {
  const [sampleHtml, setSampleHtml] = useState<string | null>(null)
  const [sampleError, setSampleError] = useState<string | null>(null)
  const [shortcutsHtml, setShortcutsHtml] = useState<string | null>(null)
  const [shortcutsError, setShortcutsError] = useState<string | null>(null)
  const [codecHtml, setCodecHtml] = useState<string | null>(null)
  const [codecError, setCodecError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  useEffect(() => {
    invoke<string>('get_deployable_app_html', { appId: 'example-toolbar' }).then(setSampleHtml, (e) => setSampleError(String(e)))
    invoke<string>('get_keyboard_shortcuts_html').then(setShortcutsHtml, (e) => setShortcutsError(String(e)))
    invoke<string>('get_codec_help_html').then(setCodecHtml, (e) => setCodecError(String(e)))
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
      <HelpHeader />

      <div className="toolbar" id="help-overview">
        <strong>Ayran CsDrive WebHost</strong>
      </div>
      <p className="muted">
        A file manager for the <code>user</code> folder, any folders you pick, and connected Filen.io accounts — and a
        host for your own web apps: plain HTML/JS/CSS files that run in their own window and talk to this app's Rust
        backend for files, SQLite, Filen.io, and managing their own windows and tabs. This page is a starting point for
        writing one.
      </p>

      <div className="toolbar" id="help-keyboard-shortcuts" style={{ marginTop: 24 }}>
        <strong>Keyboard shortcuts</strong>
      </div>
      <p className="muted">Every keyboard shortcut in the app — the same document as `docs/keyboard-shortcuts.md`, rendered here so it never has to be looked up separately.</p>
      {shortcutsError && <div className="error-banner">{shortcutsError}</div>}
      {shortcutsHtml === null && !shortcutsError ? (
        <p className="muted">Loading…</p>
      ) : (
        shortcutsHtml && <div className="markdown-fragment" dangerouslySetInnerHTML={{ __html: shortcutsHtml }} />
      )}

      <div className="toolbar" id="help-making-your-own-web-app" style={{ marginTop: 24 }}>
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

      <div className="toolbar" id="help-the-essentials" style={{ marginTop: 24 }}>
        <strong>The essentials</strong>
      </div>
      <p className="muted">
        Every page binds itself to the tab the app already made for its window, and listens for being switched back
        to. Nothing else is required to just show content — the calls below are the whole of it.
      </p>
      <CodeBlock code={QUICK_START} language="javascript" onError={setError} />

      <div className="toolbar" id="help-example-toolbar" style={{ marginTop: 24 }}>
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

      <div className="toolbar" id="help-api-reference" style={{ marginTop: 24 }}>
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
            <colgroup>
              <col className="api-call-col" />
              <col className="api-summary-col" />
            </colgroup>
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

      <div className="toolbar" id="help-codecs" style={{ marginTop: 24 }}>
        <strong>Installing audio/video codecs</strong>
      </div>
      <p className="muted">
        Some video files — an <code>.mkv</code> with AC3/DTS audio is the common case — use a codec this app's
        built-in player wasn't built with a decoder for, so the video plays but the audio stays silent. Notes'
        own <strong>Convert for compatible playback</strong> button (in the video viewer, Windows desktop only
        for now) re-encodes such a file using whatever codec Windows itself can find a decoder for; this section
        is about making sure Windows (or, failing that, Android) actually has one.
      </p>
      {codecError && <div className="error-banner">{codecError}</div>}
      {codecHtml === null && !codecError ? (
        <p className="muted">Loading…</p>
      ) : (
        codecHtml && <div className="markdown-fragment" dangerouslySetInnerHTML={{ __html: codecHtml }} />
      )}
    </div>
  )
}
