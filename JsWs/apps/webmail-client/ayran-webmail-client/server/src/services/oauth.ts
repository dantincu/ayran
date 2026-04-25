import crypto from 'crypto'
import axios from 'axios'
import type { OAuthTokens } from '../types'

export function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString('base64url')
}

export function generateCodeChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url')
}

export function generateState(): string {
  return crypto.randomBytes(16).toString('hex')
}

interface ProviderConfig {
  authUrl: string
  tokenUrl: string
  scope: string
  clientId: string
  clientSecret: string
}

function getConfig(provider: string): ProviderConfig {
  if (provider === 'gmail') {
    return {
      authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      scope: 'https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile',
      clientId: process.env.GMAIL_CLIENT_ID ?? '',
      clientSecret: process.env.GMAIL_CLIENT_SECRET ?? '',
    }
  }
  if (provider === 'outlook') {
    return {
      authUrl: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize',
      tokenUrl: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token',
      scope: 'offline_access https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/User.Read',
      clientId: process.env.OUTLOOK_CLIENT_ID ?? '',
      clientSecret: process.env.OUTLOOK_CLIENT_SECRET ?? '',
    }
  }
  if (provider === 'yahoo') {
    return {
      authUrl: 'https://api.login.yahoo.com/oauth2/request_auth',
      tokenUrl: 'https://api.login.yahoo.com/oauth2/get_token',
      scope: 'mail-w openid profile email',
      clientId: process.env.YAHOO_CLIENT_ID ?? '',
      clientSecret: process.env.YAHOO_CLIENT_SECRET ?? '',
    }
  }
  throw new Error(`Unknown provider: ${provider}`)
}

export function buildAuthUrl(provider: string, state: string, challenge: string): string {
  const cfg = getConfig(provider)
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: process.env.OAUTH_REDIRECT_URI ?? '',
    response_type: 'code',
    scope: cfg.scope,
    state: `${provider}:${state}`,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })
  if (provider === 'gmail') {
    params.set('access_type', 'offline')
    params.set('prompt', 'consent')
  }
  return `${cfg.authUrl}?${params}`
}

export async function exchangeCode(provider: string, code: string, verifier: string): Promise<OAuthTokens> {
  const cfg = getConfig(provider)
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: process.env.OAUTH_REDIRECT_URI ?? '',
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
  })
  if (cfg.clientSecret) params.set('client_secret', cfg.clientSecret)

  const res = await axios.post<{
    access_token: string
    refresh_token?: string
    expires_in: number
    scope: string
  }>(cfg.tokenUrl, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  })

  return {
    accessToken: res.data.access_token,
    refreshToken: res.data.refresh_token,
    expiresAt: Date.now() + res.data.expires_in * 1000,
    scope: res.data.scope ?? cfg.scope,
  }
}

export async function refreshTokens(provider: string, refreshToken: string): Promise<OAuthTokens> {
  const cfg = getConfig(provider)
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  })
  if (cfg.clientSecret) params.set('client_secret', cfg.clientSecret)

  const res = await axios.post<{
    access_token: string
    refresh_token?: string
    expires_in: number
    scope: string
  }>(cfg.tokenUrl, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  })

  return {
    accessToken: res.data.access_token,
    refreshToken: res.data.refresh_token ?? refreshToken,
    expiresAt: Date.now() + res.data.expires_in * 1000,
    scope: res.data.scope ?? cfg.scope,
  }
}

export async function fetchProfile(
  provider: string,
  accessToken: string
): Promise<{ email: string; displayName: string; avatarUrl?: string }> {
  if (provider === 'gmail') {
    const res = await axios.get<{ email: string; name: string; picture?: string }>(
      'https://www.googleapis.com/oauth2/v1/userinfo?alt=json',
      { headers: { Authorization: `Bearer ${accessToken}` } }
    )
    return { email: res.data.email, displayName: res.data.name, avatarUrl: res.data.picture }
  }
  if (provider === 'outlook') {
    const res = await axios.get<{ displayName: string; mail?: string; userPrincipalName: string }>(
      'https://graph.microsoft.com/v1.0/me?$select=displayName,mail,userPrincipalName',
      { headers: { Authorization: `Bearer ${accessToken}` } }
    )
    return { email: res.data.mail ?? res.data.userPrincipalName, displayName: res.data.displayName }
  }
  if (provider === 'yahoo') {
    const res = await axios.get<{ name?: string; nickname?: string; email: string; picture?: string }>(
      'https://api.login.yahoo.com/openid/v1/userinfo',
      { headers: { Authorization: `Bearer ${accessToken}` } }
    )
    return {
      email: res.data.email,
      displayName: res.data.name ?? res.data.nickname ?? res.data.email,
      avatarUrl: res.data.picture,
    }
  }
  throw new Error(`Unknown provider: ${provider}`)
}
