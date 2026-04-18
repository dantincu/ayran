import { Mail } from 'lucide-react'
import { initiateOAuth } from '../services/oauth'
import type { EmailProvider } from '../types/email'

const PROVIDERS: { id: EmailProvider; name: string; color: string; bg: string; description: string }[] = [
  {
    id: 'gmail',
    name: 'Gmail',
    color: 'text-red-600',
    bg: 'hover:bg-red-50 border-red-200',
    description: 'Connect your Google / Gmail account',
  },
  {
    id: 'outlook',
    name: 'Outlook',
    color: 'text-blue-600',
    bg: 'hover:bg-blue-50 border-blue-200',
    description: 'Connect your Microsoft / Outlook account',
  },
  {
    id: 'yahoo',
    name: 'Yahoo Mail',
    color: 'text-purple-600',
    bg: 'hover:bg-purple-50 border-purple-200',
    description: 'Connect your Yahoo Mail account',
  },
]

export function LoginPage() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-primary-50 to-white flex items-center justify-center p-6">
      <div className="w-full max-w-md">
        <div className="text-center mb-10">
          <div className="inline-flex items-center justify-center w-14 h-14 bg-primary-600 text-white rounded-2xl mb-4 shadow-lg">
            <Mail size={28} />
          </div>
          <h1 className="text-3xl font-bold text-gray-900">Ayran WebMail</h1>
          <p className="text-gray-500 mt-2">Connect your email accounts to get started</p>
        </div>

        <div className="bg-white rounded-2xl shadow-md border border-gray-100 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-50">
            <h2 className="text-sm font-semibold text-gray-700">Choose a provider</h2>
          </div>
          <div className="p-4 space-y-3">
            {PROVIDERS.map((provider) => (
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
                  <p className="text-xs text-gray-400">{provider.description}</p>
                </div>
              </button>
            ))}
          </div>
          <div className="px-6 pb-5 text-center">
            <p className="text-xs text-gray-400">
              Ayran WebMail uses OAuth2 — your password is never shared with this app.
            </p>
          </div>
        </div>

        <p className="text-center mt-6 text-xs text-gray-400">
          You can add multiple accounts after signing in.
        </p>
      </div>
    </div>
  )
}
