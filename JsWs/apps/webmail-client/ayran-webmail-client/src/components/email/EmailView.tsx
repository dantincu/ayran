import { useState, useEffect } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  Reply, ReplyAll, Forward, Trash2, Star, MoreHorizontal, Download, Image, ImageOff, X, Loader2,
  Filter, Archive, Tag, FolderInput,
} from 'lucide-react'
import { format } from 'date-fns'
import { useEmailStore } from '../../stores/emailStore'
import { useAuthStore } from '../../stores/authStore'
import { useThemeStore } from '../../stores/themeStore'
import {
  fetchEmailFull, markEmailAsRead, moveEmailToTrash, archiveEmail, modifyEmailLabels, moveEmailToFolder,
} from '../../services/emailService'
import { FolderPickerModal } from './FolderPickerModal'
import { LabelPickerModal } from './LabelPickerModal'
import type { Email, ComposeData } from '../../types/email'

function sanitizeHtml(html: string, showImages: boolean): string {
  if (!showImages) {
    return html.replace(/<img[^>]+>/gi, (match) => {
      const srcMatch = match.match(/src="([^"]+)"/)
      const altMatch = match.match(/alt="([^"]*)"/)
      const alt = altMatch?.[1] ?? 'image'
      const src = srcMatch?.[1] ?? ''
      return `<span class="blocked-image" data-src="${src}" title="Image blocked: ${alt}">[image blocked]</span>`
    })
  }
  return html
}

function stripScripts(html: string): string {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/on\w+="[^"]*"/gi, '')
    .replace(/on\w+='[^']*'/gi, '')
    .replace(/javascript:/gi, '')
}

function buildIframeSrcdoc(bodyHtml: string, darkMode: boolean): string {
  const bgColor = darkMode ? '#1f2937' : '#ffffff'
  const textColor = darkMode ? '#d1d5db' : '#374151'
  const linkColor = darkMode ? '#60a5fa' : '#2563eb'
  const blockedBg = darkMode ? '#374151' : '#f3f4f6'
  const blockedBorder = darkMode ? '#4b5563' : '#d1d5db'
  const blockedText = darkMode ? '#6b7280' : '#9ca3af'
  return `<!DOCTYPE html><html><head><style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 14px; line-height: 1.5; margin: 0; padding: 16px; color: ${textColor}; background: ${bgColor}; }
    .blocked-image { display: inline-block; background: ${blockedBg}; border: 1px dashed ${blockedBorder}; border-radius: 4px; padding: 4px 8px; font-size: 11px; color: ${blockedText}; cursor: pointer; }
    a { color: ${linkColor}; }
    img { max-width: 100%; }
    pre { white-space: pre-wrap; word-break: break-word; }
  </style></head><body>${bodyHtml}</body></html>`
}

interface EmailViewProps {
  email: Email
  onClose?: () => void
}

