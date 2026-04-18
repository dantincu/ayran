export type EmailProvider = 'gmail' | 'outlook' | 'yahoo'

export interface EmailAddress {
  name?: string
  email: string
}

export interface EmailAttachment {
  id: string
  filename: string
  mimeType: string
  size: number
  data?: string
}

export interface Email {
  id: string
  threadId?: string
  provider: EmailProvider
  accountId: string
  subject: string
  from: EmailAddress
  to: EmailAddress[]
  cc: EmailAddress[]
  bcc: EmailAddress[]
  date: Date
  snippet: string
  body: string
  bodyHtml?: string
  isRead: boolean
  isStarred: boolean
  labels: string[]
  folderId: string
  attachments: EmailAttachment[]
  inReplyTo?: string
  references?: string[]
}

export interface SearchParams {
  subject?: string
  subjectIsRegex?: boolean
  body?: string
  bodyIsRegex?: boolean
  from?: string
  to?: string
  after?: Date
  before?: Date
}

export type SortField = 'date' | 'from' | 'to'
export type SortDirection = 'asc' | 'desc'

export interface SortParams {
  field: SortField
  direction: SortDirection
}

export interface EmailListState {
  emails: Email[]
  totalCount: number
  currentPage: number
  pageSize: number
  isLoading: boolean
  error: string | null
}

export interface ComposeData {
  to: string
  cc: string
  bcc: string
  subject: string
  body: string
  inReplyTo?: string
  references?: string[]
  originalEmail?: Email
  mode: 'compose' | 'reply' | 'replyAll' | 'forward'
}
