import { invoke } from '@tauri-apps/api/core'

/** A yes/no question for the person, in a **native box on this window** — what every window but the admin-app uses (Notes: "Delete …?",
 * "Close without saving?"). It is the backend's `confirm_dialog`, not the dialog plugin's, because a page can ask questions too and so
 * they follow the rules every prompt of the app follows (`prompt_guard.rs`, `docs/app-security.md`): one at a time, and none — they
 * answer *no* — once the person has chosen "Prevent this app from showing prompts" (until the app restarts). Resolves to `true` only
 * when the person pressed *OK*. The box's title (who asks) and its buttons are the app's, not the caller's, so a page can't dress a
 * question up as something else. */
export async function confirm(message: string): Promise<boolean> {
  try {
    return await invoke<boolean>('confirm_dialog', { message })
  } catch {
    return false // refused (prompts prevented, or another one is showing): nothing was confirmed
  }
}
