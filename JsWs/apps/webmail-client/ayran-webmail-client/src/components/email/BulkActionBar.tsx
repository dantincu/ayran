import { useState } from 'react'
import { Trash2, Archive, Tag, FolderInput, X, Loader2 } from 'lucide-react'
import { useParams, useNavigate } from 'react-router-dom'
import { useEmailStore } from '../../stores/emailStore'
import { useAuthStore } from '../../stores/authStore'
import {
  batchMoveEmailsToTrash,
  batchArchiveEmails,
  batchModifyEmailLabels,
  batchMoveEmailsToFolder,
} from '../../services/emailService'
import { FolderPickerModal } from './FolderPickerModal'
import { LabelPickerModal } from './LabelPickerModal'

export function BulkActionBar() {
  const { checkedEmailIds, emails, folders, clearChecked, setChecked, removeEmails } = useEmailStore()
  const { getActiveAccount } = useAuthStore()
  const navigate = useNavigate()
  const { folderId, emailId } = useParams<{ folderId?: string; emailId?: string }>()

  const [busy, setBusy] = useState(false)
  const [showFolderPicker, setShowFolderPicker] = useState(false)
  const [showLabelPicker, setShowLabelPicker] = useState(false)

  const account = getActiveAccount()
  if (!account || checkedEmailIds.length === 0) return null

  const activeFolderId = folderId ? decodeURIComponent(folderId) : null
  const activeEmailId = emailId ? decodeURIComponent(emailId) : null
  const allVisibleIds = emails.map((e) => e.id)
  const allSelected = checkedEmailIds.length === allVisibleIds.length
  const provider = emails.find((e) => checkedEmailIds.includes(e.id))?.provider ?? account.provider
  const accountFolders = folders.filter((f) => f.accountId === account.id)

  const afterBulk = (ids: string[]) => {
    removeEmails(ids)
    if (activeEmailId && ids.includes(activeEmailId) && activeFolderId) {
      navigate(`/mail/${encodeURIComponent(activeFolderId)}`)
    }
  }

  const run = async (fn: () => Promise<void>, removeAfter = true) => {
    if (busy) return
    setBusy(true)
    try {
      await fn()
      if (removeAfter) afterBulk([...checkedEmailIds])
      else clearChecked()
    } catch (e) {
      console.error('Bulk action failed', e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex items-center gap-1.5 px-4 py-2 bg-primary-50 dark:bg-primary-900/20 border-b border-primary-100 dark:border-primary-900/40 flex-shrink-0 flex-wrap">
      <button
        onClick={clearChecked}
        className="p-1 rounded text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300 transition-colors"
        title="Clear selection"
      >
        <X size={13} />
      </button>

      <span className="text-sm font-medium text-primary-700 dark:text-primary-400 mr-1">
        {checkedEmailIds.length} selected
      </span>

      <button
        onClick={() => setChecked(allSelected ? [] : allVisibleIds)}
        className="text-xs text-primary-600 dark:text-primary-400 hover:underline"
      >
        {allSelected ? 'Deselect all' : 'Select all'}
      </button>

      <div className="flex-1" />

      {busy && <Loader2 size={13} className="animate-spin text-gray-400 flex-shrink-0" />}

      {provider === 'gmail' && (
        <>
          <button
            onClick={() => run(() => batchArchiveEmails(account, [...checkedEmailIds]))}
            disabled={busy}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded text-sm text-gray-600 dark:text-gray-300 hover:bg-primary-100 dark:hover:bg-primary-900/40 transition-colors disabled:opacity-50"
            title="Archive"
          >
            <Archive size={13} /> Archive
          </button>

          <button
            onClick={() => { setShowLabelPicker((v) => !v); setShowFolderPicker(false) }}
            disabled={busy}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded text-sm text-gray-600 dark:text-gray-300 hover:bg-primary-100 dark:hover:bg-primary-900/40 transition-colors disabled:opacity-50"
            title="Change labels"
          >
            <Tag size={13} /> Labels
          </button>
          {showLabelPicker && (
            <LabelPickerModal
              folders={accountFolders}
              currentLabelIds={[]}
              onApply={(addIds, removeIds) =>
                run(() => batchModifyEmailLabels(account, [...checkedEmailIds], addIds, removeIds), false)
              }
              onClose={() => setShowLabelPicker(false)}
            />
          )}
        </>
      )}

      {(provider === 'outlook' || provider === 'yahoo') && (
        <>
          <button
            onClick={() => { setShowFolderPicker((v) => !v); setShowLabelPicker(false) }}
            disabled={busy}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded text-sm text-gray-600 dark:text-gray-300 hover:bg-primary-100 dark:hover:bg-primary-900/40 transition-colors disabled:opacity-50"
            title="Move to folder"
          >
            <FolderInput size={13} /> Move to
          </button>
          {showFolderPicker && (
            <FolderPickerModal
              folders={accountFolders}
              currentFolderId={activeFolderId ?? undefined}
              onSelect={(destId) =>
                run(() => batchMoveEmailsToFolder(account, [...checkedEmailIds], destId))
              }
              onClose={() => setShowFolderPicker(false)}
            />
          )}
        </>
      )}

      <button
        onClick={() => run(() => batchMoveEmailsToTrash(account, [...checkedEmailIds]))}
        disabled={busy}
        className="flex items-center gap-1.5 px-2.5 py-1 rounded text-sm text-red-500 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors disabled:opacity-50"
        title="Delete"
      >
        <Trash2 size={13} /> Delete
      </button>
    </div>
  )
}
