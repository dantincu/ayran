import { useState, useRef } from 'react'
import { Search, Check } from 'lucide-react'
import type { Folder } from '../../types/folder'
import { useClickOutside } from '../../hooks/useClickOutside'

interface Props {
  folders: Folder[]
  currentLabelIds: string[]
  onApply: (addIds: string[], removeIds: string[]) => void
  onClose: () => void
}

const PICKABLE_SYSTEM = new Set(['STARRED', 'IMPORTANT'])

export function LabelPickerPopover({ folders, currentLabelIds, onApply, onClose }: Props) {
  const [search, setSearch] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  useClickOutside(ref, onClose)

  const pickable = folders.filter((f) => f.type === 'custom' || PICKABLE_SYSTEM.has(f.id))
  const filtered = search.trim()
    ? pickable.filter((f) => f.name.toLowerCase().includes(search.toLowerCase()))
    : pickable

  const [checked, setChecked] = useState<Set<string>>(() => new Set(currentLabelIds))

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
    <div
      ref={ref}
      className="absolute z-50 top-full left-0 mt-1 w-52 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg overflow-hidden"
    >
      <div className="p-2 border-b border-gray-100 dark:border-gray-700">
        <div className="relative">
          <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            autoFocus
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search labels…"
            className="w-full pl-6 pr-2 py-1 text-sm bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded focus:outline-none focus:ring-1 focus:ring-primary-500 text-gray-700 dark:text-gray-200 placeholder-gray-400"
          />
        </div>
      </div>
      <div className="max-h-48 overflow-y-auto scrollbar-thin py-1">
        {filtered.length === 0 ? (
          <p className="px-3 py-3 text-xs text-gray-400 dark:text-gray-500 text-center">No labels found</p>
        ) : (
          filtered.map((label) => {
            const isChecked = checked.has(label.id)
            return (
              <button
                key={label.id}
                onClick={() => toggle(label.id)}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
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
                <span className="truncate">{label.name}</span>
              </button>
            )
          })
        )}
      </div>
      <div className="p-2 border-t border-gray-100 dark:border-gray-700">
        <button
          onClick={handleApply}
          className="w-full py-1.5 bg-primary-600 hover:bg-primary-700 text-white text-sm rounded-md transition-colors"
        >
          Apply
        </button>
      </div>
    </div>
  )
}
