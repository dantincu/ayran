import axios, { type AxiosInstance, type AxiosResponse } from 'axios'
import type { ComposeData } from '../types'

interface EmailAddress { name?: string; email: string }

interface EmailAttachment { id: string; filename: string; mimeType: string; size: number }

interface Email {
  id: string; threadId: string; provider: 'gmail'; accountId: string
  subject: string; from: EmailAddress; to: EmailAddress[]; cc: EmailAddress[]; bcc: EmailAddress[]
  date: Date; snippet: string; body: string; bodyHtml?: string
  isRead: boolean; isStarred: boolean; labels: string[]; folderId: string
  attachments: EmailAttachment[]; inReplyTo?: string; references?: string[]
}

interface Folder {
  id: string; name: string; type: string; provider: 'gmail'; accountId: string
  unreadCount?: number; totalCount?: number; parentId?: string
}

interface SearchParams {
  subject?: string; subjectIsRegex?: boolean; body?: string; bodyIsRegex?: boolean
  from?: string; to?: string; after?: Date; before?: Date
}

interface SortParams { field: 'date' | 'from' | 'to'; direction: 'asc' | 'desc' }

interface GmailPayload {
  mimeType: string
  headers?: { name: string; value: string }[]
  body?: { data?: string; size: number; attachmentId?: string }
  parts?: GmailPayload[]
  filename?: string
}

interface GmailMessage {
  id: string; threadId: string; labelIds: string[]; snippet: string
  payload: GmailPayload; internalDate: string
}

const FOLDER_MAP: Record<string, string> = {
  INBOX: 'inbox', SENT: 'sent', SPAM: 'spam', TRASH: 'trash', ALLMAIL: 'all',
}

const LABEL_DISPLAY_NAMES: Record<string, string> = {
  INBOX: 'Inbox', SENT: 'Sent', SPAM: 'Spam', TRASH: 'Trash', ALLMAIL: 'All Mail',
  STARRED: 'Starred', IMPORTANT: 'Important', DRAFT: 'Drafts', CHAT: 'Chat',
  CATEGORY_PERSONAL: 'Personal', CATEGORY_SOCIAL: 'Social', CATEGORY_PROMOTIONS: 'Promotions',
  CATEGORY_UPDATES: 'Updates', CATEGORY_FORUMS: 'Forums',
}

const METADATA_HEADERS = ['From', 'To', 'Cc', 'Bcc', 'Subject', 'Date', 'In-Reply-To', 'References']

function parseEmailAddress(raw: string): EmailAddress {
  if (!raw?.trim()) return { email: 'unknown' }
  const match = raw.match(/^(.*?)\s*<(.+?)>$/)
  if (match) {
    const name = match[1].trim().replace(/^"|"$/g, '')
    return name ? { name, email: match[2] } : { email: match[2] }
  }
  return { email: raw.trim() || 'unknown' }
}

function parseAddressList(raw: string | undefined): EmailAddress[] {
  if (!raw) return []
  return raw.split(',').map((a) => parseEmailAddress(a.trim()))
}

function getHeader(headers: { name: string; value: string }[], name: string): string {
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? ''
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data, 'base64url').toString('utf-8')
}

function extractBody(payload: GmailPayload): { text: string; html: string } {
  let text = '', html = ''
  function walk(p: GmailPayload) {
    if (p.mimeType === 'text/plain' && p.body?.data) text = decodeBase64Url(p.body.data)
    else if (p.mimeType === 'text/html' && p.body?.data) html = decodeBase64Url(p.body.data)
    else if (p.parts) p.parts.forEach(walk)
  }
  walk(payload)
  return { text, html }
}

function collectAttachments(p: GmailPayload): EmailAttachment[] {
  const result: EmailAttachment[] = []
  if (p.filename && p.body?.attachmentId) {
    result.push({ id: p.body.attachmentId, filename: p.filename, mimeType: p.mimeType, size: p.body.size })
  }
  if (p.parts) p.parts.forEach((part) => result.push(...collectAttachments(part)))
  return result
}

