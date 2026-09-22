import { useEffect, useState } from 'react'
import { MoreVertical } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import IconButton from './IconButton'
import ContextMenu from './ContextMenu'
import { subscribeRowActionsCompact } from '../lib/rowActionsCompact'

export interface RowAction {
  icon: LucideIcon
  /** The tooltip/accessible name inline, and the menu item's text when collapsed. */
  label: string
  onClick: () => void
  disabled?: boolean
  danger?: boolean
}

/** The content of a record's row of icon buttons (inside whichever wrapper the list already has — a `<td
 * className="row-actions">`, a `<div className="row-actions">`, ... — this renders no wrapper of its own, so every
 * existing layout, including the slim-window CSS that moves the row below the record's text, keeps working
 * unchanged): the buttons inline as ever, or every one of them behind a single **⋯** button that opens a menu, per the
 * app-wide "Compact row actions" setting (`rowActionsCompact.ts`, changed in Settings). The **⋯** button itself always
 * sits inline; nothing about *whether* the row is compact is a per-row choice. A new list's row of actions uses this in
 * place of its own list of `IconButton`s so it gets the setting for free. */
export default function RowActions({ actions }: { actions: RowAction[] }) {
  const [compact, setCompact] = useState(false)
  // Where the menu opens (its own `useLayoutEffect` keeps it inside the window from there); set from the click
  // event's own target, not a ref read during render (`ContextMenu`'s own trigger, `NotePage`'s "More…", do the same).
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null)

  useEffect(() => subscribeRowActionsCompact(setCompact), [])

  if (actions.length === 0) return null

  if (!compact) {
    return (
      <>
        {actions.map((a) => (
          <IconButton key={a.label} icon={a.icon} label={a.label} onClick={a.onClick} disabled={a.disabled} variant={a.danger ? 'danger' : 'default'} />
        ))}
      </>
    )
  }

  return (
    <>
      <IconButton
        icon={MoreVertical}
        label="More actions"
        onClick={(e) => {
          const box = e.currentTarget.getBoundingClientRect()
          setMenuAt({ x: box.right, y: box.bottom })
        }}
      />
      {menuAt && (
        <ContextMenu
          x={menuAt.x}
          y={menuAt.y}
          onClose={() => setMenuAt(null)}
          items={actions.map((a) => ({ label: a.label, icon: a.icon, onSelect: a.onClick, disabled: a.disabled, danger: a.danger }))}
        />
      )}
    </>
  )
}
