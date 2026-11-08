import { Loader2, X } from 'lucide-react'
import { useAuthStore } from '../../stores/authStore'

const NAMES = { gmail: 'Google', outlook: 'Microsoft' } as const

/** Shown while a browser sign-in is in progress, and when one failed. */
export function SignInStatus() {
  const { signingIn, signInError, cancelSignIn, clearSignInError } = useAuthStore()

  if (signingIn) {
    return (
      <>
        <div className="fixed inset-0 z-40 bg-black/40" />
        <div className="fixed z-50 top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[min(24rem,calc(100vw-2rem))] bg-white dark:bg-gray-800 rounded-xl shadow-2xl border border-gray-200 dark:border-gray-700 p-5 space-y-4">
          <div className="flex items-center gap-3">
            <Loader2 size={20} className="animate-spin text-primary-600 flex-shrink-0" />
            <p className="text-sm text-gray-700 dark:text-gray-200">
              Finish signing in to {NAMES[signingIn]} in your browser. This window will continue on its own.
            </p>
          </div>
          <div className="flex justify-end">
            <button
              onClick={() => cancelSignIn().catch(console.error)}
              className="px-3 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
            >
              Cancel
            </button>
          </div>
        </div>
      </>
    )
  }

  if (signInError) {
    return (
      <div className="fixed z-50 bottom-4 left-1/2 -translate-x-1/2 w-[min(28rem,calc(100vw-2rem))] flex items-start gap-3 bg-red-50 dark:bg-red-900/40 border border-red-200 dark:border-red-800 rounded-lg px-4 py-3 shadow-lg">
        <p className="flex-1 text-sm text-red-700 dark:text-red-200 break-words">Sign-in failed: {signInError}</p>
        <button onClick={clearSignInError} className="p-0.5 text-red-400 hover:text-red-600" title="Dismiss">
          <X size={14} />
        </button>
      </div>
    )
  }

  return null
}