async function throttleAll<T>(tasks: (() => Promise<T>)[], concurrency: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length)
  let next = 0
  async function worker() {
    while (next < tasks.length) { const i = next++; results[i] = await tasks[i]() }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker))
  return results
}

function parseGmailMessage(msg: GmailMessage, accountId: string): Email {
  const headers = msg.payload.headers ?? []
  const { text, html } = extractBody(msg.payload)
  const dateStr = getHeader(headers, 'Date')
  const folderId = msg.labelIds?.includes('INBOX') ? 'INBOX' : msg.labelIds?.[0] ?? 'INBOX'
  return {
    id: msg.id, threadId: msg.threadId, provider: 'gmail', accountId,
    subject: getHeader(headers, 'Subject'),
    from: parseEmailAddress(getHeader(headers, 'From')),
    to: parseAddressList(getHeader(headers, 'To')),
    cc: parseAddressList(getHeader(headers, 'Cc')),
    bcc: parseAddressList(getHeader(headers, 'Bcc')),
    date: dateStr ? new Date(dateStr) : new Date(parseInt(msg.internalDate)),
    snippet: msg.snippet, body: text, bodyHtml: html,
    isRead: !msg.labelIds?.includes('UNREAD'),
    isStarred: msg.labelIds?.includes('STARRED') ?? false,
    labels: msg.labelIds ?? [], folderId,
    attachments: collectAttachments(msg.payload),
    inReplyTo: getHeader(headers, 'In-Reply-To'),
    references: getHeader(headers, 'References').split(/\s+/).filter(Boolean),
  }
}

export class GmailService {
  private client: AxiosInstance

  constructor(accessToken: string, private accountId: string) {
    this.client = axios.create({
      baseURL: 'https://gmail.googleapis.com/gmail/v1',
      headers: { Authorization: `Bearer ${accessToken}` },
    })
  }

  async getFolders(): Promise<Folder[]> {
    const res = await this.client.get<{
      labels: { id: string; name: string; type: string; messagesUnread?: number; messagesTotal?: number }[]
    }>('/users/me/labels')

    const folders: Folder[] = res.data.labels.map((label) => ({
      id: label.id,
      name: LABEL_DISPLAY_NAMES[label.id] ?? label.name.split('/').pop()!,
      type: FOLDER_MAP[label.id] ?? 'custom',
      provider: 'gmail' as const,
      accountId: this.accountId,
      unreadCount: label.messagesUnread,
      totalCount: label.messagesTotal,
    }))

    if (!folders.some((f) => f.id === 'ALLMAIL')) {
      folders.push({ id: 'ALLMAIL', name: 'All Mail', type: 'all', provider: 'gmail', accountId: this.accountId })
    }

    const nameToId = new Map(res.data.labels.map((l) => [l.name, l.id]))
    for (const label of res.data.labels) {
      const slashIdx = label.name.lastIndexOf('/')
      if (slashIdx === -1) continue
      const parentId = nameToId.get(label.name.slice(0, slashIdx))
      if (parentId) {
        const folder = folders.find((f) => f.id === label.id)
        if (folder) folder.parentId = parentId
      }
    }

    return folders
  }