export function EmailView({ email, onClose }: EmailViewProps) {
  const {
    isTrustedSender, addTrustedSender, removeTrustedSender, openCompose,
    setSearch, search, folders, removeEmails, updateEmailLabels, markAsRead,
  } = useEmailStore()
  const { getActiveAccount } = useAuthStore()
  const navigate = useNavigate()
  const { folderId } = useParams<{ folderId?: string }>()
  const [showImages, setShowImages] = useState(isTrustedSender(email.from.email))
  const [showAllHeaders, setShowAllHeaders] = useState(false)
  const [fullBody, setFullBody] = useState<{ body: string; bodyHtml?: string; attachments?: Email['attachments'] } | null>(null)
  const [bodyLoading, setBodyLoading] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [showFolderPicker, setShowFolderPicker] = useState(false)
  const [showLabelPicker, setShowLabelPicker] = useState(false)
  const [moving, setMoving] = useState(false)

  const account = getActiveAccount()
  const accountFolders = folders.filter((f) => f.accountId === account?.id)

  const trusted = isTrustedSender(email.from.email)
  const { dark: darkMode } = useThemeStore()

  useEffect(() => {
    setShowImages(isTrustedSender(email.from.email))
  }, [email.from.email, isTrustedSender])

  useEffect(() => {
    if (email.provider !== 'gmail') return
    if (email.body || email.bodyHtml) return
    const account = getActiveAccount()
    if (!account) return
    setBodyLoading(true)
    setFullBody(null)
    fetchEmailFull(account, email.id)
      .then((full) => {
        setFullBody({
          body: full.body ?? '',
          bodyHtml: full.bodyHtml,
          attachments: full.attachments,
        })
      })
      .finally(() => setBodyLoading(false))
  }, [email.id, email.provider, email.body, email.bodyHtml, getActiveAccount])

  useEffect(() => {
    if (email.isRead) return
    const account = getActiveAccount()
    if (!account) return
    markAsRead(email.id)
    markEmailAsRead(account, email.id).catch(console.error)
  }, [email.id, email.isRead, getActiveAccount, markAsRead])

  const handleTrustSender = () => {
    addTrustedSender(email.from.email)
    setShowImages(true)
  }

  const handleUntrustSender = () => {
    removeTrustedSender(email.from.email)
    setShowImages(false)
  }

  const handleDelete = async () => {
    if (!account || deleting) return
    setDeleting(true)
    try {
      await moveEmailToTrash(account, email.id)
      removeEmails([email.id])
      onClose?.()
    } catch (e) {
      console.error('Failed to delete email', e)
    } finally {
      setDeleting(false)
    }
  }

  const handleArchive = async () => {
    if (!account) return
    try {
      await archiveEmail(account, email.id)
      removeEmails([email.id])
      onClose?.()
    } catch (e) {
      console.error('Failed to archive email', e)
    }
  }

  const handleMoveToFolder = async (destFolderId: string) => {
    if (!account) return
    setMoving(true)
    setShowFolderPicker(false)
    try {
      await moveEmailToFolder(account, email.id, destFolderId)
      removeEmails([email.id])
      onClose?.()
    } catch (e) {
      console.error('Failed to move email', e)
    } finally {
      setMoving(false)
    }
  }

  const handleApplyLabels = async (addIds: string[], removeIds: string[]) => {
    if (!account || (addIds.length === 0 && removeIds.length === 0)) return
    try {
      await modifyEmailLabels(account, email.id, addIds, removeIds)
      updateEmailLabels(email.id, addIds, removeIds)
    } catch (e) {
      console.error('Failed to modify labels', e)
    }
  }

  const isFilteredBySender = search.from === email.from?.email

  const handleFilterBySender = () => {
    if (isFilteredBySender) {
      setSearch({ ...search, from: undefined })
    } else {
      setSearch({ ...search, from: email.from?.email })
    }
    if (folderId) navigate(`/mail/${folderId}`)
  }

  const buildComposeData = (mode: ComposeData['mode']): ComposeData => {
    switch (mode) {
      case 'reply':
        return {
          mode: 'reply',
          to: email.from.email,
          cc: '',
          bcc: '',
          subject: email.subject.startsWith('Re:') ? email.subject : `Re: ${email.subject}`,
          body: `\n\n---\nOn ${format(email.date, 'PPP')} ${email.from.name ?? email.from.email} wrote:\n${email.body}`,
          inReplyTo: email.inReplyTo ?? email.id,
          references: [...(email.references ?? []), email.id],
          originalEmail: email,
        }
      case 'replyAll':
        return {
          mode: 'replyAll',
          to: [email.from.email, ...email.to.map((a) => a.email)].join(', '),
          cc: email.cc.map((a) => a.email).join(', '),
          bcc: '',
          subject: email.subject.startsWith('Re:') ? email.subject : `Re: ${email.subject}`,
          body: `\n\n---\nOn ${format(email.date, 'PPP')} ${email.from.name ?? email.from.email} wrote:\n${email.body}`,
          inReplyTo: email.inReplyTo ?? email.id,
          references: [...(email.references ?? []), email.id],
          originalEmail: email,
        }
      case 'forward':
        return {
          mode: 'forward',
          to: '',
          cc: '',
          bcc: '',
          subject: email.subject.startsWith('Fwd:') ? email.subject : `Fwd: ${email.subject}`,
          body: `\n\n---\nForwarded message\nFrom: ${email.from.name ?? email.from.email} <${email.from.email}>\nDate: ${format(email.date, 'PPPp')}\nSubject: ${email.subject}\nTo: ${email.to.map((a) => a.email).join(', ')}\n\n${email.body}`,
          originalEmail: email,
        }
      default:
        return { mode: 'compose', to: '', cc: '', bcc: '', subject: '', body: '' }
    }
  }

  const resolvedBodyHtml = fullBody?.bodyHtml ?? email.bodyHtml
  const resolvedBody = fullBody?.body ?? email.body
  const resolvedAttachments = fullBody?.attachments ?? email.attachments
  const bodyHtml = resolvedBodyHtml
    ? sanitizeHtml(stripScripts(resolvedBodyHtml), showImages)
    : null

  const iframeSrcdoc = bodyHtml ? buildIframeSrcdoc(bodyHtml, darkMode) : null


  return (
    <div className="flex flex-col h-full bg-white dark:bg-gray-800">
      {/* Header toolbar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-gray-100 dark:border-gray-700 flex-shrink-0">
        <div className="flex items-center gap-1">
          <button
            onClick={() => openCompose(buildComposeData('reply'))}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
            title="Reply"
          >
            <Reply size={14} /> Reply
          </button>
          <button
            onClick={() => openCompose(buildComposeData('replyAll'))}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
            title="Reply all"
          >
            <ReplyAll size={14} /> Reply all
          </button>
          <button
            onClick={() => openCompose(buildComposeData('forward'))}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
            title="Forward"
          >
            <Forward size={14} /> Forward
          </button>
          <div className="w-px h-4 bg-gray-200 dark:bg-gray-600 mx-1" />

          {/* Gmail-specific actions */}
          {email.provider === 'gmail' && (
            <>
              <button
                onClick={handleArchive}
                className="p-1.5 rounded-md text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                title="Archive"
              >
                <Archive size={14} />
              </button>
              <button
                onClick={() => { setShowLabelPicker((v) => !v); setShowFolderPicker(false) }}
                className="p-1.5 rounded-md text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                title="Labels"
              >
                <Tag size={14} />
              </button>
              {showLabelPicker && (
                <LabelPickerModal
                  folders={accountFolders}
                  currentLabelIds={email.labels}
                  onApply={handleApplyLabels}
                  onClose={() => setShowLabelPicker(false)}
                />
              )}
            </>
          )}

          {/* Outlook-specific actions */}
          {email.provider === 'outlook' && (
            <>
              <button
                onClick={() => { setShowFolderPicker((v) => !v); setShowLabelPicker(false) }}
                disabled={moving}
                className="p-1.5 rounded-md text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors disabled:opacity-50"
                title="Move to folder"
              >
                {moving ? <Loader2 size={14} className="animate-spin" /> : <FolderInput size={14} />}
              </button>
              {showFolderPicker && (
                <FolderPickerModal
                  folders={accountFolders}
                  currentFolderId={email.folderId}
                  onSelect={handleMoveToFolder}
                  onClose={() => setShowFolderPicker(false)}
                />
              )}
            </>
          )}

          <button
            onClick={handleDelete}
            disabled={deleting}
            className="p-1.5 rounded-md text-gray-400 dark:text-gray-500 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors disabled:opacity-50"
            title="Move to trash"
          >
            {deleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
          </button>
          <button
            className="p-1.5 rounded-md text-gray-400 dark:text-gray-500 hover:text-yellow-400 hover:bg-yellow-50 dark:hover:bg-yellow-900/20 transition-colors"
            title="Star"
          >
            <Star size={14} fill={email.isStarred ? 'currentColor' : 'none'} className={email.isStarred ? 'text-yellow-400' : ''} />
          </button>
          <button
            className="p-1.5 rounded-md text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
            title="More"
          >
            <MoreHorizontal size={14} />
          </button>
        </div>
        {onClose && (
          <button
            onClick={onClose}
            className="p-1.5 rounded-md text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
          >
            <X size={14} />
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin">
        {/* Subject */}
        <div className="px-6 pt-5 pb-3">
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{email.subject || '(no subject)'}</h1>
        </div>

        {/* Sender info */}
        <div className="px-6 pb-4 border-b border-gray-100 dark:border-gray-700">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-full bg-primary-100 dark:bg-primary-900/30 text-primary-700 dark:text-primary-400 flex items-center justify-center text-sm font-semibold flex-shrink-0">
                  {(email.from?.name ?? email.from?.email ?? '?')[0]?.toUpperCase() ?? '?'}
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <p className="font-medium text-sm text-gray-900 dark:text-gray-100">
                      {email.from?.name ?? email.from?.email ?? '(unknown sender)'}
                    </p>
                    {email.from?.email && (
                      <button
                        onClick={handleFilterBySender}
                        title={isFilteredBySender ? 'Clear sender filter' : `Show all mail from ${email.from.email}`}
                        className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-xs transition-colors ${
                          isFilteredBySender
                            ? 'bg-primary-100 dark:bg-primary-900/30 text-primary-700 dark:text-primary-400 hover:bg-primary-200 dark:hover:bg-primary-900/50'
                            : 'text-gray-400 dark:text-gray-500 hover:text-primary-600 dark:hover:text-primary-400 hover:bg-primary-50 dark:hover:bg-primary-900/20'
                        }`}
                      >
                        <Filter size={10} />
                        {isFilteredBySender ? 'Filtered' : 'Filter'}
                      </button>
                    )}
                  </div>
                  {email.from?.name && email.from?.email && (
                    <p className="text-xs text-gray-400 dark:text-gray-500">&lt;{email.from.email}&gt;</p>
                  )}
                </div>
              </div>
              {showAllHeaders && (
                <div className="mt-2 ml-10 text-xs text-gray-500 dark:text-gray-400 space-y-0.5">
                  {email.to.length > 0 && (
                    <p>To: {email.to.map((a) => a.name ? `${a.name} <${a.email}>` : a.email).join(', ')}</p>
                  )}
                  {email.cc.length > 0 && (
                    <p>Cc: {email.cc.map((a) => a.name ? `${a.name} <${a.email}>` : a.email).join(', ')}</p>
                  )}
                </div>
              )}
              <button
                onClick={() => setShowAllHeaders((v) => !v)}
                className="ml-10 mt-1 text-xs text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300"
              >
                {showAllHeaders ? 'Hide details' : `To: ${email.to.map((a) => a.email).join(', ')}`}
              </button>
            </div>
            <div className="text-xs text-gray-400 dark:text-gray-500 flex-shrink-0 text-right">
              <p>{format(email.date, 'PPPp')}</p>
            </div>
          </div>
        </div>

        {/* Image blocking banner */}
        {resolvedBodyHtml && !showImages && (
          <div className="mx-6 mt-3 flex items-center justify-between bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 rounded-lg px-3 py-2">
            <div className="flex items-center gap-2 text-sm text-amber-700 dark:text-amber-400">
              <ImageOff size={14} />
              <span>Images from this sender are blocked.</span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowImages(true)}
                className="text-xs text-amber-700 dark:text-amber-400 underline hover:no-underline"
              >
                Show once
              </button>
              <button
                onClick={handleTrustSender}
                className="text-xs bg-amber-600 text-white px-2 py-0.5 rounded hover:bg-amber-700 transition-colors"
              >
                Always show
              </button>
            </div>
          </div>
        )}

        {trusted && (
          <div className="mx-6 mt-3 flex items-center justify-between bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-700 rounded-lg px-3 py-2">
            <div className="flex items-center gap-2 text-sm text-green-700 dark:text-green-400">
              <Image size={14} />
              <span>Images from {email.from?.email ?? 'this sender'} are always shown.</span>
            </div>
            <button
              onClick={handleUntrustSender}
              className="text-xs text-green-700 dark:text-green-400 underline hover:no-underline"
            >
              Revoke
            </button>
          </div>
        )}

        {/* Body */}
        <div className="px-6 py-4">
          {bodyLoading ? (
            <div className="flex items-center gap-2 text-gray-400 dark:text-gray-500 py-8">
              <Loader2 size={16} className="animate-spin" />
              <span className="text-sm">Loading message…</span>
            </div>
          ) : iframeSrcdoc ? (
            <iframe
              srcDoc={iframeSrcdoc}
              sandbox="allow-same-origin"
              className="w-full border-0 block"
              style={{ minHeight: '200px' }}
              title="Email body"
              onLoad={(e) => {
                const iframe = e.currentTarget
                if (iframe.contentDocument?.body) {
                  iframe.style.height = iframe.contentDocument.body.scrollHeight + 32 + 'px'
                }
              }}
            />
          ) : (
            <pre className="whitespace-pre-wrap text-sm text-gray-700 dark:text-gray-300 font-sans leading-relaxed">
              {resolvedBody}
            </pre>
          )}
        </div>

        {/* Attachments */}
        {resolvedAttachments.length > 0 && (
          <div className="px-6 pb-6">
            <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">
              Attachments ({resolvedAttachments.length})
            </p>
            <div className="flex flex-wrap gap-2">
              {resolvedAttachments.map((att) => (
                <div
                  key={att.id}
                  className="flex items-center gap-2 px-3 py-2 bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-600 transition-colors cursor-pointer"
                >
                  <div className="text-gray-400 dark:text-gray-500">
                    <Download size={14} />
                  </div>
                  <div>
                    <p className="text-xs font-medium text-gray-700 dark:text-gray-300 max-w-[160px] truncate">
                      {att.filename}
                    </p>
                    <p className="text-xs text-gray-400 dark:text-gray-500">
                      {att.size > 1024 * 1024
                        ? `${(att.size / 1024 / 1024).toFixed(1)} MB`
                        : `${(att.size / 1024).toFixed(0)} KB`}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
