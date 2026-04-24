import type { EmailProvider } from '../types/email'

export function initiateOAuth(provider: EmailProvider): void {
  window.location.href = `/api/auth/initiate?provider=${provider}`
}
