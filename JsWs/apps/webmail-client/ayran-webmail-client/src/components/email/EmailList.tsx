import { useParams } from 'react-router-dom'
import { RefreshCw, Loader2, Users } from 'lucide-react'
import { EmailListItem } from './EmailListItem'
import { PageSelector } from '../pagination/PageSelector'
import { useEmailStore } from '../../stores/emailStore'
import type { Email } from '../../types/email'

interface GroupedEmails {
  sender: string
  emails: Email[]
}

function groupEmailsBySender(emails: Email[]): GroupedEmails[] {
  const map = new Map<string, Email[]>()
  for (const email of emails) {
    const key = email.from.email
    const existing = map.get(key) ?? []
    existing.push(email)
    map.set(key, existing)
  }
  return Array.from(map.entries()).map(([sender, emails]) => ({ sender, emails }))
}

interface EmailListProps {
  onRefresh: () => void
}

export function EmailList({ onRefresh }: EmailListProps) {
  const { emailId } = useParams<{ emailId?: string }>()
  const activeEmailId = emailId ? decodeURIComponent(emailId) : null
  const {
    emails,
    totalCount,
    currentPage,
    pageSize,
    isLoading,
    error,
    setCurrentPage,
    groupBySender,
    setGroupBySender,
  } = useEmailStore()

  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize))

  if (error) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-center p-8">
        <p className="text-red-500 font-medium mb-2">Failed to load emails</p>
        <p className="text-sm text-gray-500 mb-4">{error}</p>
        <button
          onClick={onRefresh}
          className="px-4 py-2 bg-primary-600 text-white rounded-lg text-sm hover:bg-primary-700 transition-colors"
        >
          Retry
        </button>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-gray-100 bg-white flex-shrink-0">
        <div className="flex items-center gap-2">
          <button
            onClick={onRefresh}
            disabled={isLoading}
            className="p-1.5 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors disabled:opacity-50"
            title="Refresh"
          >
            <RefreshCw size={14} className={isLoading ? 'animate-spin' : ''} />
          </button>
          <button
            onClick={() => setGroupBySender(!groupBySender)}
            className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-xs transition-colors ${
              groupBySender
                ? 'bg-primary-100 text-primary-700'
                : 'text-gray-500 hover:bg-gray-100'
            }`}
            title="Group by sender"
          >
            <Users size={13} />
            Group
          </button>
          {totalCount > 0 && (
            <span className="text-xs text-gray-400">
              {totalCount.toLocaleString()} messages
            </span>
          )}
        </div>
        <PageSelector
          currentPage={currentPage}
          totalPages={totalPages}
          onPageChange={setCurrentPage}
        />
      </div>

      {/* Email list */}
      <div className="flex-1 overflow-y-auto scrollbar-thin">
        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 size={24} className="animate-spin text-primary-500" />
          </div>
        ) : emails.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-gray-400">
            <p className="text-sm">No messages found</p>
          </div>
        ) : groupBySender ? (
          groupEmailsBySender(emails).map(({ sender, emails: group }) => (
            <div key={sender}>
              <div className="px-4 py-1.5 bg-gray-50 border-b border-gray-100 text-xs font-semibold text-gray-500 sticky top-0">
                {group[0].from.name ? `${group[0].from.name} (${sender})` : sender}
                <span className="ml-1 text-gray-400">({group.length})</span>
              </div>
              {group.map((email) => (
                <EmailListItem
                  key={email.id}
                  email={email}
                  selected={activeEmailId === email.id}
                                  />
              ))}
            </div>
          ))
        ) : (
          emails.map((email) => (
            <EmailListItem
              key={email.id}
              email={email}
              selected={activeEmailId === email.id}
                          />
          ))
        )}
      </div>
    </div>
  )
}
