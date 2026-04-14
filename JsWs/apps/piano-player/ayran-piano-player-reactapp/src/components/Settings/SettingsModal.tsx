import { useState } from 'react'
import { Modal } from '../common/Modal'
import { KeySizeSettings } from './KeySizeSettings'
import { ThemeSettings } from './ThemeSettings'
import { SoundSetSettings } from './SoundSetSettings'
import { RecordingsList } from './RecordingsList'
import './Settings.css'

type Tab = 'keys' | 'themes' | 'sounds' | 'recordings'

const TABS: { id: Tab; label: string }[] = [
  { id: 'keys', label: 'Key Size' },
  { id: 'themes', label: 'Themes' },
  { id: 'sounds', label: 'Sound Sets' },
  { id: 'recordings', label: 'Recordings' }
]

interface SettingsModalProps {
  onClose: () => void
}

export function SettingsModal({ onClose }: SettingsModalProps) {
  const [activeTab, setActiveTab] = useState<Tab>('keys')

  return (
    <Modal title="Settings" onClose={onClose} size="md">
      <div className="tabs">
        {TABS.map(tab => (
          <button
            key={tab.id}
            className={`tab ${activeTab === tab.id ? 'tab--active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'keys' && <KeySizeSettings />}
      {activeTab === 'themes' && <ThemeSettings />}
      {activeTab === 'sounds' && <SoundSetSettings />}
      {activeTab === 'recordings' && <RecordingsList />}
    </Modal>
  )
}
