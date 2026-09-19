import { useEffect, useState } from 'react'
import './App.css'
import { AppWindow, Blocks, Cloud, Database, Folder, HardDrive, Settings, type LucideIcon } from 'lucide-react'
import AppsTab from './components/AppsTab'
import FilesTab from './components/FilesTab'
import FilenTab from './components/FilenTab'
import SqliteTab from './components/SqliteTab'
import StorageTab from './components/StorageTab'
import SettingsTab from './components/SettingsTab'
import Splash from './components/Splash'
import { hideNativeSplash } from './lib/nativeSplash'
import { getAppState, setAppState } from './lib/appState'

type Tab = 'system' | 'apps' | 'files' | 'filen' | 'sqlite' | 'storage' | 'settings'

const TABS: { id: Tab; label: string; icon: LucideIcon }[] = [
  { id: 'system', label: 'System Apps', icon: Blocks },
  { id: 'apps', label: 'User Apps', icon: AppWindow },
  { id: 'files', label: 'Files', icon: Folder },
  { id: 'filen', label: 'Filen.io', icon: Cloud },
  { id: 'sqlite', label: 'SQLite', icon: Database },
  { id: 'storage', label: 'Storage', icon: HardDrive },
  { id: 'settings', label: 'Settings', icon: Settings },
]

const DEFAULT_TAB: Tab = 'system'
const ACTIVE_TAB_KEY = 'activeTab'

function isTab(value: unknown): value is Tab {
  return typeof value === 'string' && TABS.some((t) => t.id === value)
}

export default function App() {
  const [tab, setTabState] = useState<Tab | null>(null)

  useEffect(() => {
    getAppState<Tab>(ACTIVE_TAB_KEY).then((stored) => {
      setTabState(isTab(stored) ? stored : DEFAULT_TAB)
      // The first screen is about to be drawn: let the native loading spinner (Android) go.
      requestAnimationFrame(hideNativeSplash)
    })
  }, [])

  function setTab(next: Tab) {
    setTabState(next)
    setAppState(ACTIVE_TAB_KEY, next)
  }

  if (tab === null) {
    // Wait for the persisted tab to load so we don't flash the wrong one.
    return (
      <div className="app-shell">
        <Splash />
      </div>
    )
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
        {tab === 'system' && <AppsTab key="system" kind="system" />}
        {tab === 'apps' && <AppsTab key="user" kind="user" />}
        {tab === 'files' && <FilesTab />}
        {tab === 'filen' && <FilenTab />}
        {tab === 'sqlite' && <SqliteTab />}
        {tab === 'storage' && <StorageTab />}
        {tab === 'settings' && <SettingsTab />}
      </main>
    </div>
  )
}
