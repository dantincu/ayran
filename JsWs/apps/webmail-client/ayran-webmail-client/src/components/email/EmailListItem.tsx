import { useNavigate, useParams } from 'react-router-dom'
import { Star, Paperclip } from 'lucide-react'
import { format, isToday, isThisYear } from 'date-fns'
import type { Email } from '../../types/email'
import { useEmailStore } from '../../stores/emailStore'

interface EmailListItemProps {
  email: Email
  selected: boolean
}

function formatDate(date: Date): string {
  if (isToday(date)) return format(date, 'HH:mm')
  if (isThisYear(date)) return format(date, 'MMM d')
  return format(date, 'MM/dd/yy')
}

export function EmailListItem({ email, selected }: EmailListItemProps) {
  const { toggleStar } = useEmailStore()
  const navigate = useNavigate()
  const { folderId } = useParams<{ folderId?: string }>()

  const handleClick = () => {
    if (folderId) {
      navigate(`/mail/${folderId}/${encodeURIComponent(email.id)}`)
    }
  }

  return (
    <div
      onClick={handleClick}
      className={`flex items-start gap-3 px-4 py-3 cursor-pointer border-b border-gray-100 dark:border-gray-700 transition-colors ${
        selected
          ? 'bg-primary-50 dark:bg-primary-900/20 border-l-2 border-l-primary-500'
          : 'hover:bg-gray-50 dark:hover:bg-gray-700'
      } ${!email.isRead ? 'bg-white dark:bg-gray-800' : 'bg-gray-50/30 dark:bg-gray-800/50'}`}
    >
      {/* Unread dot */}
      <div className="flex flex-col items-center pt-1 gap-2 flex-shrink-0">
        <div
          className={`w-2 h-2 rounded-full flex-shrink-0 ${
            !email.isRead ? 'bg-primary-500' : 'bg-transparent'
          }`}
        />
        <button
          onClick={(e) => {
            e.stopPropagation()
            toggleStar(email.id)
          }}
          className={`transition-colors ${
            email.isStarred ? 'text-yellow-400' : 'text-gray-200 dark:text-gray-600 hover:text-yellow-300'
          }`}
        >
          <Star size={13} fill={email.isStarred ? 'currentColor' : 'none'} />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2 mb-0.5">
          <span
            className={`text-sm truncate ${
              !email.isRead
                ? 'font-semibold text-gray-900 dark:text-gray-100'
                : 'font-medium text-gray-700 dark:text-gray-300'
            }`}
          >
            {email.from.name ?? email.from.email}
          </span>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            {email.attachments.length > 0 && (
              <Paperclip size={12} className="text-gray-400 dark:text-gray-500" />
            )}
            <span className="text-xs text-gray-400 dark:text-gray-500 whitespace-nowrap">
              {formatDate(email.date)}
            </span>
          </div>
        </div>
        <p
          className={`text-sm truncate mb-0.5 ${
            !email.isRead ? 'text-gray-800 dark:text-gray-200' : 'text-gray-600 dark:text-gray-400'
          }`}
        >
          {email.subject || '(no subject)'}
        </p>
        <p className="text-xs text-gray-400 dark:text-gray-500 line-clamp-1">{email.snippet}</p>
      </div>
    </div>
  )
}
