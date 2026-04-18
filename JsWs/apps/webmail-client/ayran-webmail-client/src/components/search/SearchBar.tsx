import { useState } from 'react'
import { Search, SlidersHorizontal, X, ArrowUpDown } from 'lucide-react'
import { useEmailStore } from '../../stores/emailStore'
import type { SearchParams, SortField, SortDirection } from '../../types/email'

export function SearchBar() {
  const { search, setSearch, sort, setSort } = useEmailStore()
  const [expanded, setExpanded] = useState(false)
  const [local, setLocal] = useState<SearchParams>(search)

  const hasActiveSearch = Object.values(search).some((v) => v !== undefined && v !== '' && v !== false)

  const handleApply = () => {
    setSearch(local)
    setExpanded(false)
  }

  const handleClear = () => {
    const empty: SearchParams = {}
    setLocal(empty)
    setSearch(empty)
  }

  const handleQuickSearch = (q: string) => {
    if (!q.trim()) {
      handleClear()
      return
    }
    const s: SearchParams = { subject: q }
    setLocal(s)
    setSearch(s)
  }

  return (
    <div className="relative">
      <div className="flex items-center gap-2">
        {/* Quick search input */}
        <div className="relative flex-1">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
          <input
            type="text"
            value={local.subject ?? ''}
            onChange={(e) => setLocal((l) => ({ ...l, subject: e.target.value }))}
            onKeyDown={(e) => e.key === 'Enter' && handleQuickSearch(local.subject ?? '')}
            placeholder="Search emails…"
            className="w-full pl-8 pr-8 py-1.5 text-sm bg-gray-100 rounded-lg border border-transparent focus:outline-none focus:border-primary-300 focus:bg-white transition-colors"
          />
          {(local.subject) && (
            <button
              onClick={handleClear}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
            >
              <X size={12} />
            </button>
          )}
        </div>

        {/* Advanced filters toggle */}
        <button
          onClick={() => setExpanded((v) => !v)}
          className={`p-1.5 rounded-lg transition-colors ${
            hasActiveSearch || expanded
              ? 'bg-primary-100 text-primary-700'
              : 'text-gray-400 hover:bg-gray-100 hover:text-gray-600'
          }`}
          title="Advanced search"
        >
          <SlidersHorizontal size={15} />
        </button>

        {/* Sort */}
        <div className="relative group">
          <button
            className="p-1.5 rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
            title="Sort"
          >
            <ArrowUpDown size={15} />
          </button>
          <div className="absolute right-0 top-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg hidden group-hover:block z-20 w-44">
            {([
              { label: 'Date (newest)', field: 'date', dir: 'desc' },
              { label: 'Date (oldest)', field: 'date', dir: 'asc' },
              { label: 'Sender A→Z', field: 'from', dir: 'asc' },
              { label: 'Sender Z→A', field: 'from', dir: 'desc' },
              { label: 'Recipient A→Z', field: 'to', dir: 'asc' },
              { label: 'Recipient Z→A', field: 'to', dir: 'desc' },
            ] as { label: string; field: SortField; dir: SortDirection }[]).map((opt) => (
              <button
                key={`${opt.field}-${opt.dir}`}
                onClick={() => setSort({ field: opt.field, direction: opt.dir })}
                className={`w-full text-left px-3 py-1.5 text-sm transition-colors ${
                  sort.field === opt.field && sort.direction === opt.dir
                    ? 'bg-primary-50 text-primary-700 font-medium'
                    : 'text-gray-700 hover:bg-gray-50'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Advanced panel */}
      {expanded && (
        <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-20 p-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Subject contains</label>
              <div className="flex gap-1">
                <input
                  value={local.subject ?? ''}
                  onChange={(e) => setLocal((l) => ({ ...l, subject: e.target.value }))}
                  className="flex-1 px-2 py-1 text-sm border border-gray-200 rounded-md focus:outline-none focus:ring-1 focus:ring-primary-400"
                  placeholder="Text or /regex/"
                />
                <label className="flex items-center gap-1 text-xs text-gray-500 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={local.subjectIsRegex ?? false}
                    onChange={(e) => setLocal((l) => ({ ...l, subjectIsRegex: e.target.checked }))}
                    className="rounded"
                  />
                  Regex
                </label>
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Body contains</label>
              <div className="flex gap-1">
                <input
                  value={local.body ?? ''}
                  onChange={(e) => setLocal((l) => ({ ...l, body: e.target.value }))}
                  className="flex-1 px-2 py-1 text-sm border border-gray-200 rounded-md focus:outline-none focus:ring-1 focus:ring-primary-400"
                  placeholder="Text or /regex/"
                />
                <label className="flex items-center gap-1 text-xs text-gray-500 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={local.bodyIsRegex ?? false}
                    onChange={(e) => setLocal((l) => ({ ...l, bodyIsRegex: e.target.checked }))}
                    className="rounded"
                  />
                  Regex
                </label>
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">From</label>
              <input
                value={local.from ?? ''}
                onChange={(e) => setLocal((l) => ({ ...l, from: e.target.value }))}
                className="w-full px-2 py-1 text-sm border border-gray-200 rounded-md focus:outline-none focus:ring-1 focus:ring-primary-400"
                placeholder="sender@example.com"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">To / Cc / Bcc</label>
              <input
                value={local.to ?? ''}
                onChange={(e) => setLocal((l) => ({ ...l, to: e.target.value }))}
                className="w-full px-2 py-1 text-sm border border-gray-200 rounded-md focus:outline-none focus:ring-1 focus:ring-primary-400"
                placeholder="recipient@example.com"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">After</label>
              <input
                type="date"
                value={local.after ? local.after.toISOString().slice(0, 10) : ''}
                onChange={(e) =>
                  setLocal((l) => ({
                    ...l,
                    after: e.target.value ? new Date(e.target.value) : undefined,
                  }))
                }
                className="w-full px-2 py-1 text-sm border border-gray-200 rounded-md focus:outline-none focus:ring-1 focus:ring-primary-400"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Before</label>
              <input
                type="date"
                value={local.before ? local.before.toISOString().slice(0, 10) : ''}
                onChange={(e) =>
                  setLocal((l) => ({
                    ...l,
                    before: e.target.value ? new Date(e.target.value) : undefined,
                  }))
                }
                className="w-full px-2 py-1 text-sm border border-gray-200 rounded-md focus:outline-none focus:ring-1 focus:ring-primary-400"
              />
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <button
              onClick={handleClear}
              className="px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
            >
              Clear
            </button>
            <button
              onClick={handleApply}
              className="px-3 py-1.5 text-sm bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition-colors"
            >
              Apply
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
