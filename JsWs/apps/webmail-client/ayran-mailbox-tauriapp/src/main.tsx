import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { openExternal } from './services/emailService'

// External links (target="_blank") open in the system browser rather than in the app's webview.
document.addEventListener('click', (e) => {
  const link = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null
  if (!link || !/^(https?|mailto):/i.test(link.href)) return
  if (link.target === '_blank' || new URL(link.href).origin !== window.location.origin) {
    e.preventDefault()
    openExternal(link.href).catch(console.error)
  }
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
