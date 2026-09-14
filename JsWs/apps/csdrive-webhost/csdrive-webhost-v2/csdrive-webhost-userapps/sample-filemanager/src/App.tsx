import { useState } from 'react'
import './App.css'
import FilesTab from './components/FilesTab'
import FilenTab from './components/FilenTab'
import SqliteTab from './components/SqliteTab'

type Tab = 'files' | 'filen' | 'sqlite'

const TABS: { id: Tab; label: string }[] = [
  { id: 'files', label: 'Files' },
  { id: 'filen', label: 'Filen.io' },
  { id: 'sqlite', label: 'SQLite Studio' },
]

export default function App() {
  const [tab, setTab] = useState<Tab>('files')

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
        {tab === 'files' && <FilesTab />}
        {tab === 'filen' && <FilenTab />}
        {tab === 'sqlite' && <SqliteTab />}
      </main>
    </div>
  )
}
