import type { SyntheticEvent } from 'react'

const block = (e: SyntheticEvent) => e.preventDefault()

/**
 * Props for a password field whose text can't reach the clipboard: no copy, cut or drag out,
 * no context menu (with its Copy/Share), and nothing an autofill or keyboard could learn or save.
 */
export const noCopyProps = {
  type: 'password',
  onCopy: block,
  onCut: block,
  onDragStart: block,
  onContextMenu: block,
  autoComplete: 'off',
  autoCorrect: 'off',
  autoCapitalize: 'off',
  spellCheck: false,
  'data-lpignore': 'true',
  'data-1p-ignore': 'true',
} as const
