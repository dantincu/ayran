import { GmailService } from './gmail'
import { OutlookService } from './outlook'
import { YahooService } from './yahoo'
import type { Account } from '../types/auth'
import type { Email, SearchParams, SortParams, ComposeData } from '../types/email'
import type { Folder } from '../types/folder'

type AnyService = GmailService | OutlookService | YahooService

function getService(account: Account): AnyService {
  switch (account.provider) {
    case 'gmail': return new GmailService(account)
    case 'outlook': return new OutlookService(account)
    case 'yahoo': return new YahooService(account)
  }
}

export async function fetchFolders(account: Account): Promise<Folder[]> {
  return getService(account).getFolders()
}

export async function fetchEmails(
  account: Account,
  folderId: string,
  page: number,
  pageSize: number,
  search: SearchParams,
  sort: SortParams
): Promise<{ emails: Email[]; totalCount: number }> {
  return getService(account).getEmails(folderId, page, pageSize, search, sort)
}

export async function sendEmail(account: Account, compose: ComposeData): Promise<void> {
  return getService(account).sendEmail(compose, account.email)
}

export async function markEmailAsRead(account: Account, emailId: string): Promise<void> {
  return getService(account).markAsRead(emailId)
}

export async function moveEmailToTrash(account: Account, emailId: string): Promise<void> {
  return getService(account).moveToTrash(emailId)
}

export async function batchMoveEmailsToTrash(account: Account, emailIds: string[]): Promise<void> {
  if (!emailIds.length) return
  const svc = getService(account)
  if (svc instanceof GmailService) {
    await svc.batchModifyLabels(emailIds, ['TRASH'], ['INBOX'])
  } else {
    await Promise.all(emailIds.map((id) => svc.moveToTrash(id)))
  }
}

export async function archiveEmail(account: Account, emailId: string): Promise<void> {
  const svc = getService(account)
  if (svc instanceof GmailService) await svc.modifyLabels(emailId, [], ['INBOX'])
}

export async function batchArchiveEmails(account: Account, emailIds: string[]): Promise<void> {
  const svc = getService(account)
  if (svc instanceof GmailService) await svc.batchModifyLabels(emailIds, [], ['INBOX'])
}

export async function modifyEmailLabels(
  account: Account, emailId: string, addIds: string[], removeIds: string[]
): Promise<void> {
  const svc = getService(account)
  if (svc instanceof GmailService) await svc.modifyLabels(emailId, addIds, removeIds)
}

export async function batchModifyEmailLabels(
  account: Account, emailIds: string[], addIds: string[], removeIds: string[]
): Promise<void> {
  const svc = getService(account)
  if (svc instanceof GmailService) await svc.batchModifyLabels(emailIds, addIds, removeIds)
}

export async function moveEmailToFolder(
  account: Account, emailId: string, folderId: string
): Promise<void> {
  const svc = getService(account)
  if (svc instanceof OutlookService) await svc.moveToFolder(emailId, folderId)
}

export async function batchMoveEmailsToFolder(
  account: Account, emailIds: string[], folderId: string
): Promise<void> {
  if (!emailIds.length) return
  const svc = getService(account)
  if (svc instanceof OutlookService) {
    await Promise.all(emailIds.map((id) => svc.moveToFolder(id, folderId)))
  }
}

export async function fetchEmailFull(account: Account, emailId: string): Promise<Partial<Email>> {
  const svc = getService(account)
  if (svc instanceof GmailService) return svc.getEmailFull(emailId)
  return {}
}

export async function fetchUserProfile(
  account: Account
): Promise<{ email: string; name: string; picture?: string }> {
  return getService(account).getUserProfile()
}
