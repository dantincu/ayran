import { invoke } from '@tauri-apps/api/core'
import './prompt.css'

/** The window that shows **a page's own JavaScript dialog** (`alert`, `confirm`, `prompt`) on desktop — the backend turned the webview's
 * own dialogs off and shows them here instead (`src-tauri/src/page_dialogs_windows.rs`, under the rules of `prompt_guard.rs`). It says
 * who is talking as the *app* knows it (the page's words are only the message, set as text, never as markup), gives a `prompt` its
 * text box, and has the option *Prevent this app from showing prompts*. Closing the window is *Cancel*. */
interface DialogRequest {
  kind: 'alert' | 'confirm' | 'prompt'
  message: string
  defaultText: string
  who: string
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

invoke<DialogRequest>('prompt_dialog_info').then((request) => {
  $('who').textContent = request.who
  $('message').textContent = request.message
  const text = $<HTMLInputElement>('text')
  if (request.kind === 'prompt') {
    text.hidden = false
    text.value = request.defaultText
    text.focus()
    text.select()
  }
  if (request.kind === 'alert') $('cancel').hidden = true

  const answer = (action: 'ok' | 'cancel' | 'prevent') => invoke('prompt_dialog_answer', { action, text: request.kind === 'prompt' ? text.value : null }).catch(() => {})
  $('ok').addEventListener('click', () => answer('ok'))
  $('cancel').addEventListener('click', () => answer('cancel'))
  $('prevent').addEventListener('click', () => answer('prevent'))
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') answer('ok')
    else if (event.key === 'Escape') answer('cancel')
  })
  if (request.kind !== 'prompt') $('ok').focus()
})
