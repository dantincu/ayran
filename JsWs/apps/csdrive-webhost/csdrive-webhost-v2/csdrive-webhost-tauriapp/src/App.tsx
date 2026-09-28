import { useEffect, useMemo, useState } from 'react'
import './App.css'
import { AppWindow, Blocks, CircleHelp, Cloud, Database, Folder, HardDrive, Settings, Wrench, type LucideIcon } from 'lucide-react'
import AppsTab from './components/AppsTab'
import FilesTab from './components/FilesTab'
import FilenTab from './components/FilenTab'
import SqliteTab from './components/SqliteTab'
import StorageTab from './components/StorageTab'
import SettingsTab from './components/SettingsTab'
import DevToolsTab from './components/DevToolsTab'
import HelpTab from './components/HelpTab'
import Splash from './components/Splash'
import { hideNativeSplash } from './lib/nativeSplash'
import TabSwitcher from './components/TabSwitcher'
import ChordHost from './components/ChordHost'
import TextFieldMenu from './components/TextFieldMenu'
import { getAppState, setAppState } from './lib/appState'
import { chordLabel, useChord } from './lib/chords'
import { showHelpHeader } from './lib/helpHeader'
import { useDevToolsEnabled } from './lib/devTools'

type Tab = 'system' | 'apps' | 'files' | 'filen' | 'sqlite' | 'storage' | 'settings' | 'devtools' | 'help'

/** Every tab but Dev Tools, which — Settings → "Advanced" — is inserted just before Help only once it's
 * turned on (`useDevToolsEnabled`), never removed from the tab bar for a person who hasn't asked for it. */
const BASE_TABS: { id: Tab; label: string; icon: LucideIcon }[] = [
  { id: 'system', label: 'System Apps', icon: Blocks },
  { id: 'apps', label: 'User Apps', icon: AppWindow },
  { id: 'files', label: 'Files', icon: Folder },
  { id: 'filen', label: 'Filen.io', icon: Cloud },
  { id: 'sqlite', label: 'SQLite', icon: Database },
  { id: 'storage', label: 'Storage', icon: HardDrive },
  { id: 'settings', label: 'Settings', icon: Settings },
  { id: 'help', label: 'Help', icon: CircleHelp },
]
const DEV_TOOLS_TAB: { id: Tab; label: string; icon: LucideIcon } = { id: 'devtools', label: 'Dev Tools', icon: Wrench }

function tabsFor(devToolsEnabled: boolean): { id: Tab; label: string; icon: LucideIcon }[] {
  if (!devToolsEnabled) return BASE_TABS
  const helpIndex = BASE_TABS.findIndex((t) => t.id === 'help')
  return [...BASE_TABS.slice(0, helpIndex), DEV_TOOLS_TAB, ...BASE_TABS.slice(helpIndex)]
}

const DEFAULT_TAB: Tab = 'system'
const ACTIVE_TAB_KEY = 'activeTab'
const ALL_TABS = [...BASE_TABS, DEV_TOOLS_TAB]

function isTab(value: unknown): value is Tab {
  return typeof value === 'string' && ALL_TABS.some((t) => t.id === value)
}

export default function App() {
  const [tab, setTabState] = useState<Tab | null>(null)
  const [switching, setSwitching] = useState(false)
  const { enabled: devToolsEnabled } = useDevToolsEnabled()
  const TABS = useMemo(() => tabsFor(devToolsEnabled), [devToolsEnabled])

  // The tab switcher opens from anywhere in the admin-app: Ctrl+K, T.
  useChord('t', 'Switch to another tab', () => setSwitching((open) => !open))

  useEffect(() => {
    getAppState<Tab>(ACTIVE_TAB_KEY).then((stored) => {
      setTabState(isTab(stored) ? stored : DEFAULT_TAB)
      // The first screen is about to be drawn: let the native loading spinner (Android) go.
      requestAnimationFrame(hideNativeSplash)
    })
  }, [])

  // A tab whose button no longer shows (Dev Tools, turned off again after being the last one shown) isn't a
  // place to be stuck: fall back the moment that's judged, the same way a page's own saved-but-gone target does.
  useEffect(() => {
    if (tab && !TABS.some((t) => t.id === tab)) setTab(DEFAULT_TAB)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, TABS])

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
        {TABS.map((t, i) => {
          const Icon = t.icon
          return (
            <button
              key={t.id}
              className={`tab-button ${tab === t.id ? 'active' : ''}`}
              onClick={() => {
                // Pressing the Help tab's own head again — it's already showing — brings its autohiding header
                // back, the same way it would if you'd scrolled up to it by hand.
                if (t.id === 'help' && tab === 'help') showHelpHeader()
                else setTab(t.id)
              }}
              title={`${t.label} — tab ${i + 1} (${chordLabel('t')}, then ${i + 1})`}
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
        {tab === 'devtools' && devToolsEnabled && <DevToolsTab />}
        {tab === 'help' && <HelpTab />}
      </main>
      {switching && (
        <TabSwitcher
          tabs={TABS}
          currentId={tab}
          onPick={(id) => {
            setSwitching(false)
            if (isTab(id)) setTab(id)
          }}
          onClose={() => setSwitching(false)}
        />
      )}
      <TextFieldMenu />
      <ChordHost />
    </div>
  )
}