  async getEmails(
    folderId: string, page: number, pageSize: number, search: SearchParams, sort: SortParams
  ): Promise<{ emails: Email[]; totalCount: number }> {
    let q = ''
    if (search.from) q += ` from:${search.from}`
    if (search.to) q += ` to:${search.to}`
    if (search.subject) q += search.subjectIsRegex ? ` subject:${search.subject}` : ` subject:"${search.subject}"`
    if (search.after) q += ` after:${Math.floor(search.after.getTime() / 1000)}`
    if (search.before) q += ` before:${Math.floor(search.before.getTime() / 1000)}`
    q = q.trim()

    const labelIds = folderId !== 'ALLMAIL' ? folderId : undefined
    const pageToken = await this.getPageToken(q, page, pageSize, labelIds)

    const listRes = await this.client.get<{
      messages?: { id: string }[]; resultSizeEstimate: number; nextPageToken?: string
    }>('/users/me/messages', {
      params: { q: q || undefined, labelIds, maxResults: pageSize, pageToken: pageToken ?? undefined },
    })

    const messages = listRes.data.messages ?? []
    const totalCount = listRes.data.resultSizeEstimate

    const emails = await throttleAll(
      messages.map((m) => () => {
        const qs = new URLSearchParams({ format: 'metadata' })
        METADATA_HEADERS.forEach((h) => qs.append('metadataHeaders', h))
        return this.client
          .get<GmailMessage>(`/users/me/messages/${m.id}?${qs}`)
          .then((r) => parseGmailMessage(r.data, this.accountId))
      }),
      3
    )

    if (sort.field === 'from') {
      emails.sort((a, b) => {
        const an = a.from.name ?? a.from.email, bn = b.from.name ?? b.from.email
        return sort.direction === 'asc' ? an.localeCompare(bn) : bn.localeCompare(an)
      })
    } else if (sort.field === 'to') {
      emails.sort((a, b) => {
        const at = a.to[0]?.email ?? '', bt = b.to[0]?.email ?? ''
        return sort.direction === 'asc' ? at.localeCompare(bt) : bt.localeCompare(at)
      })
    }

    return { emails, totalCount }
  }

  async getEmailFull(emailId: string): Promise<Partial<Email>> {
    const res = await this.client.get<GmailMessage>(`/users/me/messages/${emailId}`, {
      params: { format: 'full' },
    })
    const { text, html } = extractBody(res.data.payload)
    const headers = res.data.payload.headers ?? []
    return {
      body: text, bodyHtml: html,
      attachments: collectAttachments(res.data.payload),
      inReplyTo: getHeader(headers, 'In-Reply-To'),
      references: getHeader(headers, 'References').split(/\s+/).filter(Boolean),
    }
  }

  private async getPageToken(q: string, page: number, pageSize: number, labelIds?: string): Promise<string | null> {
    if (page <= 1) return null
    let token: string | null = null
    for (let i = 1; i < page; i++) {
      const r: AxiosResponse<{ nextPageToken?: string }> = await this.client.get('/users/me/messages', {
        params: { q: q || undefined, labelIds, maxResults: pageSize, pageToken: token ?? undefined, fields: 'nextPageToken' },
      })
      token = r.data.nextPageToken ?? null
      if (!token) break
    }
    return token
  }

  async sendEmail(compose: ComposeData, fromEmail: string): Promise<void> {
    const lines = [
      `From: ${fromEmail}`, `To: ${compose.to}`,
      compose.cc ? `Cc: ${compose.cc}` : '',
      compose.bcc ? `Bcc: ${compose.bcc}` : '',
      `Subject: ${compose.subject}`,
      compose.inReplyTo ? `In-Reply-To: ${compose.inReplyTo}` : '',
      compose.references?.length ? `References: ${compose.references.join(' ')}` : '',
      'Content-Type: text/plain; charset=utf-8', 'MIME-Version: 1.0',
    ]
    const raw = Buffer.from(lines.filter(Boolean).join('\r\n') + `\r\n\r\n${compose.body}`, 'utf-8').toString('base64url')
    const body: Record<string, string> = { raw }
    if (compose.threadId) body.threadId = compose.threadId
    await this.client.post('/users/me/messages/send', body)
  }

  async markAsRead(emailId: string): Promise<void> {
    await this.client.post(`/users/me/messages/${emailId}/modify`, { removeLabelIds: ['UNREAD'] })
  }

  async modifyLabels(emailId: string, addLabelIds: string[], removeLabelIds: string[]): Promise<void> {
    await this.client.post(`/users/me/messages/${emailId}/modify`, { addLabelIds, removeLabelIds })
  }

  async batchModifyLabels(emailIds: string[], addLabelIds: string[], removeLabelIds: string[]): Promise<void> {
    if (!emailIds.length) return
    await this.client.post('/users/me/messages/batchModify', { ids: emailIds, addLabelIds, removeLabelIds })
  }

  async moveToTrash(emailId: string): Promise<void> {
    await this.client.post(`/users/me/messages/${emailId}/trash`)
  }
}
