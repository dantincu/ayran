import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { getDb } from './db/schema'
import App from './App'

// Initialize IndexedDB before rendering
getDb().then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>
  )
}).catch(err => {
  console.error('Failed to initialize database:', err)
  // Render anyway, features requiring IDB will degrade gracefully
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>
  )
})
