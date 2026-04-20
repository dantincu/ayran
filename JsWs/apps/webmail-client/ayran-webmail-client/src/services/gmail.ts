import type { AxiosInstance, AxiosResponse } from 'axios'
import { createApiClient } from './apiClient'
import type { Email, EmailAddress, SearchParams, SortParams, ComposeData } from '../types/email'
import type { Folder } from '../types/folder'
import type { Account } from '../types/auth'

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
  const base64 = data.replace(/-/g, '+').replace(/_/g, '/')
  try {
    return decodeURIComponent(
      atob(base64)
        .split('')
        .map((c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0'))
        .join('')
    )
  } catch {
    return atob(base64)
  }
}

function extractBody(payload: GmailPayload): { text: string; html: string } {
  let text = ''
  let html = ''

  function walk(p: GmailPayload) {
    if (p.mimeType === 'text/plain' && p.body?.data) {
      text = decodeBase64Url(p.body.data)
    } else if (p.mimeType === 'text/html' && p.body?.data) {
      html = decodeBase64Url(p.body.data)
    } else if (p.parts) {
      p.parts.forEach(walk)
    }
  }

  walk(payload)
  return { text, html }
}

async function throttleAll<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number
): Promise<T[]> {
  const results: T[] = new Array(tasks.length)
  let next = 0
  async function worker() {
    while (next < tasks.length) {
      const i = next++
      results[i] = await tasks[i]()
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker))
  return results
}

interface GmailPayload {
  mimeType: string
  headers?: { name: string; value: string }[]
  body?: { data?: string; size: number; attachmentId?: string }
  parts?: GmailPayload[]
  filename?: string
  partId?: string
}

interface GmailMessage {
  id: string
  threadId: string
  labelIds: string[]
  snippet: string
  payload: GmailPayload
  internalDate: string
}

const FOLDER_MAP: Record<string, Folder['type']> = {
  INBOX: 'inbox',
  SENT: 'sent',
  SPAM: 'spam',
  TRASH: 'trash',
  ALLMAIL: 'all',
}

const LABEL_DISPLAY_NAMES: Record<string, string> = {
  INBOX: 'Inbox',
  SENT: 'Sent',
  SPAM: 'Spam',
  TRASH: 'Trash',
  ALLMAIL: 'All Mail',
  STARRED: 'Starred',
  IMPORTANT: 'Important',
  DRAFT: 'Drafts',
  CHAT: 'Chat',
  CATEGORY_PERSONAL: 'Personal',
  CATEGORY_SOCIAL: 'Social',
  CATEGORY_PROMOTIONS: 'Promotions',
  CATEGORY_UPDATES: 'Updates',
  CATEGORY_FORUMS: 'Forums',
}

const METADATA_HEADERS = ['From', 'To', 'Cc', 'Bcc', 'Subject', 'Date', 'In-Reply-To', 'References']

function parseGmailMessage(msg: GmailMessage, accountId: string): Email {
  const headers = msg.payload.headers ?? []
  const { text, html } = extractBody(msg.payload)
  const dateStr = getHeader(headers, 'Date')

  const attachments = (function collectAttachments(p: GmailPayload): Email['attachments'] {
    const result: Email['attachments'] = []
    if (p.filename && p.body?.attachmentId) {
      result.push({
        id: p.body.attachmentId,
        filename: p.filename,
        mimeType: p.mimeType,
        size: p.body.size,
      })
    }
    if (p.parts) {
      p.parts.forEach((part) => result.push(...collectAttachments(part)))
    }
    return result
  })(msg.payload)

  const folderId = msg.labelIds?.includes('INBOX')
    ? 'INBOX'
    : msg.labelIds?.[0] ?? 'INBOX'

  return {
    id: msg.id,
    threadId: msg.threadId,
    provider: 'gmail',
    accountId,
    subject: getHeader(headers, 'Subject'),
    from: parseEmailAddress(getHeader(headers, 'From')),
    to: parseAddressList(getHeader(headers, 'To')),
    cc: parseAddressList(getHeader(headers, 'Cc')),
    bcc: parseAddressList(getHeader(headers, 'Bcc')),
    date: dateStr ? new Date(dateStr) : new Date(parseInt(msg.internalDate)),
    snippet: msg.snippet,
    body: text,
    bodyHtml: html,
    isRead: !msg.labelIds?.includes('UNREAD'),
    isStarred: msg.labelIds?.includes('STARRED') ?? false,
    labels: msg.labelIds ?? [],
    folderId,
    attachments,
    inReplyTo: getHeader(headers, 'In-Reply-To'),
    references: getHeader(headers, 'References').split(/\s+/).filter(Boolean),
  }
}

export class GmailService {
  private client: AxiosInstance
  private accountId: string

  constructor(account: Account) {
    this.accountId = account.id
    this.client = createApiClient('gmail', account.id)
  }

  async getFolders(): Promise<Folder[]> {
    const res = await this.client.get<{
      labels: { id: string; name: string; type: string; messagesUnread?: number; messagesTotal?: number }[]
    }>('/users/me/labels')

    const folders: Folder[] = res.data.labels.map((label) => ({
      id: label.id,
      name: LABEL_DISPLAY_NAMES[label.id] ?? label.name,
      type: (FOLDER_MAP[label.id] ?? 'custom') as Folder['type'],
      provider: 'gmail' as const,
      accountId: this.accountId,
      unreadCount: label.messagesUnread,
      totalCount: label.messagesTotal,
    }))

    // Gmail never returns ALLMAIL from labels.list — inject it manually
    if (!folders.some((f) => f.id === 'ALLMAIL')) {
      folders.push({
        id: 'ALLMAIL',
        name: 'All Mail',
        type: 'all',
        provider: 'gmail',
        accountId: this.accountId,
      })
    }

    return folders
  }

