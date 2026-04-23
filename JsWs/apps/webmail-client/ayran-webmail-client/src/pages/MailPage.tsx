import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Sun, Moon, Columns2 } from 'lucide-react'
import { Sidebar } from '../components/layout/Sidebar'
import { ResizeHandle } from '../components/layout/ResizeHandle'
import { EmailList } from '../components/email/EmailList'
import { EmailView } from '../components/email/EmailView'
import { ComposeModal } from '../components/compose/ComposeModal'
import { SearchBar } from '../components/search/SearchBar'
import { useEmailStore } from '../stores/emailStore'
import { useAuthStore } from '../stores/authStore'
import { fetchEmails, fetchFolders } from '../services/emailService'
import { useResizable } from '../hooks/useResizable'
import { useThemeStore } from '../stores/themeStore'

const SIDEBAR_COLLAPSED_PX = 56
type SidebarState = 'collapsed' | 'normal' | 'maximized'

function readBool(key: string, defaultVal: boolean): boolean {
  const s = localStorage.getItem(key)
  return s === null ? defaultVal : s !== 'false'
}

export function MailPage() {
  const { folderId, emailId } = useParams<{ folderId?: string; emailId?: string }>()
  const navigate = useNavigate()
  const { dark, toggle: toggleDark } = useThemeStore()

  // Layout toggles (persisted)
  const [sidebarState, setSidebarState] = useState<SidebarState>(() => {
    const s = localStorage.getItem('sidebar-state')
    return (s === 'normal' || s === 'maximized' || s === 'collapsed') ? s : 'collapsed'
  })
  const [splitView, setSplitView] = useState(() => readBool('split-view', true))

  useEffect(() => { localStorage.setItem('sidebar-state', sidebarState) }, [sidebarState])
  useEffect(() => { localStorage.setItem('split-view', String(splitView)) }, [splitView])

  // Track viewport width so percentage → px conversion stays accurate on resize
  const [vw, setVw] = useState(window.innerWidth)
  useEffect(() => {
    const handler = () => setVw(window.innerWidth)
    window.addEventListener('resize', handler)
    return () => window.removeEventListener('resize', handler)
  }, [])

  // Sidebar: % of total viewport width
  const sidebar = useResizable({ storageKey: 'pct-sidebar', defaultPct: 20, minPct: 10, maxPct: 30 })

  // Email list: % of the remaining space (viewport − sidebar)
  // Expressing it relative to remaining space means the list:view ratio is preserved
  // automatically when the sidebar collapses/expands.
  const emailList = useResizable({ storageKey: 'pct-emaillist', defaultPct: 40, minPct: 20, maxPct: 70 })

  // Computed pixel widths
  const sidebarPx =
    sidebarState === 'collapsed' ? SIDEBAR_COLLAPSED_PX :
    sidebarState === 'maximized' ? vw :
    Math.round((sidebar.pct / 100) * vw)
  const remainingPx = vw - sidebarPx

  const {
    currentPage,
    pageSize,
    search,
    sort,
    emails,
    folders,
    setEmails,
    setFolders,
    setLoading,
    setError,
    openCompose,
  } = useEmailStore()

  const { getActiveAccount, activeAccountId } = useAuthStore()

  const activeFolderId = folderId ? decodeURIComponent(folderId) : null
  const activeEmailId = emailId ? decodeURIComponent(emailId) : null

  const loadFolders = useCallback(async () => {
    const account = getActiveAccount()
    if (!account) return
    setFolders([])
    setEmails([], 0)
    try {
      const fetched = await fetchFolders(account)
      setFolders(fetched)
    } catch (e) {
      console.error('Failed to load folders', e)
    }
  }, [getActiveAccount, setFolders, setEmails, activeAccountId])

  const loadEmails = useCallback(async () => {
    const account = getActiveAccount()
    if (!account || !activeFolderId) return
    setLoading(true)
    setError(null)
    try {
      const { emails: fetched, totalCount } = await fetchEmails(
        account,
        activeFolderId,
        currentPage,
        pageSize,
        search,
        sort
      )
      setEmails(fetched, totalCount)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load emails')
    } finally {
      setLoading(false)
    }
  }, [getActiveAccount, activeFolderId, currentPage, pageSize, search, sort, setEmails, setLoading, setError])

  useEffect(() => { loadFolders() }, [loadFolders])

  // Navigate to the active account's inbox whenever folders change and the current
  // URL folder either doesn't exist or belongs to a different account (e.g. after switching).
  useEffect(() => {
    if (folders.length === 0) return
    const folderOwned = folders.some((f) => f.id === activeFolderId && f.accountId === activeAccountId)
    if (!activeFolderId || !folderOwned) {
      const inbox = folders.find((f) => f.type === 'inbox')
      if (inbox) navigate(`/mail/${encodeURIComponent(inbox.id)}`, { replace: true })
    }
  }, [folders, activeFolderId, activeAccountId, navigate])

  useEffect(() => { if (activeFolderId) loadEmails() }, [loadEmails, activeFolderId, currentPage, search, sort])

  useEffect(() => {
    const store = useEmailStore.getState()
    if (activeFolderId !== store.selectedFolderId) store.setSelectedFolder(activeFolderId)
  }, [activeFolderId])

  useEffect(() => {
    const store = useEmailStore.getState()
    if (activeEmailId !== store.selectedEmailId) store.setSelectedEmail(activeEmailId)
  }, [activeEmailId])

  const selectedEmail = activeEmailId ? emails.find((e) => e.id === activeEmailId) : null
  const folderName = activeFolderId
    ? (folders.find((f) => f.id === activeFolderId)?.name ?? null)
    : null

  // In split view, the email list has a fixed width and the email view fills the rest.
  // emailListPct is a share of remainingPx (not total vw), so the list:view ratio is
  // preserved when the sidebar is toggled.
  const showSplit = splitView && !!selectedEmail
  const emailListPx = showSplit ? Math.round((emailList.pct / 100) * remainingPx) : undefined

  const closeEmail = () => activeFolderId && navigate(`/mail/${encodeURIComponent(activeFolderId)}`)

  return (
    <div className="flex h-screen bg-gray-50 dark:bg-gray-900 overflow-hidden">
      {/* Sidebar */}
      <div style={{ width: sidebarPx, flexShrink: 0 }} className="flex flex-col h-full">
        <Sidebar
          sidebarState={sidebarState}
          onSetSidebarState={setSidebarState}
          onCompose={() => openCompose({ mode: 'compose', to: '', cc: '', bcc: '', subject: '', body: '' })}
        />
      </div>

      {/* Sidebar ↔ email-list handle */}
      {sidebarState === 'normal' && (
        <ResizeHandle onMouseDown={(e) => sidebar.onMouseDown(e, vw)} />
      )}

      {sidebarState !== 'maximized' && (
      <div className="flex flex-col flex-1 min-w-0">
        {/* Top bar */}
        <header className="flex items-center gap-3 px-4 py-2.5 bg-white dark:bg-gray-800 border-b border-gray-100 dark:border-gray-700 flex-shrink-0">
          {folderName && (
            <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200 flex-shrink-0">{folderName}</h2>
          )}
          <div className="flex-1 max-w-xl">
            <SearchBar />
          </div>
          <button
            onClick={() => setSplitView((v) => !v)}
            className={`p-1.5 rounded-lg transition-colors flex-shrink-0 ${
              splitView
                ? 'text-primary-600 dark:text-primary-400 bg-primary-50 dark:bg-primary-900/20 hover:bg-primary-100 dark:hover:bg-primary-900/40'
                : 'text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:text-gray-500 dark:hover:text-gray-300 dark:hover:bg-gray-700'
            }`}
            title={splitView ? 'Disable split view' : 'Enable split view'}
          >
            <Columns2 size={15} />
          </button>
          <button
            onClick={toggleDark}
            className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:text-gray-500 dark:hover:text-gray-300 dark:hover:bg-gray-700 transition-colors flex-shrink-0"
            title={dark ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {dark ? <Sun size={15} /> : <Moon size={15} />}
          </button>
        </header>

        {/* Main content */}
        <div className="flex flex-1 min-h-0 overflow-hidden">
          {/* Email list pane: always visible in split view; hidden when an email is open in single-pane mode */}
          {(!selectedEmail || splitView) && (
            <div
              style={emailListPx ? { width: emailListPx, flexShrink: 0 } : undefined}
              className={`flex flex-col bg-white dark:bg-gray-800 overflow-hidden ${emailListPx ? '' : 'flex-1'}`}
            >
              {activeFolderId ? (
                <EmailList onRefresh={loadEmails} />
              ) : (
                <div className="flex-1 flex items-center justify-center text-gray-400 dark:text-gray-500 text-sm">
                  Select a folder to view emails
                </div>
              )}
            </div>
          )}

          {/* Email-list ↔ email-view resize handle (split view only) */}
          {showSplit && (
            <ResizeHandle onMouseDown={(e) => emailList.onMouseDown(e, remainingPx)} />
          )}

          {/* Email view pane */}
          {selectedEmail && (
            <div className="flex-1 min-w-0 bg-white dark:bg-gray-800 overflow-hidden">
              <EmailView email={selectedEmail} onClose={closeEmail} />
            </div>
          )}
        </div>
      </div>
      )}

      <ComposeModal />
    </div>
  )
}
