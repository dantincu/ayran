import { useState } from 'react'
import { MoreHorizontal } from 'lucide-react'
import IconButton from './IconButton'
import ContextMenu, { type MenuItem } from './ContextMenu'

/** An unconditional **three-dots** overflow button: a plain `IconButton` (`MoreHorizontal`, the same icon
 * `NotePage.tsx`'s own "More…" button already uses) that opens a `ContextMenu` of `items` at its own corner —
 * `ContextMenu`'s own keyboard navigation (Up/Down/Home/End/PageUp/PageDown/fast-nav) applies here for free.
 * Unlike `RowActions.tsx` (which only collapses into this same shape when the app-wide "Compact row actions"
 * setting is on, and otherwise shows every button inline), this one is **always** a popover — for a page's own
 * header, where several buttons are deliberately moved out of the inline row regardless of that list-only
 * setting (asked for directly, item 2/4 of the todo: "a three-dots icon button that launches a popover menu"). */
export default function MoreMenuButton({ label, items }: { label: string; items: MenuItem[] }) {
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null)
  if (items.length === 0) return null
  return (
    <>
      <IconButton
        icon={MoreHorizontal}
        label={label}
        onClick={(e) => {
          const box = e.currentTarget.getBoundingClientRect()
          setMenuAt({ x: box.right, y: box.bottom })
        }}
      />
      {menuAt && <ContextMenu x={menuAt.x} y={menuAt.y} onClose={() => setMenuAt(null)} items={items} />}
    </>
  )
}
