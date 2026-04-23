import { createApiClient } from './apiClient'
import type { Email, EmailAddress, SearchParams, SortParams, ComposeData } from '../types/email'
import type { Folder } from '../types/folder'
import type { Account } from '../types/auth'

interface GraphAddress { name?: string; address: string }
interface GraphRecipient { emailAddress: GraphAddress }
interface GraphMessage {
  id: string
  conversationId: string
  subject: string
  from: GraphRecipient
  toRecipients: GraphRecipient[]
  ccRecipients: GraphRecipient[]
  bccRecipients: GraphRecipient[]
  receivedDateTime: string
  bodyPreview: string
  body: { contentType: string; content: string }
  isRead: boolean
  flag: { flagStatus: string }
  parentFolderId: string
  hasAttachments: boolean
  attachments?: { id: string; name: string; contentType: string; size: number }[]
  internetMessageId?: string
  inferenceClassification?: string
}

interface GraphFolder {
  id: string
  displayName: string
  unreadItemCount: number
  totalItemCount: number
  childFolderCount: number
  wellKnownName?: string
}

const WELL_KNOWN_MAP: Record<string, Folder['type']> = {
  inbox: 'inbox',
  sentitems: 'sent',
  deleteditems: 'trash',
  junkemail: 'spam',
  archive: 'all',
}

function parseAddr(r: GraphRecipient): EmailAddress {
  return { name: r.emailAddress.name, email: r.emailAddress.address }
}

function parseGraphMessage(msg: GraphMessage, accountId: string): Email {
  return {
    id: msg.id,
    threadId: msg.conversationId,
    provider: 'outlook',
    accountId,
    subject: msg.subject,
    from: parseAddr(msg.from),
    to: msg.toRecipients.map(parseAddr),
    cc: msg.ccRecipients.map(parseAddr),
    bcc: msg.bccRecipients.map(parseAddr),
    date: new Date(msg.receivedDateTime),
    snippet: msg.bodyPreview,
    body: msg.body.contentType === 'text' ? msg.body.content : '',
    bodyHtml: msg.body.contentType === 'html' ? msg.body.content : undefined,
    isRead: msg.isRead,
    isStarred: msg.flag?.flagStatus === 'flagged',
    labels: [],
    folderId: msg.parentFolderId,
    attachments: (msg.attachments ?? []).map((a) => ({
      id: a.id,
      filename: a.name,
      mimeType: a.contentType,
      size: a.size,
    })),
    inReplyTo: msg.internetMessageId,
  }
}

export class OutlookService {
  private client
  private accountId: string

  constructor(account: Account) {
    this.accountId = account.id
    this.client = createApiClient('outlook', account.id)
  }

  async getFolders(): Promise<Folder[]> {
    const result: Folder[] = []

    const fetchLevel = async (url: string, parentId?: string): Promise<void> => {
      let nextLink: string | undefined = url
      while (nextLink) {
        const res = await this.client.get<{
          value: GraphFolder[]
          '@odata.nextLink'?: string
        }>(nextLink, { params: nextLink === url ? { $top: 100 } : undefined })

        for (const f of res.data.value) {
          result.push({
            id: f.id,
            name: f.displayName,
            type: (WELL_KNOWN_MAP[f.wellKnownName?.toLowerCase() ?? ''] ?? 'custom') as Folder['type'],
            provider: 'outlook' as const,
            accountId: this.accountId,
            unreadCount: f.unreadItemCount,
            totalCount: f.totalItemCount,
            parentId,
          })
          if (f.childFolderCount > 0)
            await fetchLevel(`/me/mailFolders/${f.id}/childFolders`, f.id)
        }

        nextLink = res.data['@odata.nextLink']
      }
    }

    await fetchLevel('/me/mailFolders')
    return result
  }

  async getEmails(
    folderId: string,
    page: number,
    pageSize: number,
    search: SearchParams,
    sort: SortParams
  ): Promise<{ emails: Email[]; totalCount: number }> {
    const skip = (page - 1) * pageSize
    const filters: string[] = []

    if (search.from) filters.push(`from/emailAddress/address eq '${search.from}'`)
    if (search.after) filters.push(`receivedDateTime ge ${search.after.toISOString()}`)
    if (search.before) filters.push(`receivedDateTime le ${search.before.toISOString()}`)

    const orderField =
      sort.field === 'date'
        ? 'receivedDateTime'
        : sort.field === 'from'
        ? 'from/emailAddress/address'
        : 'toRecipients/emailAddress/address'

    const params: Record<string, string | number> = {
      $top: pageSize,
      $skip: skip,
      $count: 'true',
      $orderby: `${orderField} ${sort.direction}`,
      $select:
        'id,conversationId,subject,from,toRecipients,ccRecipients,bccRecipients,receivedDateTime,bodyPreview,body,isRead,flag,parentFolderId,hasAttachments,internetMessageId',
    }

    if (search.subject) params.$search = `"subject:${search.subject}"`
    if (filters.length) params.$filter = filters.join(' and ')

    const res = await this.client.get<{
      value: GraphMessage[]
      '@odata.count'?: number
    }>(`/me/mailFolders/${folderId}/messages`, { params })

    const emails = res.data.value.map((m) => parseGraphMessage(m, this.accountId))
    return { emails, totalCount: res.data['@odata.count'] ?? emails.length }
  }

  async sendEmail(compose: ComposeData, fromEmail: string): Promise<void> {
    const message = {
      message: {
        subject: compose.subject,
        body: { contentType: 'Text', content: compose.body },
        toRecipients: compose.to
          .split(',')
          .map((e) => ({ emailAddress: { address: e.trim() } })),
        ccRecipients: compose.cc
          ? compose.cc.split(',').map((e) => ({ emailAddress: { address: e.trim() } }))
          : [],
        bccRecipients: compose.bcc
          ? compose.bcc.split(',').map((e) => ({ emailAddress: { address: e.trim() } }))
          : [],
      },
    }
    await this.client.post('/me/sendMail', message)
    void fromEmail
  }

  async markAsRead(emailId: string): Promise<void> {
    await this.client.patch(`/me/messages/${emailId}`, { isRead: true })
  }

  async moveToTrash(emailId: string): Promise<void> {
    await this.client.post(`/me/messages/${emailId}/move`, {
      destinationId: 'deleteditems',
    })
  }

  async getUserProfile(): Promise<{ email: string; name: string; picture?: string }> {
    const res = await this.client.get<{ displayName: string; mail: string; userPrincipalName: string }>(
      '/me',
      { params: { $select: 'displayName,mail,userPrincipalName' } }
    )
    return {
      email: res.data.mail ?? res.data.userPrincipalName,
      name: res.data.displayName,
    }
  }
}
