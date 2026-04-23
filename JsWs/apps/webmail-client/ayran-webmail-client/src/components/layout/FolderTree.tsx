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

function containsId(folder: FolderType, id: string): boolean {
  return folder.children?.some((c) => c.id === id || containsId(c, id)) ?? false
}

function FolderItem({ folder, depth = 0 }: FolderItemProps) {
  const [expanded, setExpanded] = useState(false)
  const navigate = useNavigate()
  const { folderId } = useParams<{ folderId?: string }>()
  const hasChildren = (folder.children?.length ?? 0) > 0
  const Icon = FOLDER_ICONS[folder.type] ?? Tag
  const activeFolderId = folderId ? decodeURIComponent(folderId) : null
  const isSelected = activeFolderId === folder.id

  const handleToggle = () => {
    const collapsing = expanded
    setExpanded((e) => !e)
    if (collapsing && activeFolderId && containsId(folder, activeFolderId)) {
      navigate(`/mail/${encodeURIComponent(folder.id)}`)
    }
  }

  return (
    <div>
      <div
        className={`flex items-center gap-2 rounded-md text-sm transition-colors ${
          isSelected
            ? 'bg-primary-100 dark:bg-primary-900/30 text-primary-700 dark:text-primary-400 font-medium'
            : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'
        }`}
        style={{ paddingLeft: `${12 + depth * 16}px` }}
      >
        {hasChildren ? (
          <button
            onClick={handleToggle}
            className="text-gray-400 dark:text-gray-500 flex-shrink-0 p-0.5 rounded hover:text-gray-600 dark:hover:text-gray-300"
          >
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        ) : (
          <span className="w-4 flex-shrink-0" />
        )}
        <button
          onClick={() => navigate(`/mail/${encodeURIComponent(folder.id)}`)}
          className="flex items-center gap-2 flex-1 min-w-0 py-1.5 pr-3 text-left"
        >
          <Icon size={15} className={isSelected ? 'text-primary-600 dark:text-primary-400' : 'text-gray-400 dark:text-gray-500'} />
          <span className="flex-1 text-left truncate">{folder.name}</span>
          {(folder.unreadCount ?? 0) > 0 && (
            <span className="text-xs font-semibold bg-primary-500 text-white rounded-full px-1.5 py-0.5 min-w-[20px] text-center">
              {folder.unreadCount}
            </span>
          )}
        </button>
      </div>
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

function buildTree(flat: FolderType[]): FolderType[] {
  const byId = new Map(flat.map((f) => [f.id, { ...f, children: [] as FolderType[] }]))
  const roots: FolderType[] = []
  for (const folder of byId.values()) {
    if (folder.parentId && byId.has(folder.parentId)) {
      byId.get(folder.parentId)!.children!.push(folder)
    } else {
      roots.push(folder)
    }
  }
  // Sort children alphabetically at each level
  const sortChildren = (node: FolderType) => {
    node.children?.sort((a, b) => a.name.localeCompare(b.name))
    node.children?.forEach(sortChildren)
  }
  roots.forEach(sortChildren)
  return roots
}

export function FolderTree({ folders, accountLabel }: FolderTreeProps) {
  const roots = buildTree(folders)
  const systemRoots = roots.filter((f) => f.type !== 'custom')
  const customRoots = roots.filter((f) => f.type === 'custom')

  const order: FolderType['type'][] = ['inbox', 'sent', 'all', 'spam', 'trash']
  const sorted = [...systemRoots].sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type))

  return (
    <div className="py-2">
      {accountLabel && (
        <p className="px-3 py-1 text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider">
          {accountLabel}
        </p>
      )}
      {sorted.map((f) => (
        <FolderItem key={f.id} folder={f} />
      ))}
      {customRoots.length > 0 && (
        <>
          <p className="px-3 py-1 mt-2 text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider">
            Folders
          </p>
          {customRoots.sort((a, b) => a.name.localeCompare(b.name)).map((f) => (
            <FolderItem key={f.id} folder={f} />
          ))}
        </>
      )}
    </div>
  )
}
