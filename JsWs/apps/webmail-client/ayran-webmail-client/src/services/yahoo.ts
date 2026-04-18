import { createApiClient } from './apiClient'
import type { Email, SearchParams, SortParams, ComposeData } from '../types/email'
import type { Folder } from '../types/folder'
import type { Account } from '../types/auth'

export class YahooService {
  private client
  private accountId: string

  constructor(account: Account) {
    this.accountId = account.id
    this.client = createApiClient('yahoo', account.id)
  }

  async getFolders(): Promise<Folder[]> {
    const res = await this.client.get<{
      folders: { fid: string; name: string; unread?: number; total?: number }[]
    }>('/folders')
    const typeMap: Record<string, Folder['type']> = {
      Inbox: 'inbox',
      Sent: 'sent',
      Trash: 'trash',
      Spam: 'spam',
      Bulk: 'spam',
      Archive: 'all',
    }
    return res.data.folders.map((f) => ({
      id: f.fid,
      name: f.name,
      type: typeMap[f.name] ?? 'custom',
      provider: 'yahoo' as const,
      accountId: this.accountId,
      unreadCount: f.unread,
      totalCount: f.total,
    }))
  }

  async getEmails(
    folderId: string,
    page: number,
    pageSize: number,
    _search: SearchParams,
    _sort: SortParams
  ): Promise<{ emails: Email[]; totalCount: number }> {
    const offset = (page - 1) * pageSize
    const res = await this.client.get<{
      messages: {
        mid: string
        fid: string
        subject: string
        from: { email: string; name?: string }
        to: { email: string; name?: string }[]
        cc: { email: string; name?: string }[]
        date: string
        snippet: string
        body?: string
        bodyHtml?: string
        unread: boolean
        starred: boolean
      }[]
      totalCount: number
    }>(`/messages`, {
      params: { fid: folderId, limit: pageSize, offset },
    })

    const emails: Email[] = res.data.messages.map((m) => ({
      id: m.mid,
      provider: 'yahoo' as const,
      accountId: this.accountId,
      subject: m.subject,
      from: m.from,
      to: m.to,
      cc: m.cc ?? [],
      bcc: [],
      date: new Date(m.date),
      snippet: m.snippet,
      body: m.body ?? '',
      bodyHtml: m.bodyHtml,
      isRead: !m.unread,
      isStarred: m.starred,
      labels: [],
      folderId: m.fid,
      attachments: [],
    }))

    return { emails, totalCount: res.data.totalCount }
  }

  async sendEmail(compose: ComposeData, _fromEmail: string): Promise<void> {
    await this.client.post('/messages/send', {
      to: compose.to,
      cc: compose.cc ?? '',
      bcc: compose.bcc ?? '',
      subject: compose.subject,
      body: compose.body,
    })
  }

  async markAsRead(emailId: string): Promise<void> {
    await this.client.put(`/messages/${emailId}`, { unread: false })
  }

  async moveToTrash(emailId: string): Promise<void> {
    await this.client.put(`/messages/${emailId}/move`, { fid: 'Trash' })
  }

  async getUserProfile(): Promise<{ email: string; name: string }> {
    const res = await this.client.get<{ profile: { email: string; name: string } }>('/profile')
    return res.data.profile
  }
}
