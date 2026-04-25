import { ImapFlow } from 'imapflow'
import nodemailer from 'nodemailer'
import { simpleParser } from 'mailparser'
import type { ComposeData } from '../types'

interface EmailAddress { name?: string; email: string }
interface EmailAttachment { id: string; filename: string; mimeType: string; size: number }

interface Email {
  id: string; threadId: string; provider: 'yahoo'; accountId: string
  subject: string; from: EmailAddress; to: EmailAddress[]; cc: EmailAddress[]; bcc: EmailAddress[]
  date: Date; snippet: string; body: string; bodyHtml?: string
  isRead: boolean; isStarred: boolean; labels: string[]; folderId: string
  attachments: EmailAttachment[]; inReplyTo?: string
}

interface Folder {
  id: string; name: string; type: string; provider: 'yahoo'; accountId: string
  unreadCount?: number; totalCount?: number; parentId?: string
}

interface SearchParams {
  subject?: string; body?: string; from?: string; to?: string; after?: Date; before?: Date
}

interface SortParams { field: 'date' | 'from' | 'to'; direction: 'asc' | 'desc' }

const IMAP_HOST = 'imap.mail.yahoo.com'
const IMAP_PORT = 993
const SMTP_HOST = 'smtp.mail.yahoo.com'
const SMTP_PORT = 465

const SPECIAL_USE_TYPE: Record<string, string> = {
  '\\Inbox': 'inbox', '\\Sent': 'sent', '\\Trash': 'trash',
  '\\Junk': 'spam', '\\Drafts': 'drafts', '\\All': 'all', '\\Archive': 'all',
}

const NAME_TYPE: Record<string, string> = {
  INBOX: 'inbox', Inbox: 'inbox',
  Sent: 'sent', 'Sent Messages': 'sent',
  Trash: 'trash', 'Deleted Messages': 'trash',
  'Bulk Mail': 'spam', Junk: 'spam', Spam: 'spam',
  Draft: 'drafts', Drafts: 'drafts',
}

function addrList(
  addrs: { name?: string; address?: string }[] | undefined
): EmailAddress[] {
  return (addrs ?? [])
    .filter((a) => a.address)
    .map((a) => a.name ? { name: a.name, email: a.address! } : { email: a.address! })
}

export class YahooService {
  constructor(
    private email: string,
    private appPassword: string,
    private accountId: string,
  ) {}

  private mkClient(): ImapFlow {
    return new ImapFlow({
      host: IMAP_HOST,
      port: IMAP_PORT,
      secure: true,
      auth: { user: this.email, pass: this.appPassword },
      logger: false,
    })
  }

