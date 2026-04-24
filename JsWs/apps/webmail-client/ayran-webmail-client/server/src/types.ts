import 'express-session'

export interface OAuthTokens {
  accessToken: string
  refreshToken?: string
  expiresAt: number
  scope: string
}

export interface SessionAccount {
  id: string
  provider: 'gmail' | 'outlook'
  email: string
  displayName: string
  avatarUrl?: string
  tokens: OAuthTokens
}

export interface ClientAccount {
  id: string
  provider: 'gmail' | 'outlook'
  email: string
  displayName: string
  avatarUrl?: string
}

export interface ComposeData {
  to: string
  cc?: string
  bcc?: string
  subject: string
  body: string
  inReplyTo?: string
  references?: string[]
  threadId?: string
}

declare module 'express-session' {
  interface SessionData {
    accounts: Record<string, SessionAccount>
    oauthPending?: {
      provider: string
      verifier: string
      state: string
    }
  }
}
