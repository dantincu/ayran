// The mail backend lives in the Tauri (Rust) side of the app: every call below is a Tauri command.
// Tokens and app passwords never cross into the webview — commands take an account id and the Rust
// side looks up (and refreshes) the account's encrypted credentials itself.
import { invoke } from '@tauri-apps/api/core'
import type { Account } from '../types/auth'
import type { Email, SearchParams, SortParams, ComposeData } from '../types/email'
import type { Folder } from '../types/folder'

/** Tauri rejects with the command's error string; normalise that into an Error. */
async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args)
  } catch (e) {
    throw e instanceof Error ? e : new Error(String(e))
  }
}

function withDate<T extends { date?: unknown }>(e: T): T {
  return e.date ? { ...e, date: new Date(e.date as string) } : e
}

// ── Accounts ────────────────────────────────────────────────────────────────

export function listAccounts(): Promise<Account[]> {
  return call<Account[]>('list_accounts')
}

export function removeAccount(accountId: string): Promise<void> {
  return call('remove_account', { accountId })
}

/** Runs the whole OAuth flow (system browser + loopback redirect); resolves with the new account. */
export function signInWithOAuth(provider: 'gmail' | 'outlook'): Promise<Account> {
  return call<Account>('oauth_sign_in', { provider })
}

export function cancelOAuthSignIn(): Promise<void> {
  return call('oauth_cancel')
}

export function connectYahoo(email: string, appPassword: string): Promise<Account> {
  return call<Account>('yahoo_connect', { email, appPassword })
}

// ── Folders and messages ───────────────────────────────────────────────────

export function fetchFolders(account: Account): Promise<Folder[]> {
  return call<Folder[]>('get_folders', { accountId: account.id })
}

export async function fetchEmails(
  account: Account,
  folderId: string,
  page: number,
  pageSize: number,
  search: SearchParams,
  sort: SortParams
): Promise<{ emails: Email[]; totalCount: number }> {
  const result = await call<{ emails: Email[]; totalCount: number }>('get_emails', {
    accountId: account.id,
    query: {
      folderId,
      page,
      pageSize,
      search: {
        ...search,
        after: search.after?.toISOString(),
        before: search.before?.toISOString(),
      },
      sort,
    },
  })
  result.emails = result.emails.map(withDate)
  return result
}

export function fetchEmailFull(account: Account, emailId: string): Promise<Partial<Email>> {
  return call<Partial<Email>>('get_email_full', { accountId: account.id, emailId })
}

export function sendEmail(account: Account, compose: ComposeData): Promise<void> {
  return call('send_email', {
    accountId: account.id,
    compose: {
      to: compose.to,
      cc: compose.cc,
      bcc: compose.bcc,
      subject: compose.subject,
      body: compose.body,
      inReplyTo: compose.inReplyTo,
      references: compose.references,
      threadId: compose.originalEmail?.threadId,
    },
  })
}

export function markEmailAsRead(account: Account, emailId: string): Promise<void> {
  return call('mark_as_read', { accountId: account.id, emailId })
}

// Single-message actions are the batch commands with one id.

export function moveEmailToTrash(account: Account, emailId: string): Promise<void> {
  return batchMoveEmailsToTrash(account, [emailId])
}

export function archiveEmail(account: Account, emailId: string): Promise<void> {
  return batchArchiveEmails(account, [emailId])
}

export function modifyEmailLabels(
  account: Account, emailId: string, addIds: string[], removeIds: string[]
): Promise<void> {
  return batchModifyEmailLabels(account, [emailId], addIds, removeIds)
}

export function moveEmailToFolder(account: Account, emailId: string, folderId: string): Promise<void> {
  return batchMoveEmailsToFolder(account, [emailId], folderId)
}

export function batchMoveEmailsToTrash(account: Account, emailIds: string[]): Promise<void> {
  return call('trash_emails', { accountId: account.id, emailIds })
}

export function batchArchiveEmails(account: Account, emailIds: string[]): Promise<void> {
  return call('archive_emails', { accountId: account.id, emailIds })
}

export function batchModifyEmailLabels(
  account: Account, emailIds: string[], addIds: string[], removeIds: string[]
): Promise<void> {
  return call('modify_labels', { accountId: account.id, emailIds, addIds, removeIds })
}

export function batchMoveEmailsToFolder(
  account: Account, emailIds: string[], folderId: string
): Promise<void> {
  return call('move_emails', { accountId: account.id, emailIds, folderId })
}

/** Opens a URL in the system browser (links inside messages must never navigate the app). */
export async function openExternal(url: string): Promise<void> {
  const { openUrl } = await import('@tauri-apps/plugin-opener')
  await openUrl(url)
}
