import { useEffect, useState, useSyncExternalStore } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { Zap, ZapOff } from 'lucide-react'
import IconButton from '../../components/IconButton'
import Modal from '../../components/Modal'
import { contextTrigger } from '../../components/ContextMenu'
import UserActionModal from './UserActionModal'
import { closeUserAction, launchUserAction } from './userAction'

/** Whether this Notes window's User Action window is open (the backend tells the window: `user-action-state`). */
function useUserActionOpen(): boolean {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    let alive = true
    let stop: (() => void) | undefined
    invoke<boolean>('user_action_status').then((now) => alive && setOpen(now), () => {})
    getCurrentWebviewWindow()
      .listen<{ open: boolean }>('user-action-state', (event) => setOpen(event.payload.open))
      .then((unlisten) => (alive ? (stop = unlisten) : unlisten()), () => {})
    return () => {
      alive = false
      stop?.()
    }
  }, [])
  return open
}

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

/** **The User Action control** — two icon buttons, nothing else: one **launches** the User Action window (the page chosen for the place shown;
 * see `user_action.rs`), one **closes** it. They go in the header of every page of Notes; the same two are at every text box
 * (`UserActionFieldButtons`, on the box's clipboard menu strip). A press on the launcher brings the window to the front if it is open;
 * a right click or a long press on it chooses the page. What the buttons need to know — the place shown — is the resource of the tab. */
export default function UserActionButton(_place?: { sourceId?: string; folder?: string }) {
  const open = useUserActionOpen()
  const { launch, close, choose } = useLaunch()
  return (
    <>
      <IconButton
        icon={Zap}
        label={open ? 'User Action — bring its window to the front and launch it again (right click: choose the page)' : 'User Action — launch it in a window of its own (right click: choose the page)'}
        onClick={() => launch({ kind: 'button' })}
        {...contextTrigger(choose)}
      />
      <IconButton icon={ZapOff} label="Close the User Action window" onClick={close} disabled={!open} />
    </>
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

/** The same two buttons, for a text box: they sit beside its clipboard menu (`TextFieldMenu`'s `extra`), and the launch tells the page
 * which box it was launched from. A press must not take the focus from the box. */
export function UserActionFieldButtons({ field }: { field: HTMLInputElement | HTMLTextAreaElement }) {
  const open = useUserActionOpen()
  const { launch, close } = useLaunch()
  const keepFocus = (e: React.MouseEvent) => e.preventDefault()
  return (
    <>
      <button type="button" className="text-menu-trigger" aria-label="Launch the User Action from this box" title="Launch the User Action from this box" onMouseDown={keepFocus} onClick={() => launch(describeField(field))}>
        <Zap size={14} strokeWidth={2} aria-hidden="true" />
      </button>
      <button type="button" className="text-menu-trigger" aria-label="Close the User Action window" title="Close the User Action window" disabled={!open} onMouseDown={keepFocus} onClick={close}>
        <ZapOff size={14} strokeWidth={2} aria-hidden="true" />
      </button>
    </>
  )
}
