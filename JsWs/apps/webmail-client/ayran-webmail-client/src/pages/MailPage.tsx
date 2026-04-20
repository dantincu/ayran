import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Sidebar } from '../components/layout/Sidebar'
import { EmailList } from '../components/email/EmailList'
import { EmailView } from '../components/email/EmailView'
import { ComposeModal } from '../components/compose/ComposeModal'
import { SearchBar } from '../components/search/SearchBar'
import { useEmailStore } from '../stores/emailStore'
import { useAuthStore } from '../stores/authStore'
import { fetchEmails, fetchFolders } from '../services/emailService'

export function MailPage() {
  const { folderId, emailId } = useParams<{ folderId?: string; emailId?: string }>()
  const navigate = useNavigate()
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)

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

  // Decode URL param — folder IDs can contain slashes when base64-encoded by Gmail
  const activeFolderId = folderId ? decodeURIComponent(folderId) : null
  const activeEmailId = emailId ? decodeURIComponent(emailId) : null

  const loadFolders = useCallback(async () => {
    const account = getActiveAccount()
    if (!account) return
    try {
      const fetched = await fetchFolders(account)
      setFolders(fetched)
      // If no folder is selected yet, navigate to inbox
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

  useEffect(() => {
    loadFolders()
  }, [loadFolders, accounts])

  useEffect(() => {
    if (activeFolderId) loadEmails()
  }, [loadEmails, activeFolderId, currentPage, search, sort])

  const selectedEmail = activeEmailId ? emails.find((e) => e.id === activeEmailId) : null

  const handleCloseEmail = () => {
    if (activeFolderId) navigate(`/mail/${encodeURIComponent(activeFolderId)}`)
  }

  const handleCompose = () => {
    openCompose({ mode: 'compose', to: '', cc: '', bcc: '', subject: '', body: '' })
  }

  // Keep store in sync with URL so components that read from store still work
  useEffect(() => {
    const store = useEmailStore.getState()
    if (activeFolderId !== store.selectedFolderId) store.setSelectedFolder(activeFolderId)
  }, [activeFolderId])

  useEffect(() => {
    const store = useEmailStore.getState()
    if (activeEmailId !== store.selectedEmailId) store.setSelectedEmail(activeEmailId)
  }, [activeEmailId])

  const folderName = activeFolderId
    ? (folders.find((f) => f.id === activeFolderId)?.name ?? activeFolderId)
    : null

  return (
    <div className="flex h-screen bg-gray-50 overflow-hidden">
      <Sidebar
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed((v) => !v)}
        onCompose={handleCompose}
      />

      <div className="flex flex-col flex-1 min-w-0">
        {/* Top bar */}
        <header className="flex items-center gap-3 px-4 py-2.5 bg-white border-b border-gray-100 flex-shrink-0">
          {folderName && (
            <h2 className="text-sm font-semibold text-gray-700 flex-shrink-0">{folderName}</h2>
          )}
          <div className="flex-1 max-w-xl">
            <SearchBar />
          </div>
        </header>

        {/* Main content */}
        <div className="flex flex-1 min-h-0">
          {/* Email list pane */}
          <div
            className={`flex flex-col border-r border-gray-100 bg-white flex-shrink-0 ${
              selectedEmail ? 'w-80 xl:w-96' : 'flex-1'
            }`}
          >
            {activeFolderId ? (
              <EmailList onRefresh={loadEmails} />
            ) : (
              <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">
                Select a folder to view emails
              </div>
            )}
          </div>

          {/* Email view pane */}
          {selectedEmail && (
            <div className="flex-1 min-w-0 bg-white">
              <EmailView email={selectedEmail} onClose={handleCloseEmail} />
            </div>
          )}
        </div>
      </div>

      <ComposeModal />
    </div>
  )
}
