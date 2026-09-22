import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { loadAndApplyCodeSnippets } from './lib/codeSnippets'
import { initAppearance } from './lib/appearance'

// Apply the backend's code snippets (e.g. keeping clear of Android's system bars)
// before the first render, so the layout doesn't jump.
Promise.all([loadAndApplyCodeSnippets(), initAppearance()]).finally(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
})
