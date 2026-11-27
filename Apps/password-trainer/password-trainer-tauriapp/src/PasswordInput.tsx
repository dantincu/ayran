import { useRef, useState, type ChangeEvent, type Ref, type SyntheticEvent } from 'react'
import { IconEye, IconEyeOff } from './icons'

const block = (e: SyntheticEvent) => e.preventDefault()

/**
 * A password field whose text can never reach the clipboard, with an eye button that switches it to a
 * plain text field (and back).
 *
 * - Both modes: copy, cut and dragging the text out are blocked, and nothing an autofill or keyboard
 *   could learn or save is offered.
 * - Hidden (`type="password"`): the context menu is blocked too.
 * - Shown (`type="text"`): the context menu is allowed, so a password can be **pasted** in (Android's
 *   long-press "Paste"). So that its Copy / Share can't take the text out, any selection is collapsed
 *   to the caret at once: with nothing selected, they have nothing to act on.
 */
export function PasswordInput({ value, onChange, ref, disabled, placeholder, ariaLabel }: {
  value: string
  onChange: (e: ChangeEvent<HTMLInputElement>) => void
  ref?: Ref<HTMLInputElement>
  disabled?: boolean
  placeholder?: string
  ariaLabel?: string
}) {
  const [shown, setShown] = useState(false)
  const own = useRef<HTMLInputElement | null>(null)

  const setRefs = (el: HTMLInputElement | null) => {
    own.current = el
    if (typeof ref === 'function') ref(el)
    else if (ref) ref.current = el
  }

  const collapseSelection = (e: SyntheticEvent<HTMLInputElement>) => {
    const el = e.currentTarget
    if (el.selectionStart !== null && el.selectionEnd !== null && el.selectionStart !== el.selectionEnd) {
      el.setSelectionRange(el.selectionEnd, el.selectionEnd)
    }
  }

  return (
    <div className="pw-field">
      <input
        ref={setRefs}
        type={shown ? 'text' : 'password'}
        value={value}
        onChange={onChange}
        disabled={disabled}
        placeholder={placeholder}
        aria-label={ariaLabel}
        onCopy={block}
        onCut={block}
        onDragStart={block}
        onContextMenu={shown ? undefined : block}
        onSelect={shown ? collapseSelection : undefined}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        data-lpignore="true"
        data-1p-ignore="true"
      />
      <button
        type="button"
        className="icon ghost pw-toggle"
        disabled={disabled}
        aria-pressed={shown}
        aria-label={shown ? 'Hide the password' : 'Show the password'}
        title={shown ? 'Hide' : 'Show'}
        // Keep the focus (and the phone's keyboard) in the field while toggling.
        onPointerDown={(e) => e.preventDefault()}
        onClick={() => {
          setShown((s) => !s)
          own.current?.focus()
        }}
      >
        {shown ? <IconEyeOff /> : <IconEye />}
      </button>
    </div>
  )
}
