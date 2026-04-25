import { Router } from 'express'
import { YahooService } from '../services/yahoo'
import type { SessionAccount } from '../types'

export const yahooRouter = Router()

yahooRouter.post('/connect', async (req, res) => {
  const { email, appPassword } = req.body as { email?: string; appPassword?: string }

  if (!email || !appPassword) {
    res.status(400).json({ error: 'Email and app password are required' })
    return
  }

  const svc = new YahooService(email, appPassword, `yahoo-${email}`)
  try {
    await svc.verifyConnection()
  } catch {
    res.status(401).json({ error: 'Connection failed. Check your Yahoo email address and app password.' })
    return
  }

  const account: SessionAccount = {
    id: `yahoo-${email}`,
    provider: 'yahoo',
    email,
    displayName: email,
    credentials: { appPassword },
  }

  if (!req.session.accounts) req.session.accounts = {}
  req.session.accounts[account.id] = account

  req.session.save((err) => {
    if (err) { res.status(500).json({ error: 'Session save failed' }); return }
    const { id, provider, email: em, displayName } = account
    res.json({ id, provider, email: em, displayName })
  })
})
