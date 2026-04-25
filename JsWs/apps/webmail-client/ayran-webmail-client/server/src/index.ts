import 'dotenv/config'
import https from 'https'
import fs from 'fs'
import path from 'path'
import express from 'express'
import session from 'express-session'
import cors from 'cors'
import selfsigned from 'selfsigned'
import { authRouter } from './routes/auth'
import { mailRouter } from './routes/mail'
import { yahooRouter } from './routes/yahoo'

const app = express()
const port = parseInt(process.env.PORT ?? '3001')
const frontendUrl = process.env.FRONTEND_URL ?? 'http://localhost:5173'

app.use(cors({ origin: frontendUrl, credentials: true }))
app.use(express.json())

app.use(
  session({
    secret: process.env.SESSION_SECRET ?? 'dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: true,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  })
)

app.use('/api/auth', authRouter)
app.use('/api/oauth', authRouter)
app.use('/api/mail', mailRouter)
app.use('/api/yahoo', yahooRouter)

function getDevCert(): { key: string; cert: string } {
  const certDir = path.join(__dirname, '..', '.dev-cert')
  const keyFile = path.join(certDir, 'key.pem')
  const certFile = path.join(certDir, 'cert.pem')

  if (fs.existsSync(keyFile) && fs.existsSync(certFile)) {
    return { key: fs.readFileSync(keyFile, 'utf8'), cert: fs.readFileSync(certFile, 'utf8') }
  }

  fs.mkdirSync(certDir, { recursive: true })
  const pems = selfsigned.generate([{ name: 'commonName', value: 'localhost' }], {
    days: 365,
    algorithm: 'sha256',
    keySize: 2048,
  })
  fs.writeFileSync(keyFile, pems.private)
  fs.writeFileSync(certFile, pems.cert)
  console.log('Generated self-signed certificate in .dev-cert/')
  return { key: pems.private, cert: pems.cert }
}

https.createServer(getDevCert(), app).listen(port, () => {
  console.log(`Ayran webmail server listening on https://localhost:${port}`)
})
