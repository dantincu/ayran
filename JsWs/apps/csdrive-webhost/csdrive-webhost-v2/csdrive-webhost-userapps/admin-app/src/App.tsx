import { useState } from 'react'
import './App.css'
import WindowsTab from './components/WindowsTab'
import FilesTab from './components/FilesTab'
import FilenTab from './components/FilenTab'
import SqliteTab from './components/SqliteTab'
import StorageTab from './components/StorageTab'

type Tab = 'windows' | 'files' | 'filen' | 'sqlite' | 'storage'

const TABS: { id: Tab; label: string }[] = [
  { id: 'windows', label: 'Windows' },
  { id: 'files', label: 'Files' },
  { id: 'filen', label: 'Filen.io' },
  { id: 'sqlite', label: 'SQLite Studio' },
  { id: 'storage', label: 'Storage' },
]

export default function App() {
  const [tab, setTab] = useState<Tab>('windows')

  return (
    <div className="app-shell">
      <nav className="tab-nav">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`tab-button ${tab === t.id ? 'active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
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
