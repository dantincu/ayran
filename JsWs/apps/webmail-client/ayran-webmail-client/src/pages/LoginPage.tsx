import { useState } from 'react'
import { Mail } from 'lucide-react'
import { initiateOAuth } from '../services/oauth'
import { YahooConnectModal } from '../components/auth/YahooConnectModal'

const OAUTH_PROVIDERS = [
  {
    id: 'gmail' as const,
    name: 'Gmail',
    color: 'text-red-600',
    bg: 'hover:bg-red-50 dark:hover:bg-red-900/20 border-red-200 dark:border-red-800',
    description: 'Connect your Google / Gmail account',
  },
  {
    id: 'outlook' as const,
    name: 'Outlook',
    color: 'text-blue-600',
    bg: 'hover:bg-blue-50 dark:hover:bg-blue-900/20 border-blue-200 dark:border-blue-800',
    description: 'Connect your Microsoft / Outlook account',
  },
]

export function LoginPage() {
  const [yahooModalOpen, setYahooModalOpen] = useState(false)

  return (
    <div className="min-h-screen bg-gradient-to-br from-primary-50 to-white dark:from-gray-900 dark:to-gray-800 flex items-center justify-center p-6">
      <div className="w-full max-w-md">
        <div className="text-center mb-10">
          <div className="inline-flex items-center justify-center w-14 h-14 bg-primary-600 text-white rounded-2xl mb-4 shadow-lg">
            <Mail size={28} />
          </div>
          <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100">Ayran WebMail</h1>
          <p className="text-gray-500 dark:text-gray-400 mt-2">Connect your email accounts to get started</p>
        </div>

        <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-md border border-gray-100 dark:border-gray-700 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-50 dark:border-gray-700">
            <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Choose a provider</h2>
          </div>
          <div className="p-4 space-y-3">
            {OAUTH_PROVIDERS.map((provider) => (
              <button
                key={provider.id}
                onClick={() => initiateOAuth(provider.id)}
                className={`w-full flex items-center gap-4 px-4 py-4 rounded-xl border transition-colors ${provider.bg}`}
              >
                <div className={`text-2xl font-bold ${provider.color} w-8 text-center`}>
                  {provider.name[0]}
                </div>
                <div className="text-left">
                  <p className={`font-semibold ${provider.color}`}>{provider.name}</p>
                  <p className="text-xs text-gray-400 dark:text-gray-500">{provider.description}</p>
                </div>
              </button>
            ))}

            {/* Yahoo — credential-based, not OAuth */}
            <button
              onClick={() => setYahooModalOpen(true)}
              className="w-full flex items-center gap-4 px-4 py-4 rounded-xl border border-purple-200 dark:border-purple-800 hover:bg-purple-50 dark:hover:bg-purple-900/20 transition-colors"
            >
              <div className="text-2xl font-bold text-purple-600 w-8 text-center">Y</div>
              <div className="text-left">
                <p className="font-semibold text-purple-600">Yahoo Mail</p>
                <p className="text-xs text-gray-400 dark:text-gray-500">Connect your Yahoo Mail account via app password</p>
              </div>
            </button>
          </div>
          <div className="px-6 pb-5 text-center">
            <p className="text-xs text-gray-400 dark:text-gray-500">
              Gmail and Outlook use OAuth2. Yahoo Mail uses an app password generated in your Yahoo security settings.
            </p>
          </div>
        </div>

        <p className="text-center mt-6 text-xs text-gray-400 dark:text-gray-500">
          You can add multiple accounts after signing in.
        </p>
      </div>

      {yahooModalOpen && <YahooConnectModal onClose={() => setYahooModalOpen(false)} />}
    </div>
  )
}
