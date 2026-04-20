import { useEffect } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MailPage } from './pages/MailPage'
import { LoginPage } from './pages/LoginPage'
import { OAuthCallbackPage } from './pages/OAuthCallbackPage'
import { useAuthStore } from './stores/authStore'
import { useEmailStore } from './stores/emailStore'

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30_000 } },
})

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { accounts } = useAuthStore()
  if (accounts.length === 0) return <Navigate to="/login" replace />
  return <>{children}</>
}

export default function App() {
  const initTrustedSenders = useEmailStore((s) => s.initTrustedSenders)

  useEffect(() => {
    initTrustedSenders().catch(console.error)
  }, [initTrustedSenders])

  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/oauth/callback" element={<OAuthCallbackPage />} />
          <Route
            path="/mail"
            element={
              <RequireAuth>
                <MailPage />
              </RequireAuth>
            }
          />
          <Route
            path="/mail/:folderId"
            element={
              <RequireAuth>
                <MailPage />
              </RequireAuth>
            }
          />
          <Route
            path="/mail/:folderId/:emailId"
            element={
              <RequireAuth>
                <MailPage />
              </RequireAuth>
            }
          />
          <Route path="/" element={<Navigate to="/mail" replace />} />
          <Route path="*" element={<Navigate to="/mail" replace />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  )
}
