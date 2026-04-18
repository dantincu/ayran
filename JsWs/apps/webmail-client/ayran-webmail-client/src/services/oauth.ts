import type { EmailProvider } from '../types/email'
import type { OAuthTokens } from '../types/auth'

function generateCodeVerifier(): string {
  const array = new Uint8Array(32)
  crypto.getRandomValues(array)
  return btoa(String.fromCharCode(...array))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(verifier)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
}

const PROVIDER_CONFIGS: Record<
  EmailProvider,
  { authUrl: string; tokenUrl: string; scopes: string; clientId: string }
> = {
  gmail: {
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes:
      'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile',
    clientId: import.meta.env.VITE_GMAIL_CLIENT_ID ?? '',
  },
  outlook: {
    authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scopes:
      'https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/User.Read offline_access',
    clientId: import.meta.env.VITE_OUTLOOK_CLIENT_ID ?? '',
  },
  yahoo: {
    authUrl: 'https://api.login.yahoo.com/oauth2/request_auth',
    tokenUrl: 'https://api.login.yahoo.com/oauth2/get_token',
    scopes: 'mail-r mail-w',
    clientId: import.meta.env.VITE_YAHOO_CLIENT_ID ?? '',
  },
}

const REDIRECT_URI =
  import.meta.env.VITE_OAUTH_REDIRECT_URI ?? 'http://localhost:5173/oauth/callback'

export async function initiateOAuth(provider: EmailProvider): Promise<void> {
  const config = PROVIDER_CONFIGS[provider]
  const codeVerifier = generateCodeVerifier()
  const codeChallenge = await generateCodeChallenge(codeVerifier)
  const state = crypto.randomUUID()

  sessionStorage.setItem(`oauth_verifier_${provider}`, codeVerifier)
  sessionStorage.setItem(`oauth_state_${provider}`, state)

  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: config.scopes,
    state: `${provider}:${state}`,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    access_type: provider === 'gmail' ? 'offline' : '',
    prompt: provider === 'gmail' ? 'consent' : '',
  })

  if (provider !== 'gmail') {
    params.delete('access_type')
    params.delete('prompt')
  }

  window.location.href = `${config.authUrl}?${params}`
}

export async function exchangeCodeForTokens(
  provider: EmailProvider,
  code: string,
  state: string
): Promise<OAuthTokens> {
  const config = PROVIDER_CONFIGS[provider]
  const expectedState = sessionStorage.getItem(`oauth_state_${provider}`)
  const codeVerifier = sessionStorage.getItem(`oauth_verifier_${provider}`)

  const [, stateValue] = state.split(':')
  if (stateValue !== expectedState) {
    throw new Error('OAuth state mismatch — possible CSRF attack')
  }

  if (!codeVerifier) {
    throw new Error('Missing code verifier')
  }

  const body = new URLSearchParams({
    client_id: config.clientId,
    code,
    code_verifier: codeVerifier,
    grant_type: 'authorization_code',
    redirect_uri: REDIRECT_URI,
  })

  const response = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })

  if (!response.ok) {
    const err = await response.text()
    throw new Error(`Token exchange failed: ${err}`)
  }

  const data = await response.json() as {
    access_token: string
    refresh_token?: string
    expires_in: number
    scope: string
  }

  sessionStorage.removeItem(`oauth_verifier_${provider}`)
  sessionStorage.removeItem(`oauth_state_${provider}`)

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
    scope: data.scope,
  }
}

export async function refreshAccessToken(
  provider: EmailProvider,
  refreshToken: string
): Promise<OAuthTokens> {
  const config = PROVIDER_CONFIGS[provider]

  const body = new URLSearchParams({
    client_id: config.clientId,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  })

  const response = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })

  if (!response.ok) {
    throw new Error('Token refresh failed')
  }

  const data = await response.json() as {
    access_token: string
    refresh_token?: string
    expires_in: number
    scope: string
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000,
    scope: data.scope,
  }
}
