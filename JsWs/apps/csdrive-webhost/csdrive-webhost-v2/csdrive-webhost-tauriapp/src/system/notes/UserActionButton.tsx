import { useSyncExternalStore } from 'react'
import { Zap } from 'lucide-react'
import IconButton from '../../components/IconButton'
import Modal from '../../components/Modal'
import { contextTrigger } from '../../components/ContextMenu'
import UserActionModal from './UserActionModal'
import { closeUserAction, launchUserAction, useUserActionOpen } from './userAction'

/** The dialogs a launch can need — the one that chooses the page, and what to say when it fails — live in one place (`UserActionDialogs`,
 * mounted once in the page): the buttons at a text box are gone the moment the box loses the focus, and a dialog can't be theirs. */
const ui = { choosing: false, problem: null as string | null, listeners: new Set<() => void>() }
const changed = () => ui.listeners.forEach((listener) => listener())
const show = (next: Partial<Pick<typeof ui, 'choosing' | 'problem'>>) => {
  Object.assign(ui, next)
  snapshot = { choosing: ui.choosing, problem: ui.problem }
  changed()
}
let snapshot = { choosing: false, problem: null as string | null }
const subscribe = (listener: () => void) => {
  ui.listeners.add(listener)
  return () => {
    ui.listeners.delete(listener)
  }
}

/** The dialogs of the User Action: choosing the page (when a launch finds none, or on a right click of the launcher), and a launch's failure. */
export function UserActionDialogs() {
  const { choosing, problem } = useSyncExternalStore(subscribe, () => snapshot)
  return (
    <>
      {choosing && <UserActionModal onClose={() => show({ choosing: false })} />}
      {problem && (
        <Modal title="User Action" onClose={() => show({ problem: null })}>
          <p>{problem}</p>
        </Modal>
      )}
    </>
  )
}

/** What a launch does, and says when it fails: `launch(context)` opens the page chosen for the place shown — or, when none was chosen,
 * the dialog that chooses one. */
function useLaunch() {
  const launch = async (context: Record<string, unknown>) => {
    try {
      if (!(await launchUserAction(context))) show({ choosing: true })
    } catch (e) {
      show({ problem: e instanceof Error ? e.message : String(e) })
    }
  }
  const close = async () => {
    try {
      await closeUserAction()
    } catch (e) {
      show({ problem: e instanceof Error ? e.message : String(e) })
    }
  }
  return { launch, close, choose: () => show({ choosing: true }) }
}

/** **The User Action control** — one icon button, nothing else: it **launches** the User Action window (the page chosen for the place shown;
 * see `user_action.rs`). It goes in the header of every page of Notes; the same one is at every text box (`UserActionFieldButtons`, on the box's
 * clipboard menu strip). A press on the launcher brings the window to the front if it is open; a right click or a long press on it opens the
 * configuration dialog (`UserActionModal`) — choose/change the page, **close the window**, or reset it (asked for directly: "keep just the
 * launch button and when triggering the context event on the launch button, launch the... configuration popup modal" — closing the window, not
 * only choosing its page, moved into that one dialog once the dedicated close button was removed). What the button needs to know — the place
 * shown — is the resource of the tab. */
export default function UserActionButton(_place?: { sourceId?: string; folder?: string }) {
  const open = useUserActionOpen()
  const { launch, choose } = useLaunch()
  return (
    <IconButton
      icon={Zap}
      label={open ? 'User Action — bring its window to the front and launch it again (right click: configure or close it)' : 'User Action — launch it in a window of its own (right click: configure it)'}
      onClick={() => launch({ kind: 'button' })}
      {...contextTrigger(choose)}
    />
  )
}

/** What the page that is launched from a text box is told about it: **which box it is — a stable identifier, distinct for every box of Notes — and
 * of what kind. Never what is in it.** Not its label, not what is selected, not how much: the page must not learn what the person is typing. The
 * identifier is `data-ua-field` on the box (set once, on the element, by whichever page of Notes puts the box on screen — `notes.search.name`,
 * `notes.notebook.title`… — see the attribute on each `<input>`/`<textarea>` of Notes); a box that was never given one reports `"notes.field"`,
 * which is still distinct from every real one. **The bridge for actual text is the app's own clipboard**, which the person controls: they copy the
 * selection to it (the box's "…" menu) and the page reads it if it wants to (`TabLib.internalClipboard`), and what the page puts there they paste
 * back. */
export function describeField(field: HTMLInputElement | HTMLTextAreaElement): Record<string, unknown> {
  return {
    kind: 'input',
    fieldId: field.dataset.uaField ?? 'notes.field',
    element: field instanceof HTMLTextAreaElement ? 'textarea' : 'input',
    type: field instanceof HTMLInputElement ? field.type : 'text',
    readOnly: field.readOnly,
  }
}

/** The same one button, for a text box: it sits beside its clipboard menu (`TextFieldMenu`'s `extra`), and the launch tells the page
 * which box it was launched from. A press must not take the focus from the box; a right click or long press opens the configuration
 * dialog (choose/change the page, close the window, reset it) — the same `contextTrigger` the header button uses. */
export function UserActionFieldButtons({ field }: { field: HTMLInputElement | HTMLTextAreaElement }) {
  const { launch, choose } = useLaunch()
  const keepFocus = (e: React.MouseEvent) => e.preventDefault()
  return (
    <button
      type="button"
      className="text-menu-trigger"
      aria-label="Launch the User Action from this box (right click: configure or close it)"
      title="Launch the User Action from this box (right click: configure or close it)"
      onMouseDown={keepFocus}
      onClick={() => launch(describeField(field))}
      {...contextTrigger(choose)}
    >
      <Zap size={16} strokeWidth={2} aria-hidden="true" />
    </button>
  )
}