  async getEmails(
    folderId: string,
    page: number,
    pageSize: number,
    search: SearchParams,
    sort: SortParams
  ): Promise<{ emails: Email[]; totalCount: number }> {
    // ALLMAIL has no label filter — Gmail returns all mail with an empty query
    let q = folderId === 'ALLMAIL' ? '' : `in:${folderId.toLowerCase()}`

    if (search.from) q += ` from:${search.from}`
    if (search.to) q += ` to:${search.to}`
    if (search.subject) {
      q += search.subjectIsRegex
        ? ` subject:${search.subject}`
        : ` subject:"${search.subject}"`
    }
    if (search.after) q += ` after:${Math.floor(search.after.getTime() / 1000)}`
    if (search.before) q += ` before:${Math.floor(search.before.getTime() / 1000)}`

    const pageToken = await this.getPageToken(q, page, pageSize)

    const listRes = await this.client.get<{
      messages?: { id: string }[]
      resultSizeEstimate: number
      nextPageToken?: string
    }>('/users/me/messages', {
      params: { q, maxResults: pageSize, pageToken: pageToken ?? undefined },
    })

    const messages = listRes.data.messages ?? []
    const totalCount = listRes.data.resultSizeEstimate

    // Fetch metadata only (no body) for the list — max 3 concurrent to avoid 429.
    // metadataHeaders must be repeated query params, not comma-separated.
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
        const aName = a.from.name ?? a.from.email
        const bName = b.from.name ?? b.from.email
        return sort.direction === 'asc' ? aName.localeCompare(bName) : bName.localeCompare(aName)
      })
    } else if (sort.field === 'to') {
      emails.sort((a, b) => {
        const aTo = a.to[0]?.email ?? ''
        const bTo = b.to[0]?.email ?? ''
        return sort.direction === 'asc' ? aTo.localeCompare(bTo) : bTo.localeCompare(aTo)
      })
    }

    return { emails, totalCount }
  }

  // Fetches the full email body — called only when opening an email
  async getEmailFull(emailId: string): Promise<Partial<Email>> {
    const res = await this.client.get<GmailMessage>(`/users/me/messages/${emailId}`, {
      params: { format: 'full' },
    })
    const { text, html } = extractBody(res.data.payload)
    const headers = res.data.payload.headers ?? []

    const attachments = (function collectAttachments(p: GmailPayload): Email['attachments'] {
      const result: Email['attachments'] = []
      if (p.filename && p.body?.attachmentId) {
        result.push({ id: p.body.attachmentId, filename: p.filename, mimeType: p.mimeType, size: p.body.size })
      }
      if (p.parts) p.parts.forEach((part) => result.push(...collectAttachments(part)))
      return result
    })(res.data.payload)

    return {
      body: text,
      bodyHtml: html,
      attachments,
      inReplyTo: getHeader(headers, 'In-Reply-To'),
      references: getHeader(headers, 'References').split(/\s+/).filter(Boolean),
    }
  }

  private async getPageToken(q: string, page: number, pageSize: number): Promise<string | null> {
    if (page <= 1) return null
    let token: string | null = null
    for (let i = 1; i < page; i++) {
      const pageRes: AxiosResponse<{ nextPageToken?: string }> = await this.client.get('/users/me/messages', {
        params: { q, maxResults: pageSize, pageToken: token ?? undefined, fields: 'nextPageToken' },
      })
      token = pageRes.data.nextPageToken ?? null
      if (!token) break
    }
    return token
  }

  async sendEmail(compose: ComposeData, fromEmail: string): Promise<void> {
    const headers = [
      `From: ${fromEmail}`,
      `To: ${compose.to}`,
      compose.cc ? `Cc: ${compose.cc}` : '',
      compose.bcc ? `Bcc: ${compose.bcc}` : '',
      `Subject: ${compose.subject}`,
      compose.inReplyTo ? `In-Reply-To: ${compose.inReplyTo}` : '',
      compose.references?.length ? `References: ${compose.references.join(' ')}` : '',
      'Content-Type: text/plain; charset=utf-8',
      'MIME-Version: 1.0',
    ]
      .filter(Boolean)
      .join('\r\n')

    const raw = btoa(unescape(encodeURIComponent(`${headers}\r\n\r\n${compose.body}`)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')

    const body: Record<string, string> = { raw }
    if (compose.inReplyTo && compose.originalEmail?.threadId) {
      body.threadId = compose.originalEmail.threadId
    }

    await this.client.post('/users/me/messages/send', body)
  }

  async markAsRead(emailId: string): Promise<void> {
    await this.client.post(`/users/me/messages/${emailId}/modify`, {
      removeLabelIds: ['UNREAD'],
    })
  }

  async moveToTrash(emailId: string): Promise<void> {
    await this.client.post(`/users/me/messages/${emailId}/trash`)
  }

  async getUserProfile(): Promise<{ email: string; name: string; picture?: string }> {
    const res = await this.client.get<{ emailAddress: string; messagesTotal: number }>(
      '/users/me/profile'
    )
    const profileRes = await fetch(
      `https://www.googleapis.com/oauth2/v1/userinfo?alt=json`,
      { headers: { Authorization: this.client.defaults.headers.common.Authorization as string } }
    )
    const profile = await profileRes.json() as { name: string; picture?: string }
    return { email: res.data.emailAddress, name: profile.name, picture: profile.picture }
  }
}
