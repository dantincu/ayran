import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Sun, Moon } from 'lucide-react'
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

const SIDEBAR_COLLAPSED_WIDTH = 56

export function MailPage() {
  const { folderId, emailId } = useParams<{ folderId?: string; emailId?: string }>()
  const navigate = useNavigate()
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const { dark, toggle: toggleDark } = useThemeStore()

  const sidebar = useResizable({
    storageKey: 'panel-sidebar',
    defaultWidth: 256,
    minWidth: 160,
    maxWidth: 400,
  })

  const emailList = useResizable({
    storageKey: 'panel-email-list',
    defaultWidth: 320,
    minWidth: 200,
    maxWidth: 600,
  })

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

  const { getActiveAccount, accounts } = useAuthStore()

  const activeFolderId = folderId ? decodeURIComponent(folderId) : null
  const activeEmailId = emailId ? decodeURIComponent(emailId) : null

  const loadFolders = useCallback(async () => {
    const account = getActiveAccount()
    if (!account) return
    try {
      const fetched = await fetchFolders(account)
      setFolders(fetched)
      if (!folderId) {
        const inbox = fetched.find((f) => f.type === 'inbox')
        if (inbox) navigate(`/mail/${encodeURIComponent(inbox.id)}`, { replace: true })
      }
    } catch (e) {
      console.error('Failed to load folders', e)
    }
  }, [getActiveAccount, setFolders, folderId, navigate])

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

  useEffect(() => { loadFolders() }, [loadFolders, accounts])
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
    ? (folders.find((f) => f.id === activeFolderId)?.name ?? activeFolderId)
    : null

  const sidebarWidth = sidebarCollapsed ? SIDEBAR_COLLAPSED_WIDTH : sidebar.width

  return (
    <div className="flex h-screen bg-gray-50 dark:bg-gray-900 overflow-hidden">
      {/* Sidebar */}
      <div style={{ width: sidebarWidth, flexShrink: 0 }} className="flex flex-col h-full">
        <Sidebar
          collapsed={sidebarCollapsed}
          onToggle={() => setSidebarCollapsed((v) => !v)}
          onCompose={() => openCompose({ mode: 'compose', to: '', cc: '', bcc: '', subject: '', body: '' })}
        />
      </div>

      {/* Sidebar ↔ email-list handle (hidden when sidebar is collapsed) */}
      {!sidebarCollapsed && <ResizeHandle onMouseDown={sidebar.onMouseDown} />}

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
            onClick={toggleDark}
            className="ml-auto p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:text-gray-500 dark:hover:text-gray-300 dark:hover:bg-gray-700 transition-colors flex-shrink-0"
            title={dark ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {dark ? <Sun size={15} /> : <Moon size={15} />}
          </button>
        </header>

        {/* Main content */}
        <div className="flex flex-1 min-h-0 overflow-hidden">
          {/* Email list pane */}
          <div
            style={selectedEmail ? { width: emailList.width, flexShrink: 0 } : undefined}
            className={`flex flex-col bg-white dark:bg-gray-800 overflow-hidden ${selectedEmail ? '' : 'flex-1'}`}
          >
            {activeFolderId ? (
              <EmailList onRefresh={loadEmails} />
            ) : (
              <div className="flex-1 flex items-center justify-center text-gray-400 dark:text-gray-500 text-sm">
                Select a folder to view emails
              </div>
            )}
          </div>

          {/* Email-list ↔ email-view handle */}
          {selectedEmail && <ResizeHandle onMouseDown={emailList.onMouseDown} />}

          {/* Email view pane */}
          {selectedEmail && (
            <div className="flex-1 min-w-0 bg-white dark:bg-gray-800 overflow-hidden">
              <EmailView
                email={selectedEmail}
                onClose={() => activeFolderId && navigate(`/mail/${encodeURIComponent(activeFolderId)}`)}
              />
            </div>
          )}
        </div>
      </div>

      <ComposeModal />
    </div>
  )
}
