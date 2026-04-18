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

export async function fetchUserProfile(
  account: Account
): Promise<{ email: string; name: string; picture?: string }> {
  return getService(account).getUserProfile()
}
