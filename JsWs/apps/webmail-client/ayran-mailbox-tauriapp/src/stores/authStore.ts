import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Account } from '../types/auth'
import {
  listAccounts, removeAccount as removeAccountCmd, signInWithOAuth, cancelOAuthSignIn,
} from '../services/emailService'

type OAuthProvider = 'gmail' | 'outlook'

interface AuthState {
  accounts: Account[]
  activeAccountId: string | null
  hydrated: boolean
  /** The provider whose browser sign-in is in progress, if any. */
  signingIn: OAuthProvider | null
  signInError: string | null
  hydrate: () => Promise<void>
  signIn: (provider: OAuthProvider) => Promise<Account | null>
  cancelSignIn: () => Promise<void>
  clearSignInError: () => void
  removeAccount: (accountId: string) => Promise<void>
  setActiveAccount: (accountId: string) => void
  getActiveAccount: () => Account | undefined
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      accounts: [],
      activeAccountId: null,
      hydrated: false,
      signingIn: null,
      signInError: null,

      hydrate: async () => {
        try {
          const accounts = await listAccounts()
          set((state) => {
            const activeAccountId =
              accounts.some((a) => a.id === state.activeAccountId)
                ? state.activeAccountId
                : (accounts[0]?.id ?? null)
            return { accounts, activeAccountId, hydrated: true }
          })
        } catch (e) {
          console.error('Failed to load accounts', e)
          set({ hydrated: true })
        }
      },

      signIn: async (provider) => {
        set({ signingIn: provider, signInError: null })
        try {
          const account = await signInWithOAuth(provider)
          await get().hydrate()
          set({ activeAccountId: account.id })
          return account
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e)
          // A cancelled sign-in isn't an error worth showing.
          if (!/cancelled/i.test(message)) set({ signInError: message })
          return null
        } finally {
          set({ signingIn: null })
        }
      },

      cancelSignIn: () => cancelOAuthSignIn(),

      clearSignInError: () => set({ signInError: null }),

      removeAccount: async (accountId) => {
        await removeAccountCmd(accountId)
        set((state) => {
          const accounts = state.accounts.filter((a) => a.id !== accountId)
          const activeAccountId =
            state.activeAccountId === accountId ? (accounts[0]?.id ?? null) : state.activeAccountId
          return { accounts, activeAccountId }
        })
      },

      setActiveAccount: (accountId) => set({ activeAccountId: accountId }),

      getActiveAccount: () => {
        const { accounts, activeAccountId } = get()
        return accounts.find((a) => a.id === activeAccountId)
      },
    }),
    {
      name: 'ayran-auth-active',
      partialize: (state) => ({ activeAccountId: state.activeAccountId }),
    }
  )
)
