import { Router, type Request, type Response } from 'express'
import { GmailService } from '../services/gmail'
import { OutlookService } from '../services/outlook'
import { refreshTokens } from '../services/oauth'
import type { ComposeData } from '../types'

export const mailRouter = Router()

const str = (v: unknown): string => (Array.isArray(v) ? (v[0] as string) : String(v ?? ''))

async function getService(req: Request, accountId: string) {
  const accounts = req.session.accounts ?? {}
  const account = accounts[accountId]
  if (!account) throw Object.assign(new Error('Account not found'), { status: 401 })

  if (Date.now() > account.tokens.expiresAt - 60_000 && account.tokens.refreshToken) {
    account.tokens = await refreshTokens(account.provider, account.tokens.refreshToken)
    req.session.accounts![accountId] = account
    await new Promise<void>((resolve, reject) =>
      req.session.save((err) => (err ? reject(err) : resolve()))
    )
  }

  const svc =
    account.provider === 'gmail'
      ? new GmailService(account.tokens.accessToken, accountId)
      : new OutlookService(account.tokens.accessToken, accountId)

  return { svc, account }
}

function handle(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response) => {
    fn(req, res).catch((e: unknown) => {
      const status = (e as { status?: number }).status ?? 500
      const message = e instanceof Error ? e.message : 'Internal server error'
      res.status(status).json({ error: message })
    })
  }
}

// ── Folders ───────────────────────────────────────────────────────────────────

mailRouter.get('/:accountId/folders', handle(async (req, res) => {
  const { svc } = await getService(req, str(req.params.accountId))
  res.json(await svc.getFolders())
}))

// ── Send email ────────────────────────────────────────────────────────────────

mailRouter.post('/:accountId/emails/send', handle(async (req, res) => {
  const { svc, account } = await getService(req, str(req.params.accountId))
  await svc.sendEmail(req.body as ComposeData, account.email)
  res.json({ ok: true })
}))

// ── Batch actions (must be before /:emailId routes) ──────────────────────────

mailRouter.post('/:accountId/emails/batch/trash', handle(async (req, res) => {
  const { svc } = await getService(req, str(req.params.accountId))
  const { emailIds } = req.body as { emailIds: string[] }
  if (!emailIds?.length) { res.json({ ok: true }); return }
  if (svc instanceof GmailService) {
    await svc.batchModifyLabels(emailIds, ['TRASH'], ['INBOX'])
  } else {
    await Promise.all(emailIds.map((id) => svc.moveToTrash(id)))
  }
  res.json({ ok: true })
}))

mailRouter.post('/:accountId/emails/batch/archive', handle(async (req, res) => {
  const { svc } = await getService(req, str(req.params.accountId))
  const { emailIds } = req.body as { emailIds: string[] }
  if (svc instanceof GmailService) await svc.batchModifyLabels(emailIds, [], ['INBOX'])
  res.json({ ok: true })
}))

mailRouter.post('/:accountId/emails/batch/labels', handle(async (req, res) => {
  const { svc } = await getService(req, str(req.params.accountId))
  const { emailIds, addIds, removeIds } = req.body as { emailIds: string[]; addIds: string[]; removeIds: string[] }
  if (svc instanceof GmailService) await svc.batchModifyLabels(emailIds, addIds, removeIds)
  res.json({ ok: true })
}))

mailRouter.post('/:accountId/emails/batch/move', handle(async (req, res) => {
  const { svc } = await getService(req, str(req.params.accountId))
  const { emailIds, folderId } = req.body as { emailIds: string[]; folderId: string }
  if (svc instanceof OutlookService) {
    await Promise.all(emailIds.map((id) => (svc as OutlookService).moveToFolder(id, folderId)))
  }
  res.json({ ok: true })
}))

// ── Email list ────────────────────────────────────────────────────────────────

mailRouter.get('/:accountId/emails', handle(async (req, res) => {
  const { svc } = await getService(req, str(req.params.accountId))
  const q = req.query

  const search = {
    subject: str(q.subject) || undefined,
    subjectIsRegex: q.subjectIsRegex === 'true',
    body: str(q.body) || undefined,
    bodyIsRegex: q.bodyIsRegex === 'true',
    from: str(q.from) || undefined,
    to: str(q.to) || undefined,
    after: q.after ? new Date(str(q.after)) : undefined,
    before: q.before ? new Date(str(q.before)) : undefined,
  }
  const sort = {
    field: (str(q.sortField) || 'date') as 'date' | 'from' | 'to',
    direction: (str(q.sortDir) || 'desc') as 'asc' | 'desc',
  }

  const result = await svc.getEmails(
    str(q.folderId), parseInt(str(q.page) || '1'), parseInt(str(q.pageSize) || '50'), search, sort
  )
  res.json(result)
}))

// ── Per-email actions ─────────────────────────────────────────────────────────

mailRouter.get('/:accountId/emails/:emailId/full', handle(async (req, res) => {
  const { svc } = await getService(req, str(req.params.accountId))
  if (!(svc instanceof GmailService)) { res.json({}); return }
  res.json(await svc.getEmailFull(str(req.params.emailId)))
}))

mailRouter.patch('/:accountId/emails/:emailId/read', handle(async (req, res) => {
  const { svc } = await getService(req, str(req.params.accountId))
  await svc.markAsRead(str(req.params.emailId))
  res.json({ ok: true })
}))

mailRouter.post('/:accountId/emails/:emailId/trash', handle(async (req, res) => {
  const { svc } = await getService(req, str(req.params.accountId))
  await svc.moveToTrash(str(req.params.emailId))
  res.json({ ok: true })
}))

mailRouter.post('/:accountId/emails/:emailId/archive', handle(async (req, res) => {
  const { svc } = await getService(req, str(req.params.accountId))
  if (svc instanceof GmailService) await svc.modifyLabels(str(req.params.emailId), [], ['INBOX'])
  res.json({ ok: true })
}))

mailRouter.post('/:accountId/emails/:emailId/labels', handle(async (req, res) => {
  const { svc } = await getService(req, str(req.params.accountId))
  const { addIds, removeIds } = req.body as { addIds: string[]; removeIds: string[] }
  if (svc instanceof GmailService) await svc.modifyLabels(str(req.params.emailId), addIds, removeIds)
  res.json({ ok: true })
}))

mailRouter.post('/:accountId/emails/:emailId/move', handle(async (req, res) => {
  const { svc } = await getService(req, str(req.params.accountId))
  const { folderId } = req.body as { folderId: string }
  if (svc instanceof OutlookService) await svc.moveToFolder(str(req.params.emailId), folderId)
  res.json({ ok: true })
}))
