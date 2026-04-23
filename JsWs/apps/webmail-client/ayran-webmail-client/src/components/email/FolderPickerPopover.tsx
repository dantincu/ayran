import { useState, useRef } from 'react'
import { Search, Folder } from 'lucide-react'
import type { Folder as FolderType } from '../../types/folder'
import { useClickOutside } from '../../hooks/useClickOutside'

interface Props {
  folders: FolderType[]
  currentFolderId?: string
  onSelect: (folderId: string) => void
  onClose: () => void
}

function buildAndFlatten(flat: FolderType[]): { folder: FolderType; depth: number }[] {
  const byId = new Map(flat.map((f) => [f.id, { ...f, children: [] as FolderType[] }]))
  const roots: FolderType[] = []
  for (const f of byId.values()) {
    if (f.parentId && byId.has(f.parentId)) byId.get(f.parentId)!.children!.push(f)
    else roots.push(f)
  }

  const result: { folder: FolderType; depth: number }[] = []
  function traverse(nodes: FolderType[], depth: number) {
    for (const n of nodes.sort((a, b) => {
      // System folders first
      if (a.type !== 'custom' && b.type === 'custom') return -1
      if (a.type === 'custom' && b.type !== 'custom') return 1
      return a.name.localeCompare(b.name)
    })) {
      result.push({ folder: n, depth })
      if (n.children?.length) traverse(n.children, depth + 1)
    }
  }
  traverse(roots, 0)
  return result
}

export function FolderPickerPopover({ folders, currentFolderId, onSelect, onClose }: Props) {
  const [search, setSearch] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  useClickOutside(ref, onClose)

  const flat = buildAndFlatten(folders)
  const filtered = search.trim()
    ? flat.filter(({ folder }) => folder.name.toLowerCase().includes(search.toLowerCase()))
    : flat

  return (
    <div
      ref={ref}
      className="absolute z-50 top-full left-0 mt-1 w-56 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg overflow-hidden"
    >
      <div className="p-2 border-b border-gray-100 dark:border-gray-700">
        <div className="relative">
          <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            autoFocus
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search folders…"
            className="w-full pl-6 pr-2 py-1 text-sm bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded focus:outline-none focus:ring-1 focus:ring-primary-500 text-gray-700 dark:text-gray-200 placeholder-gray-400"
          />
        </div>
      </div>
      <div className="max-h-52 overflow-y-auto scrollbar-thin py-1">
        {filtered.length === 0 ? (
          <p className="px-3 py-3 text-xs text-gray-400 dark:text-gray-500 text-center">No folders found</p>
        ) : (
          filtered.map(({ folder, depth }) => (
            <button
              key={folder.id}
              onClick={() => { onSelect(folder.id); onClose() }}
              disabled={folder.id === currentFolderId}
              style={{ paddingLeft: `${8 + (search ? 0 : depth * 14)}px` }}
              className={`w-full flex items-center gap-2 py-1.5 pr-3 text-sm text-left transition-colors ${
                folder.id === currentFolderId
                  ? 'text-gray-300 dark:text-gray-600 cursor-default'
                  : 'text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'
              }`}
            >
              <Folder size={12} className="flex-shrink-0 text-gray-400" />
              <span className="truncate">{folder.name}</span>
            </button>
          ))
        )}
      </div>
    </div>
  )
}
