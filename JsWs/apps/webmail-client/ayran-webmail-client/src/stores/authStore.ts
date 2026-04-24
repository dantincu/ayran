import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Account } from '../types/auth'

interface AuthState {
  accounts: Account[]
  activeAccountId: string | null
  hydrated: boolean
  hydrateFromServer: () => Promise<void>
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

      hydrateFromServer: async () => {
        try {
          const res = await fetch('/api/auth/accounts')
          if (!res.ok) throw new Error('Failed to fetch accounts')
          const accounts: Account[] = await res.json()
          set((state) => {
            const activeAccountId =
              accounts.some((a) => a.id === state.activeAccountId)
                ? state.activeAccountId
                : (accounts[0]?.id ?? null)
            return { accounts, activeAccountId, hydrated: true }
          })
        } catch {
          set({ hydrated: true })
        }
      },

      removeAccount: async (accountId) => {
        await fetch(`/api/auth/accounts/${accountId}`, { method: 'DELETE' })
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
