import type { EmailProvider } from './email'

export interface Account {
  id: string
  provider: EmailProvider
  email: string
  displayName: string
  avatarUrl?: string
}
