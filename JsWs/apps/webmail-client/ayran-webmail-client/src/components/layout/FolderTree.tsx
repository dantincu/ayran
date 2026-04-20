import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  Inbox, Send, Archive, Trash2, AlertOctagon, Folder, ChevronRight, ChevronDown, Tag,
} from 'lucide-react'
import type { Folder as FolderType } from '../../types/folder'

const FOLDER_ICONS: Record<FolderType['type'], typeof Inbox> = {
  inbox: Inbox,
  sent: Send,
  all: Archive,
  trash: Trash2,
  spam: AlertOctagon,
  custom: Folder,
}

interface FolderItemProps {
  folder: FolderType
  depth?: number
}

function FolderItem({ folder, depth = 0 }: FolderItemProps) {
  const [expanded, setExpanded] = useState(false)
  const navigate = useNavigate()
  const { folderId } = useParams<{ folderId?: string }>()
  const hasChildren = (folder.children?.length ?? 0) > 0
  const Icon = FOLDER_ICONS[folder.type] ?? Tag
  const isSelected = folderId ? decodeURIComponent(folderId) === folder.id : false

  return (
    <div>
      <button
        onClick={() => {
          navigate(`/mail/${encodeURIComponent(folder.id)}`)
          if (hasChildren) setExpanded((e) => !e)
        }}
        className={`w-full flex items-center gap-2 px-3 py-1.5 rounded-md text-sm transition-colors group ${
          isSelected
            ? 'bg-primary-100 text-primary-700 font-medium'
            : 'text-gray-700 hover:bg-gray-100'
        }`}
        style={{ paddingLeft: `${12 + depth * 16}px` }}
      >
        {hasChildren ? (
          <span className="text-gray-400">
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </span>
        ) : (
          <span className="w-3.5" />
        )}
        <Icon size={15} className={isSelected ? 'text-primary-600' : 'text-gray-400'} />
        <span className="flex-1 text-left truncate">{folder.name}</span>
        {(folder.unreadCount ?? 0) > 0 && (
          <span className="text-xs font-semibold bg-primary-500 text-white rounded-full px-1.5 py-0.5 min-w-[20px] text-center">
            {folder.unreadCount}
          </span>
        )}
      </button>
      {hasChildren && expanded && (
        <div>
          {folder.children!.map((child) => (
            <FolderItem key={child.id} folder={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  )
}

interface FolderTreeProps {
  folders: FolderType[]
  accountLabel?: string
}

export function FolderTree({ folders, accountLabel }: FolderTreeProps) {
  const systemFolders = folders.filter((f) => f.type !== 'custom')
  const customFolders = folders.filter((f) => f.type === 'custom')

  const order: FolderType['type'][] = ['inbox', 'sent', 'all', 'spam', 'trash']
  const sorted = [...systemFolders].sort(
    (a, b) => order.indexOf(a.type) - order.indexOf(b.type)
  )

  return (
    <div className="py-2">
      {accountLabel && (
        <p className="px-3 py-1 text-xs font-semibold text-gray-400 uppercase tracking-wider">
          {accountLabel}
        </p>
      )}
      {sorted.map((f) => (
        <FolderItem key={f.id} folder={f} />
      ))}
      {customFolders.length > 0 && (
        <>
          <p className="px-3 py-1 mt-2 text-xs font-semibold text-gray-400 uppercase tracking-wider">
            Labels
          </p>
          {customFolders.map((f) => (
            <FolderItem key={f.id} folder={f} />
          ))}
        </>
      )}
    </div>
  )
}
