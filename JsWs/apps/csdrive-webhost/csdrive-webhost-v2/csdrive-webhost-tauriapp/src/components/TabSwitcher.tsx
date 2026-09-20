import { useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import Modal from './Modal'
import { shortcutLabel, TAB_SWITCHER_LETTER } from '../lib/keyboard'

export interface SwitcherTab {
  id: string
  label: string
  icon: LucideIcon
}

/** The admin-app's "go to tab" popover, opened from anywhere with the keyboard shortcut: every tab
 * with its number in front, and a box (focused at once) that takes digits — Enter goes to that tab.
 * Pressing a row goes to its tab too. */
export default function TabSwitcher({
  tabs,
  currentId,
  onPick,
  onClose,
}: {
  tabs: SwitcherTab[]
  currentId: string
  onPick: (id: string) => void
  onClose: () => void
}) {
  const [typed, setTyped] = useState('')
  const [invalid, setInvalid] = useState(false)
  const typedNumber = typed === '' ? null : Number(typed)

  function submit() {
    const target = typedNumber !== null ? tabs[typedNumber - 1] : undefined
    if (!target) {
      setInvalid(true)
      return
    }
    onPick(target.id)
  }

  return (
    <Modal title="Go to tab" onClose={onClose}>
      <input
        autoFocus
        className={`switcher-input ${invalid ? 'invalid' : ''}`}
        inputMode="numeric"
        placeholder={`Tab number 1–${tabs.length}, then Enter`}
        aria-label="Tab number"
        value={typed}
        onChange={(e) => {
          setTyped(e.target.value.replace(/\D/g, ''))
          setInvalid(false)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            submit()
          }
        }}
      />
      <ol className="switcher-list">
        {tabs.map((t, i) => {
          const Icon = t.icon
          return (
            <li key={t.id}>
              <button
                type="button"
                className={`switcher-row ${typedNumber === i + 1 ? 'matching' : ''}`}
                aria-current={t.id === currentId ? 'page' : undefined}
                onClick={() => onPick(t.id)}
              >
                <span className="switcher-number">{i + 1}</span>
                <Icon size={16} strokeWidth={2} aria-hidden="true" />
                <span>{t.label}</span>
                {t.id === currentId && <span className="muted">(current)</span>}
              </button>
            </li>
          )
        })}
      </ol>
      <div className="muted switcher-hint">{shortcutLabel(TAB_SWITCHER_LETTER)} opens this from any tab.</div>
    </Modal>
  )
}
