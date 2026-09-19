import { useEffect, useState } from 'react'
import './App.css'
import { AppWindow, Cloud, Database, Folder, HardDrive, Settings, type LucideIcon } from 'lucide-react'
import AppsTab from './components/AppsTab'
import FilesTab from './components/FilesTab'
import FilenTab from './components/FilenTab'
import SqliteTab from './components/SqliteTab'
import StorageTab from './components/StorageTab'
import SettingsTab from './components/SettingsTab'
import { getAppState, setAppState } from './lib/appState'

type Tab = 'apps' | 'files' | 'filen' | 'sqlite' | 'storage' | 'settings'

const TABS: { id: Tab; label: string; icon: LucideIcon }[] = [
  { id: 'apps', label: 'Apps', icon: AppWindow },
  { id: 'files', label: 'Files', icon: Folder },
  { id: 'filen', label: 'Filen.io', icon: Cloud },
  { id: 'sqlite', label: 'SQLite', icon: Database },
  { id: 'storage', label: 'Storage', icon: HardDrive },
  { id: 'settings', label: 'Settings', icon: Settings },
]

const DEFAULT_TAB: Tab = 'apps'
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
        {tab === 'apps' && <AppsTab />}
        {tab === 'files' && <FilesTab />}
        {tab === 'filen' && <FilenTab />}
        {tab === 'sqlite' && <SqliteTab />}
        {tab === 'storage' && <StorageTab />}
        {tab === 'settings' && <SettingsTab />}
      </main>
    </div>
  )
}
