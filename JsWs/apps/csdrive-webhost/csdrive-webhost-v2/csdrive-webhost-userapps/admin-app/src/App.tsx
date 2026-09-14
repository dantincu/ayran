import { useEffect, useState } from 'react'
import './App.css'
import { AppWindow, Cloud, Database, Folder, HardDrive, type LucideIcon } from 'lucide-react'
import WindowsTab from './components/WindowsTab'
import FilesTab from './components/FilesTab'
import FilenTab from './components/FilenTab'
import SqliteTab from './components/SqliteTab'
import StorageTab from './components/StorageTab'
import { getAppState, setAppState } from './lib/appState'

type Tab = 'windows' | 'files' | 'filen' | 'sqlite' | 'storage'

const TABS: { id: Tab; label: string; icon: LucideIcon }[] = [
  { id: 'windows', label: 'Windows', icon: AppWindow },
  { id: 'files', label: 'Files', icon: Folder },
  { id: 'filen', label: 'Filen.io', icon: Cloud },
  { id: 'sqlite', label: 'SQLite', icon: Database },
  { id: 'storage', label: 'Storage', icon: HardDrive },
]

const DEFAULT_TAB: Tab = 'windows'
const ACTIVE_TAB_KEY = 'activeTab'

function isTab(value: unknown): value is Tab {
  return typeof value === 'string' && TABS.some((t) => t.id === value)
}

export default function App() {
  const [tab, setTabState] = useState<Tab | null>(null)

  useEffect(() => {
    getAppState<Tab>(ACTIVE_TAB_KEY).then((stored) => {
      setTabState(isTab(stored) ? stored : DEFAULT_TAB)
    })
  }, [])

  function setTab(next: Tab) {
    setTabState(next)
    setAppState(ACTIVE_TAB_KEY, next)
  }

  if (tab === null) {
    // Wait for the persisted tab to load so we don't flash the wrong one.
    return <div className="app-shell" />
  }

  return (
    <div className="app-shell">
      <nav className="tab-nav">
        {TABS.map((t) => {
          const Icon = t.icon
          return (
            <button
              key={t.id}
              className={`tab-button ${tab === t.id ? 'active' : ''}`}
              onClick={() => setTab(t.id)}
              title={t.label}
            >
              <Icon size={18} strokeWidth={2} aria-hidden="true" />
              <span>{t.label}</span>
            </button>
          )
        })}
      </nav>
      <main className="tab-content">
        {tab === 'windows' && <WindowsTab />}
        {tab === 'files' && <FilesTab />}
        {tab === 'filen' && <FilenTab />}
        {tab === 'sqlite' && <SqliteTab />}
        {tab === 'storage' && <StorageTab />}
      </main>
    </div>
  )
}
