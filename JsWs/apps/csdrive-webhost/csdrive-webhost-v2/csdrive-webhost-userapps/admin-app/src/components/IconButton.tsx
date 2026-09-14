import type { LucideIcon } from 'lucide-react'
import type { ButtonHTMLAttributes } from 'react'

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: LucideIcon
  label: string
  size?: number
  variant?: 'default' | 'danger'
}

/** A square, icon-only button. `label` becomes the tooltip and accessible name —
 * always pass a clear one since there's no visible text to fall back on. */
export default function IconButton({
  icon: Icon,
  label,
  size = 16,
  variant = 'default',
  className,
  ...rest
}: IconButtonProps) {
  return (
    <button
      type="button"
      className={`icon-button ${variant === 'danger' ? 'icon-button-danger' : ''} ${className ?? ''}`}
      title={label}
      aria-label={label}
      {...rest}
    >
      <Icon size={size} strokeWidth={2} aria-hidden="true" />
    </button>
  )
}
