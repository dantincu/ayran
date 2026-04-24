import type { Account } from '../types/auth'
import type { Email, SearchParams, SortParams, ComposeData } from '../types/email'
import type { Folder } from '../types/folder'

async function apiFetch<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`API ${res.status}: ${text}`)
  }
  return res.json() as Promise<T>
}

function mailUrl(accountId: string, path: string) {
  return `/api/mail/${accountId}${path}`
}

export async function fetchFolders(account: Account): Promise<Folder[]> {
  return apiFetch<Folder[]>(mailUrl(account.id, '/folders'))
}

export async function fetchEmails(
  account: Account,
  folderId: string,
  page: number,
  pageSize: number,
  search: SearchParams,
  sort: SortParams
): Promise<{ emails: Email[]; totalCount: number }> {
  const params = new URLSearchParams({
    folderId,
    page: String(page),
    pageSize: String(pageSize),
    sortField: sort.field,
    sortDir: sort.direction,
  })
  if (search.subject) params.set('subject', search.subject)
  if (search.subjectIsRegex) params.set('subjectIsRegex', 'true')
  if (search.body) params.set('body', search.body)
  if (search.bodyIsRegex) params.set('bodyIsRegex', 'true')
  if (search.from) params.set('from', search.from)
  if (search.to) params.set('to', search.to)
  if (search.after) params.set('after', search.after.toISOString())
  if (search.before) params.set('before', search.before.toISOString())

  const result = await apiFetch<{ emails: Email[]; totalCount: number }>(
    mailUrl(account.id, `/emails?${params}`)
  )
  result.emails = result.emails.map((e) => ({ ...e, date: new Date(e.date as unknown as string) }))
  return result
}

export async function fetchEmailFull(account: Account, emailId: string): Promise<Partial<Email>> {
  return apiFetch<Partial<Email>>(mailUrl(account.id, `/emails/${emailId}/full`))
}

export async function sendEmail(account: Account, compose: ComposeData): Promise<void> {
  const body = {
    to: compose.to, cc: compose.cc, bcc: compose.bcc,
    subject: compose.subject, body: compose.body,
    inReplyTo: compose.inReplyTo,
    references: compose.references,
    threadId: compose.originalEmail?.threadId,
  }
  await apiFetch(mailUrl(account.id, '/emails/send'), { method: 'POST', body: JSON.stringify(body) })
}

export async function markEmailAsRead(account: Account, emailId: string): Promise<void> {
  await apiFetch(mailUrl(account.id, `/emails/${emailId}/read`), { method: 'PATCH', body: '{}' })
}

export async function moveEmailToTrash(account: Account, emailId: string): Promise<void> {
  await apiFetch(mailUrl(account.id, `/emails/${emailId}/trash`), { method: 'POST', body: '{}' })
}

export async function archiveEmail(account: Account, emailId: string): Promise<void> {
  await apiFetch(mailUrl(account.id, `/emails/${emailId}/archive`), { method: 'POST', body: '{}' })
}

export async function modifyEmailLabels(
  account: Account, emailId: string, addIds: string[], removeIds: string[]
): Promise<void> {
  await apiFetch(mailUrl(account.id, `/emails/${emailId}/labels`), {
    method: 'POST', body: JSON.stringify({ addIds, removeIds }),
  })
}

export async function moveEmailToFolder(
  account: Account, emailId: string, folderId: string
): Promise<void> {
  await apiFetch(mailUrl(account.id, `/emails/${emailId}/move`), {
    method: 'POST', body: JSON.stringify({ folderId }),
  })
}

export async function batchMoveEmailsToTrash(account: Account, emailIds: string[]): Promise<void> {
  await apiFetch(mailUrl(account.id, '/emails/batch/trash'), {
    method: 'POST', body: JSON.stringify({ emailIds }),
  })
}

export async function batchArchiveEmails(account: Account, emailIds: string[]): Promise<void> {
  await apiFetch(mailUrl(account.id, '/emails/batch/archive'), {
    method: 'POST', body: JSON.stringify({ emailIds }),
  })
}

export async function batchModifyEmailLabels(
  account: Account, emailIds: string[], addIds: string[], removeIds: string[]
): Promise<void> {
  await apiFetch(mailUrl(account.id, '/emails/batch/labels'), {
    method: 'POST', body: JSON.stringify({ emailIds, addIds, removeIds }),
  })
}

export async function batchMoveEmailsToFolder(
  account: Account, emailIds: string[], folderId: string
): Promise<void> {
  await apiFetch(mailUrl(account.id, '/emails/batch/move'), {
    method: 'POST', body: JSON.stringify({ emailIds, folderId }),
  })
}

export async function fetchUserProfile(
  _account: Account
): Promise<{ email: string; name: string; picture?: string }> {
  // Profile is now fetched server-side during OAuth; this is kept for interface compatibility
  throw new Error('fetchUserProfile is no longer used — profile is fetched server-side during OAuth')
}
