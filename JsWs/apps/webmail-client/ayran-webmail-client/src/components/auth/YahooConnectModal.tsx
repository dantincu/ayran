import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { X, Loader2, ExternalLink } from 'lucide-react'
import { useAuthStore } from '../../stores/authStore'

interface Props {
  onClose: () => void
}

export function YahooConnectModal({ onClose }: Props) {
  const { hydrateFromServer } = useAuthStore()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [appPassword, setAppPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      const res = await fetch('/api/yahoo/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, appPassword }),
      })
      const data = await res.json() as { error?: string }
      if (!res.ok) {
        setError(data.error ?? 'Connection failed')
        return
      }
      await hydrateFromServer()
      onClose()
      navigate('/mail')
    } catch {
      setError('Network error — make sure the server is running')
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/40" onClick={onClose} />
      <div className="fixed z-50 top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-96 bg-white dark:bg-gray-800 rounded-xl shadow-2xl border border-gray-200 dark:border-gray-700">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 bg-purple-600 rounded-t-xl">
          <div className="flex items-center gap-2">
            <span className="w-5 h-5 rounded-full bg-white text-purple-600 text-[10px] font-bold flex items-center justify-center">Y</span>
            <h2 className="text-sm font-semibold text-white">Connect Yahoo Mail</h2>
          </div>
          <button onClick={onClose} className="p-1 rounded text-purple-200 hover:text-white hover:bg-purple-700 transition-colors">
            <X size={14} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          {/* Instructions */}
          <div className="text-xs text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-700/50 rounded-lg p-3 space-y-1.5">
            <p className="font-medium text-gray-700 dark:text-gray-300">You need a Yahoo App Password:</p>
            <ol className="list-decimal list-inside space-y-1">
              <li>Go to your Yahoo Account Security settings</li>
              <li>Under <span className="font-medium">App passwords</span>, click <span className="font-medium">Generate app password</span></li>
              <li>Select <span className="font-medium">Other app</span>, name it (e.g. "Ayran Mail"), and copy the password</li>
            </ol>
            <a
              href="https://login.yahoo.com/account/security"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-purple-600 dark:text-purple-400 hover:underline mt-1"
            >
              Open Yahoo Security settings <ExternalLink size={11} />
            </a>
          </div>

          <div className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
                Yahoo email address
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@yahoo.com"
                required
                autoFocus
                className="w-full px-3 py-2 text-sm bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-md focus:outline-none focus:ring-2 focus:ring-purple-500 text-gray-900 dark:text-gray-100 placeholder-gray-400"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
                App password
              </label>
              <input
                type="password"
                value={appPassword}
                onChange={(e) => setAppPassword(e.target.value)}
                placeholder="16-character app password"
                required
                className="w-full px-3 py-2 text-sm bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-md focus:outline-none focus:ring-2 focus:ring-purple-500 text-gray-900 dark:text-gray-100 placeholder-gray-400"
              />
            </div>
          </div>

          {error && (
            <p className="text-xs text-red-500 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded-md px-3 py-2">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={loading || !email || !appPassword}
            className="w-full py-2 bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white text-sm font-medium rounded-md transition-colors flex items-center justify-center gap-2"
          >
            {loading && <Loader2 size={14} className="animate-spin" />}
            {loading ? 'Connecting…' : 'Connect'}
          </button>
        </form>
      </div>
    </>
  )
}
