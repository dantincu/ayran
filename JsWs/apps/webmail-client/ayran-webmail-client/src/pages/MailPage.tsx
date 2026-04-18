import { useState, useEffect, useCallback } from 'react'
import { Sidebar } from '../components/layout/Sidebar'
import { EmailList } from '../components/email/EmailList'
import { EmailView } from '../components/email/EmailView'
import { ComposeModal } from '../components/compose/ComposeModal'
import { SearchBar } from '../components/search/SearchBar'
import { useEmailStore } from '../stores/emailStore'
import { useAuthStore } from '../stores/authStore'
import { fetchEmails, fetchFolders } from '../services/emailService'
import type { ComposeData } from '../types/email'

export function MailPage() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)

  const {
    selectedFolderId,
    selectedEmailId,
    currentPage,
    pageSize,
    search,
    sort,
    emails,
    setEmails,
    setFolders,
    setLoading,
    setError,
    openCompose,
    closeCompose,
    compose,
  } = useEmailStore()

  const { getActiveAccount } = useAuthStore()
  const { accounts } = useAuthStore()

  const loadFolders = useCallback(async () => {
    const account = getActiveAccount()
    if (!account) return
    try {
      const folders = await fetchFolders(account)
      setFolders(folders)
    } catch (e) {
      console.error('Failed to load folders', e)
    }
  }, [getActiveAccount, setFolders])

  const loadEmails = useCallback(async () => {
    const account = getActiveAccount()
    if (!account || !selectedFolderId) return
    setLoading(true)
    setError(null)
    try {
      const { emails: fetched, totalCount } = await fetchEmails(
        account,
        selectedFolderId,
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
  }, [getActiveAccount, selectedFolderId, currentPage, pageSize, search, sort, setEmails, setLoading, setError])

  useEffect(() => {
    loadFolders()
  }, [loadFolders, accounts])

  useEffect(() => {
    if (selectedFolderId) loadEmails()
  }, [loadEmails, selectedFolderId, currentPage, search, sort])

  const selectedEmail = selectedEmailId ? emails.find((e) => e.id === selectedEmailId) : null

  const handleCompose = () => {
    openCompose({ mode: 'compose', to: '', cc: '', bcc: '', subject: '', body: '' })
  }

  void closeCompose
  void compose

  return (
    <div className="flex h-screen bg-gray-50 overflow-hidden">
      <Sidebar
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed((v) => !v)}
        onCompose={handleCompose}
      />

      <div className="flex flex-col flex-1 min-w-0">
        {/* Top bar with search */}
        <header className="flex items-center gap-3 px-4 py-2.5 bg-white border-b border-gray-100 flex-shrink-0">
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
            {selectedFolderId ? (
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
              <EmailView
                email={selectedEmail}
                onClose={() => useEmailStore.getState().setSelectedEmail(null)}
              />
            </div>
          )}

          {/* Empty state when no email selected */}
          {!selectedEmail && selectedFolderId && (
            <div className="hidden" />
          )}
        </div>
      </div>

      {/* Compose modal */}
      <ComposeModal />
    </div>
  )
}

export type { ComposeData }
