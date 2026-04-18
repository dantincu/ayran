import type { EmailProvider } from './email'

export type FolderType = 'inbox' | 'sent' | 'all' | 'trash' | 'spam' | 'custom'

export interface Folder {
  id: string
  name: string
  type: FolderType
  provider: EmailProvider
  accountId: string
  unreadCount?: number
  totalCount?: number
  children?: Folder[]
  parentId?: string
  labelColor?: string
}
