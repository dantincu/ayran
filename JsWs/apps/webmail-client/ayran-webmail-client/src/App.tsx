import { useEffect } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { MailPage } from './pages/MailPage'
import { LoginPage } from './pages/LoginPage'
import { useAuthStore } from './stores/authStore'
import { useEmailStore } from './stores/emailStore'
import { useThemeStore } from './stores/themeStore'

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30_000 } },
})

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { accounts, hydrated } = useAuthStore()
  if (!hydrated) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 size={32} className="animate-spin text-primary-500" />
      </div>
    )
  }
  if (accounts.length === 0) return <Navigate to="/login" replace />
  return <>{children}</>
}

export default function App() {
  const initTrustedSenders = useEmailStore((s) => s.initTrustedSenders)
  const hydrateFromServer = useAuthStore((s) => s.hydrateFromServer)
  const { dark } = useThemeStore()

  useEffect(() => {
    hydrateFromServer().catch(console.error)
    initTrustedSenders().catch(console.error)
  }, [hydrateFromServer, initTrustedSenders])

  return (
    <div className={`${dark ? 'dark ' : ''}h-full`}>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route
              path="/mail"
              element={<RequireAuth><MailPage /></RequireAuth>}
            />
            <Route
              path="/mail/:folderId"
              element={<RequireAuth><MailPage /></RequireAuth>}
            />
            <Route
              path="/mail/:folderId/:emailId"
              element={<RequireAuth><MailPage /></RequireAuth>}
            />
            <Route path="/" element={<Navigate to="/mail" replace />} />
            <Route path="*" element={<Navigate to="/mail" replace />} />
          </Routes>
        </BrowserRouter>
      </QueryClientProvider>
    </div>
  )
}
