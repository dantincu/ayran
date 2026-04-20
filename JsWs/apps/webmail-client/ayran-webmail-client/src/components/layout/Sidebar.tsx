import { ChevronLeft, ChevronRight, Plus, LogOut, Mail } from 'lucide-react'
import { FolderTree } from './FolderTree'
import { useAuthStore } from '../../stores/authStore'
import { useEmailStore } from '../../stores/emailStore'
import { initiateOAuth } from '../../services/oauth'
import type { EmailProvider } from '../../types/email'

interface SidebarProps {
  collapsed: boolean
  onToggle: () => void
  onCompose: () => void
}

const PROVIDER_COLORS: Record<EmailProvider, string> = {
  gmail: 'bg-red-500',
  outlook: 'bg-blue-500',
  yahoo: 'bg-purple-500',
}

const PROVIDER_LABELS: Record<EmailProvider, string> = {
  gmail: 'G',
  outlook: 'O',
  yahoo: 'Y',
}

export function Sidebar({ collapsed, onToggle, onCompose }: SidebarProps) {
  const { accounts, activeAccountId, setActiveAccount, removeAccount } = useAuthStore()
  const { folders } = useEmailStore()

  const accountFolders = (accountId: string) =>
    folders.filter((f) => f.accountId === accountId)

  return (
    <aside className="flex flex-col w-full h-full bg-white border-r border-gray-200">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-3 border-b border-gray-100">
        {!collapsed && (
          <div className="flex items-center gap-2">
            <Mail size={20} className="text-primary-600" />
            <span className="font-semibold text-gray-800 text-sm">Ayran Mail</span>
          </div>
        )}
        <button
          onClick={onToggle}
          className="ml-auto p-1 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100"
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
        </button>
      </div>

      {!collapsed && (
        <>
          {/* Compose button */}
          <div className="px-3 py-3">
            <button
              onClick={onCompose}
              className="w-full flex items-center justify-center gap-2 bg-primary-600 hover:bg-primary-700 text-white rounded-lg py-2 px-4 text-sm font-medium transition-colors"
            >
              <Plus size={16} />
              Compose
            </button>
          </div>

          {/* Account tabs */}
          {accounts.length > 0 && (
            <div className="flex gap-1 px-3 pb-2 flex-wrap">
              {accounts.map((account) => (
                <button
                  key={account.id}
                  onClick={() => setActiveAccount(account.id)}
                  className={`flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-medium transition-colors ${
                    activeAccountId === account.id
                      ? 'bg-gray-800 text-white'
                      : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                  }`}
                  title={account.email}
                >
                  <span
                    className={`w-3.5 h-3.5 rounded-full flex items-center justify-center text-white text-[8px] font-bold ${
                      PROVIDER_COLORS[account.provider]
                    }`}
                  >
                    {PROVIDER_LABELS[account.provider]}
                  </span>
                  <span className="max-w-[80px] truncate">{account.email.split('@')[0]}</span>
                </button>
              ))}
            </div>
          )}

          {/* Folder tree */}
          <div className="flex-1 overflow-y-auto scrollbar-thin">
            {accounts.map((account) => (
              <FolderTree
                key={account.id}
                folders={accountFolders(account.id)}
                accountLabel={accounts.length > 1 ? account.email : undefined}
              />
            ))}
          </div>

          {/* Add account + logout */}
          <div className="border-t border-gray-100 px-3 py-2 space-y-1">
            <div className="relative group">
              <button className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-xs text-gray-500 hover:bg-gray-100 transition-colors">
                <Plus size={13} />
                Add account
              </button>
              <div className="absolute bottom-full left-0 mb-1 bg-white border border-gray-200 rounded-lg shadow-lg hidden group-hover:block z-10 min-w-[140px]">
                {(['gmail', 'outlook', 'yahoo'] as EmailProvider[]).map((p) => (
                  <button
                    key={p}
                    onClick={() => initiateOAuth(p)}
                    className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2 capitalize"
                  >
                    <span
                      className={`w-4 h-4 rounded-full flex items-center justify-center text-white text-[9px] font-bold ${PROVIDER_COLORS[p]}`}
                    >
                      {PROVIDER_LABELS[p]}
                    </span>
                    {p.charAt(0).toUpperCase() + p.slice(1)}
                  </button>
                ))}
              </div>
            </div>
            {activeAccountId && (
              <button
                onClick={() => {
                  if (confirm('Remove this account?')) removeAccount(activeAccountId)
                }}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-xs text-red-500 hover:bg-red-50 transition-colors"
              >
                <LogOut size={13} />
                Remove account
              </button>
            )}
          </div>
        </>
      )}

      {/* Collapsed: compose + account dots */}
      {collapsed && (
        <div className="flex flex-col items-center py-3 gap-3">
          <button
            onClick={onCompose}
            className="p-2 bg-primary-600 hover:bg-primary-700 text-white rounded-lg transition-colors"
            title="Compose"
          >
            <Plus size={16} />
          </button>
          {accounts.map((account) => (
            <button
              key={account.id}
              onClick={() => setActiveAccount(account.id)}
              className={`w-7 h-7 rounded-full flex items-center justify-center text-white text-xs font-bold ${
                PROVIDER_COLORS[account.provider]
              } ${activeAccountId === account.id ? 'ring-2 ring-primary-500 ring-offset-1' : ''}`}
              title={account.email}
            >
              {PROVIDER_LABELS[account.provider]}
            </button>
          ))}
        </div>
      )}
    </aside>
  )
}
