import type { EmailProvider } from './email'

export interface OAuthTokens {
  accessToken: string
  refreshToken?: string
  expiresAt: number
  scope: string
}

export interface Account {
  id: string
  provider: EmailProvider
  email: string
  displayName: string
  avatarUrl?: string
  tokens: OAuthTokens
}
