import { Router } from 'express'
import {
  generateCodeVerifier, generateCodeChallenge, generateState,
  buildAuthUrl, exchangeCode, fetchProfile,
} from '../services/oauth'
import type { SessionAccount } from '../types'

export const authRouter = Router()

authRouter.get('/initiate', (req, res) => {
  const provider = req.query.provider as string
  if (provider !== 'gmail' && provider !== 'outlook') {
    res.status(400).json({ error: 'Unknown provider' })
    return
  }

  const verifier = generateCodeVerifier()
  const challenge = generateCodeChallenge(verifier)
  const state = generateState()

  const authUrl = buildAuthUrl(provider, state, challenge)
  req.session.oauthPending = { provider, verifier, state }
  req.session.save((err) => {
    if (err) { res.status(500).json({ error: 'Session error' }); return }
    res.redirect(authUrl)
  })
})

authRouter.get('/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query as Record<string, string>
  const frontendUrl = process.env.FRONTEND_URL ?? 'http://localhost:5173'

  if (error) {
    res.redirect(`${frontendUrl}/login?error=${encodeURIComponent(error_description ?? error)}`)
    return
  }

  if (!code || !state) {
    res.redirect(`${frontendUrl}/login?error=missing_params`)
    return
  }

  const pending = req.session.oauthPending
  if (!pending) {
    res.redirect(`${frontendUrl}/login?error=no_pending_oauth`)
    return
  }

  const [provider, stateValue] = state.split(':')
  if (stateValue !== pending.state || provider !== pending.provider) {
    res.redirect(`${frontendUrl}/login?error=state_mismatch`)
    return
  }

  try {
    const tokens = await exchangeCode(provider, code, pending.verifier)
    const profile = await fetchProfile(provider, tokens.accessToken)

    const account: SessionAccount = {
      id: `${provider}-${profile.email}`,
      provider: provider as 'gmail' | 'outlook',
      email: profile.email,
      displayName: profile.displayName,
      avatarUrl: profile.avatarUrl,
      tokens,
    }

    if (!req.session.accounts) req.session.accounts = {}
    req.session.accounts[account.id] = account
    delete req.session.oauthPending

    req.session.save((err) => {
      if (err) { res.redirect(`${frontendUrl}/login?error=session_save_failed`); return }
      res.redirect(frontendUrl)
    })
  } catch (e) {
    console.error('OAuth callback error', e)
    res.redirect(`${frontendUrl}/login?error=auth_failed`)
  }
})

authRouter.get('/accounts', (req, res) => {
  const accounts = req.session.accounts ?? {}
  const clientAccounts = Object.values(accounts).map(({ id, provider, email, displayName, avatarUrl }) => ({
    id, provider, email, displayName, avatarUrl,
  }))
  res.json(clientAccounts)
})

authRouter.delete('/accounts/:accountId', (req, res) => {
  const { accountId } = req.params
  if (req.session.accounts) delete req.session.accounts[accountId]
  req.session.save((err) => {
    if (err) { res.status(500).json({ error: 'Session error' }); return }
    res.json({ ok: true })
  })
})
