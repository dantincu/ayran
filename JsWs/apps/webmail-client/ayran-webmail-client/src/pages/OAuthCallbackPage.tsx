import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Loader2, AlertCircle } from 'lucide-react'
import { exchangeCodeForTokens } from '../services/oauth'
import { useAuthStore } from '../stores/authStore'
import type { EmailProvider } from '../types/email'
import type { Account } from '../types/auth'

// Fetch profile directly with an access token — avoids the store-based API client
// which requires the account to already be registered in the store.
async function fetchGmailProfile(
  accessToken: string
): Promise<{ email: string; name: string; picture?: string }> {
  const res = await fetch('https://www.googleapis.com/oauth2/v1/userinfo?alt=json', {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) throw new Error(`Profile fetch failed: ${res.status}`)
  const data = await res.json() as { email: string; name: string; picture?: string }
  return data
}

async function fetchOutlookProfile(
  accessToken: string
): Promise<{ email: string; name: string }> {
  const res = await fetch(
    'https://graph.microsoft.com/v1.0/me?$select=displayName,mail,userPrincipalName',
    { headers: { Authorization: `Bearer ${accessToken}` } }
  )
  if (!res.ok) throw new Error(`Profile fetch failed: ${res.status}`)
  const data = await res.json() as { displayName: string; mail?: string; userPrincipalName: string }
  return { email: data.mail ?? data.userPrincipalName, name: data.displayName }
}

export function OAuthCallbackPage() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const { addAccount } = useAuthStore()
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const code = searchParams.get('code')
    const state = searchParams.get('state')
    const errorParam = searchParams.get('error')

    if (errorParam) {
      setError(`OAuth error: ${searchParams.get('error_description') ?? errorParam}`)
      return
    }

    if (!code || !state) {
      setError('Missing OAuth parameters')
      return
    }

    const [provider] = state.split(':')
    if (!['gmail', 'outlook', 'yahoo'].includes(provider)) {
      setError('Unknown provider in OAuth state')
      return
    }

    const providerTyped = provider as EmailProvider

    exchangeCodeForTokens(providerTyped, code, state)
      .then(async (tokens) => {
        let email = 'unknown'
        let displayName = providerTyped.charAt(0).toUpperCase() + providerTyped.slice(1)
        let avatarUrl: string | undefined

        try {
          if (providerTyped === 'gmail') {
            const profile = await fetchGmailProfile(tokens.accessToken)
            email = profile.email
            displayName = profile.name
            avatarUrl = profile.picture
          } else if (providerTyped === 'outlook') {
            const profile = await fetchOutlookProfile(tokens.accessToken)
            email = profile.email
            displayName = profile.name
          }
        } catch (e) {
          console.warn('Could not fetch profile, using fallback', e)
        }

        const account: Account = {
          id: `${providerTyped}-${email}`,
          provider: providerTyped,
          email,
          displayName,
          avatarUrl,
          tokens,
        }
        addAccount(account)
        navigate('/', { replace: true })
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : 'Authentication failed')
      })
  }, [searchParams, navigate, addAccount])

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-white rounded-2xl shadow-md border border-gray-100 p-8 text-center">
          <div className="inline-flex items-center justify-center w-12 h-12 bg-red-100 text-red-600 rounded-full mb-4">
            <AlertCircle size={24} />
          </div>
          <h2 className="text-xl font-semibold text-gray-900 mb-2">Authentication Failed</h2>
          <p className="text-sm text-gray-500 mb-6">{error}</p>
          <button
            onClick={() => navigate('/login')}
            className="px-6 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 transition-colors"
          >
            Back to Login
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="text-center">
        <Loader2 size={40} className="animate-spin text-primary-500 mx-auto mb-4" />
        <p className="text-gray-500 text-sm">Completing sign in…</p>
      </div>
    </div>
  )
}
