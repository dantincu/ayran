import type { LucideIcon } from 'lucide-react'
import { forwardRef } from 'react'
import type { ButtonHTMLAttributes } from 'react'

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: LucideIcon
  label: string
  size?: number
  variant?: 'default' | 'danger'
}

/** A square, icon-only button. `label` becomes the tooltip and accessible name —
 * always pass a clear one since there's no visible text to fall back on. Forwards its
 * ref (e.g. `RowActions`' "more actions" button, which needs its own position to open its menu at). */
const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon: Icon, label, size = 16, variant = 'default', className, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      className={`icon-button ${variant === 'danger' ? 'icon-button-danger' : ''} ${className ?? ''}`}
      title={label}
      aria-label={label}
      {...rest}
    >
      <Icon size={size} strokeWidth={2} aria-hidden="true" />
    </button>
  )
})

export default IconButton
