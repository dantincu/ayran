import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Account } from '../types/auth'

interface AuthState {
  accounts: Account[]
  activeAccountId: string | null
  addAccount: (account: Account) => void
  removeAccount: (accountId: string) => void
  setActiveAccount: (accountId: string) => void
  updateTokens: (accountId: string, tokens: Account['tokens']) => void
  getActiveAccount: () => Account | undefined
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      accounts: [],
      activeAccountId: null,

      addAccount: (account) =>
        set((state) => {
          const exists = state.accounts.find((a) => a.id === account.id)
          const accounts = exists
            ? state.accounts.map((a) => (a.id === account.id ? account : a))
            : [...state.accounts, account]
          return {
            accounts,
            activeAccountId: account.id,
          }
        }),

      removeAccount: (accountId) =>
        set((state) => {
          const accounts = state.accounts.filter((a) => a.id !== accountId)
          const activeAccountId =
            state.activeAccountId === accountId
              ? (accounts[0]?.id ?? null)
              : state.activeAccountId
          return { accounts, activeAccountId }
        }),

      setActiveAccount: (accountId) => set({ activeAccountId: accountId }),

      updateTokens: (accountId, tokens) =>
        set((state) => ({
          accounts: state.accounts.map((a) =>
            a.id === accountId ? { ...a, tokens } : a
          ),
        })),

      getActiveAccount: () => {
        const { accounts, activeAccountId } = get()
        return accounts.find((a) => a.id === activeAccountId)
      },
    }),
    { name: 'ayran-auth' }
  )
)
