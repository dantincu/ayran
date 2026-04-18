import axios from 'axios'
import { refreshAccessToken } from './oauth'
import { useAuthStore } from '../stores/authStore'
import type { EmailProvider } from '../types/email'

const API_BASES: Record<EmailProvider, string> = {
  gmail: 'https://gmail.googleapis.com/gmail/v1',
  outlook: 'https://graph.microsoft.com/v1.0',
  yahoo: 'https://mail.yahoo.com/ws/v3',
}

export function createApiClient(provider: EmailProvider, accountId: string) {
  const client = axios.create({ baseURL: API_BASES[provider] })

  client.interceptors.request.use(async (config) => {
    const store = useAuthStore.getState()
    const account = store.accounts.find((a) => a.id === accountId)
    if (!account) throw new Error('Account not found')

    let { accessToken, expiresAt, refreshToken } = account.tokens

    if (Date.now() > expiresAt - 60_000 && refreshToken) {
      const newTokens = await refreshAccessToken(provider, refreshToken)
      store.updateTokens(accountId, newTokens)
      accessToken = newTokens.accessToken
    }

    config.headers.Authorization = `Bearer ${accessToken}`
    return config
  })

  return client
}
