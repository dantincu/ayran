import { useState } from 'react'
import { Search, Folder, X, Maximize2, Minimize2 } from 'lucide-react'
import type { Folder as FolderType } from '../../types/folder'

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

export function FolderPickerModal({ folders, currentFolderId, onSelect, onClose }: Props) {
  const [search, setSearch] = useState('')
  const [maximized, setMaximized] = useState(false)

  const flat = buildAndFlatten(folders)
  const filtered = search.trim()
    ? flat.filter(({ folder }) => folder.name.toLowerCase().includes(search.toLowerCase()))
    : flat

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-40 bg-black/30 dark:bg-black/50" onClick={onClose} />

      {/* Modal */}
      <div
        className={`fixed z-50 flex flex-col bg-white dark:bg-gray-800 rounded-xl shadow-2xl border border-gray-200 dark:border-gray-700 ${
          maximized
            ? 'inset-4'
            : 'top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-96 max-h-[70vh]'
        }`}
      >
        {/* Title bar */}
        <div className="flex items-center justify-between px-4 py-2.5 bg-gray-800 dark:bg-gray-900 rounded-t-xl flex-shrink-0">
          <h3 className="text-sm font-medium text-white">Move to Folder</h3>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setMaximized((v) => !v)}
              className="p-1 rounded text-gray-300 hover:text-white hover:bg-gray-700 transition-colors"
              title={maximized ? 'Restore' : 'Maximize'}
            >
              {maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </button>
            <button
              onClick={onClose}
              className="p-1 rounded text-gray-300 hover:text-white hover:bg-gray-700 transition-colors"
              title="Close"
            >
              <X size={14} />
            </button>
          </div>
        </div>

        {/* Search */}
        <div className="p-3 border-b border-gray-100 dark:border-gray-700 flex-shrink-0">
          <div className="relative">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              autoFocus
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search folders…"
              className="w-full pl-8 pr-3 py-1.5 text-sm bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-md focus:outline-none focus:ring-1 focus:ring-primary-500 text-gray-700 dark:text-gray-200 placeholder-gray-400"
            />
          </div>
        </div>

        {/* Folder list */}
        <div className="flex-1 overflow-y-auto scrollbar-thin py-1 min-h-0">
          {filtered.length === 0 ? (
            <p className="px-4 py-6 text-sm text-gray-400 dark:text-gray-500 text-center">No folders found</p>
          ) : (
            filtered.map(({ folder, depth }) => (
              <button
                key={folder.id}
                onClick={() => { onSelect(folder.id); onClose() }}
                disabled={folder.id === currentFolderId}
                style={{ paddingLeft: `${12 + (search ? 0 : depth * 16)}px` }}
                className={`w-full flex items-center gap-2 py-2 pr-4 text-sm text-left transition-colors ${
                  folder.id === currentFolderId
                    ? 'text-gray-300 dark:text-gray-600 cursor-default'
                    : 'text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'
                }`}
              >
                <Folder size={13} className="flex-shrink-0 text-gray-400 dark:text-gray-500" />
                <span className="truncate">{folder.name}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </>
  )
}
