import { useState } from 'react'
import { Search, Check, X, Maximize2, Minimize2 } from 'lucide-react'
import type { Folder } from '../../types/folder'

interface Props {
  folders: Folder[]
  currentLabelIds: string[]
  onApply: (addIds: string[], removeIds: string[]) => void
  onClose: () => void
}

const PICKABLE_SYSTEM = new Set(['STARRED', 'IMPORTANT'])

function buildAndFlatten(flat: Folder[]): { folder: Folder; depth: number }[] {
  const byId = new Map(flat.map((f) => [f.id, { ...f, children: [] as Folder[] }]))
  const roots: Folder[] = []
  for (const f of byId.values()) {
    if (f.parentId && byId.has(f.parentId)) byId.get(f.parentId)!.children!.push(f)
    else roots.push(f)
  }

  const result: { folder: Folder; depth: number }[] = []
  function traverse(nodes: Folder[], depth: number) {
    for (const n of nodes.sort((a, b) => a.name.localeCompare(b.name))) {
      result.push({ folder: n, depth })
      if (n.children?.length) traverse(n.children, depth + 1)
    }
  }
  // System labels first, then custom tree
  traverse(roots.filter((f) => f.type !== 'custom'), 0)
  traverse(roots.filter((f) => f.type === 'custom'), 0)
  return result
}

export function LabelPickerModal({ folders, currentLabelIds, onApply, onClose }: Props) {
  const [search, setSearch] = useState('')
  const [maximized, setMaximized] = useState(false)
  const [checked, setChecked] = useState<Set<string>>(() => new Set(currentLabelIds))

  const pickable = folders.filter((f) => f.type === 'custom' || PICKABLE_SYSTEM.has(f.id))
  const flat = buildAndFlatten(pickable)
  const filtered = search.trim()
    ? flat.filter(({ folder }) => folder.name.toLowerCase().includes(search.toLowerCase()))
    : flat

  const toggle = (id: string) =>
    setChecked((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })

  const handleApply = () => {
    const addIds = [...checked].filter((id) => !currentLabelIds.includes(id))
    const removeIds = currentLabelIds.filter((id) => pickable.some((f) => f.id === id) && !checked.has(id))
    onApply(addIds, removeIds)
    onClose()
  }

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
          <h3 className="text-sm font-medium text-white">Apply Labels</h3>
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
              placeholder="Search labels…"
              className="w-full pl-8 pr-3 py-1.5 text-sm bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-md focus:outline-none focus:ring-1 focus:ring-primary-500 text-gray-700 dark:text-gray-200 placeholder-gray-400"
            />
          </div>
        </div>

        {/* Label list */}
        <div className="flex-1 overflow-y-auto scrollbar-thin py-1 min-h-0">
          {filtered.length === 0 ? (
            <p className="px-4 py-6 text-sm text-gray-400 dark:text-gray-500 text-center">No labels found</p>
          ) : (
            filtered.map(({ folder, depth }) => {
              const isChecked = checked.has(folder.id)
              return (
                <button
                  key={folder.id}
                  onClick={() => toggle(folder.id)}
                  style={{ paddingLeft: `${12 + (search ? 0 : depth * 16)}px` }}
                  className="w-full flex items-center gap-3 pr-4 py-2 text-sm text-left text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
                >
                  <div
                    className={`w-3.5 h-3.5 rounded border flex items-center justify-center flex-shrink-0 transition-colors ${
                      isChecked
                        ? 'bg-primary-500 border-primary-500'
                        : 'border-gray-300 dark:border-gray-500'
                    }`}
                  >
                    {isChecked && <Check size={9} className="text-white" />}
                  </div>
                  <span className="truncate">{folder.name}</span>
                </button>
              )
            })
          )}
        </div>

        {/* Footer */}
        <div className="p-3 border-t border-gray-100 dark:border-gray-700 flex-shrink-0">
          <button
            onClick={handleApply}
            className="w-full py-1.5 bg-primary-600 hover:bg-primary-700 text-white text-sm font-medium rounded-md transition-colors"
          >
            Apply
          </button>
        </div>
      </div>
    </>
  )
}