  private async withClient<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    const client = this.mkClient()
    await client.connect()
    try {
      return await fn(client)
    } finally {
      try { await client.logout() } catch { /* ignore logout errors */ }
    }
  }

  private parseId(emailId: string): { mailbox: string; uid: number } {
    const sep = emailId.lastIndexOf('::')
    return { mailbox: emailId.slice(0, sep), uid: parseInt(emailId.slice(sep + 2)) }
  }

  private makeId(mailbox: string, uid: number): string {
    return `${mailbox}::${uid}`
  }

  private groupByMailbox(emailIds: string[]): Map<string, number[]> {
    const map = new Map<string, number[]>()
    for (const id of emailIds) {
      const { mailbox, uid } = this.parseId(id)
      const arr = map.get(mailbox) ?? []
      arr.push(uid)
      map.set(mailbox, arr)
    }
    return map
  }

  async verifyConnection(): Promise<void> {
    await this.withClient(async () => {})
  }

  async getFolders(): Promise<Folder[]> {
    return this.withClient(async (client) => {
      const mailboxes = await client.list()
      const folders: Folder[] = []

      for (const mbox of mailboxes) {
        if (mbox.flags.has('\\Noselect') || mbox.flags.has('\\NonExistent')) continue

        const delim = mbox.delimiter ?? '/'
        const lastDelimIdx = mbox.path.lastIndexOf(delim)
        const parentPath = lastDelimIdx > 0 ? mbox.path.slice(0, lastDelimIdx) : undefined

        const type =
          (mbox.specialUse ? SPECIAL_USE_TYPE[mbox.specialUse] : undefined) ??
          NAME_TYPE[mbox.name] ??
          NAME_TYPE[mbox.path] ??
          'custom'

        folders.push({
          id: mbox.path,
          name: mbox.path === 'INBOX' ? 'Inbox' : mbox.name,
          type,
          provider: 'yahoo' as const,
          accountId: this.accountId,
          parentId: parentPath,
        })
      }

      // Fetch unread / total counts in parallel
      await Promise.all(folders.map(async (folder) => {
        try {
          const status = await client.status(folder.id, { messages: true, unseen: true })
          folder.totalCount = status.messages
          folder.unreadCount = status.unseen
        } catch { /* some special folders don't support STATUS */ }
      }))

      return folders
    })
  }

  async getEmails(
    folderId: string, page: number, pageSize: number, search: SearchParams, sort: SortParams
  ): Promise<{ emails: Email[]; totalCount: number }> {
    return this.withClient(async (client) => {
      const lock = await client.getMailboxLock(folderId, { readOnly: true })
      try {
        const criteria: Record<string, unknown> = {}
        if (search.from) criteria.from = search.from
        if (search.to) criteria.to = search.to
        if (search.subject) criteria.subject = search.subject
        if (search.body) criteria.body = search.body
        if (search.after) criteria.since = search.after
        if (search.before) criteria.before = search.before
        if (!Object.keys(criteria).length) criteria.all = true

        const uids: number[] = (await client.search(criteria as Parameters<typeof client.search>[0], { uid: true })) || []

        uids.sort((a: number, b: number) => sort.direction === 'asc' ? a - b : b - a)

        const totalCount = uids.length
        const pageUids = uids.slice((page - 1) * pageSize, page * pageSize)

        if (pageUids.length === 0) return { emails: [], totalCount }

        const emails: Email[] = []
        for await (const msg of client.fetch(pageUids, { envelope: true, flags: true }, { uid: true })) {
          const env = msg.envelope ?? {}
          emails.push({
            id: this.makeId(folderId, msg.uid),
            threadId: this.makeId(folderId, msg.uid),
            provider: 'yahoo',
            accountId: this.accountId,
            subject: env.subject ?? '(no subject)',
            from: addrList(env.from as { name?: string; address?: string }[])[0] ?? { email: 'unknown' },
            to: addrList(env.to as { name?: string; address?: string }[]),
            cc: addrList(env.cc as { name?: string; address?: string }[]),
            bcc: addrList(env.bcc as { name?: string; address?: string }[]),
            date: env.date ?? new Date(),
            snippet: '',
            body: '',
            isRead: (msg.flags ?? new Set()).has('\\Seen'),
            isStarred: (msg.flags ?? new Set()).has('\\Flagged'),
            labels: [],
            folderId,
            attachments: [],
            inReplyTo: env.inReplyTo,
          })
        }

        return { emails, totalCount }
      } finally {
        lock.release()
      }
    })
  }

  async getEmailFull(emailId: string): Promise<Partial<Email>> {
    const { mailbox, uid } = this.parseId(emailId)
    return this.withClient(async (client) => {
      const lock = await client.getMailboxLock(mailbox, { readOnly: true })
      try {
        let result: Partial<Email> = { body: '', attachments: [] }
        for await (const msg of client.fetch([uid], { source: true }, { uid: true })) {
          if (!msg.source) continue
          const parsed = await simpleParser(msg.source)
          result = {
            body: parsed.text ?? '',
            bodyHtml: parsed.html || undefined,
            attachments: (parsed.attachments ?? []).map((a, i) => ({
              id: a.contentId ?? `att-${i}`,
              filename: a.filename ?? 'attachment',
              mimeType: a.contentType,
              size: a.size,
            })),
          }
        }
        return result
      } finally {
        lock.release()
      }
    })
  }

  async sendEmail(compose: ComposeData, fromEmail: string): Promise<void> {
    const transporter = nodemailer.createTransport({
      host: SMTP_HOST, port: SMTP_PORT, secure: true,
      auth: { user: this.email, pass: this.appPassword },
    })
    await transporter.sendMail({
      from: fromEmail,
      to: compose.to,
      cc: compose.cc || undefined,
      bcc: compose.bcc || undefined,
      subject: compose.subject,
      text: compose.body,
      ...(compose.inReplyTo ? { inReplyTo: compose.inReplyTo } : {}),
      ...(compose.references?.length ? { references: compose.references.join(' ') } : {}),
    })
  }

  async markAsRead(emailId: string): Promise<void> {
    const { mailbox, uid } = this.parseId(emailId)
    await this.withClient(async (client) => {
      const lock = await client.getMailboxLock(mailbox)
      try {
        await client.messageFlagsAdd([uid], ['\\Seen'], { uid: true })
      } finally {
        lock.release()
      }
    })
  }

  async moveToTrash(emailId: string): Promise<void> {
    const { mailbox, uid } = this.parseId(emailId)
    await this.withClient(async (client) => {
      const lock = await client.getMailboxLock(mailbox)
      try {
        await client.messageMove([uid], 'Trash', { uid: true })
      } finally {
        lock.release()
      }
    })
  }

  async moveToFolder(emailId: string, destFolderId: string): Promise<void> {
    const { mailbox, uid } = this.parseId(emailId)
    await this.withClient(async (client) => {
      const lock = await client.getMailboxLock(mailbox)
      try {
        await client.messageMove([uid], destFolderId, { uid: true })
      } finally {
        lock.release()
      }
    })
  }

  async batchMoveToTrash(emailIds: string[]): Promise<void> {
    if (!emailIds.length) return
    const grouped = this.groupByMailbox(emailIds)
    await this.withClient(async (client) => {
      for (const [mailbox, uids] of grouped) {
        const lock = await client.getMailboxLock(mailbox)
        try {
          await client.messageMove(uids, 'Trash', { uid: true })
        } finally {
          lock.release()
        }
      }
    })
  }

  async batchMoveToFolder(emailIds: string[], destFolderId: string): Promise<void> {
    if (!emailIds.length) return
    const grouped = this.groupByMailbox(emailIds)
    await this.withClient(async (client) => {
      for (const [mailbox, uids] of grouped) {
        const lock = await client.getMailboxLock(mailbox)
        try {
          await client.messageMove(uids, destFolderId, { uid: true })
        } finally {
          lock.release()
        }
      }
    })
  }
}
