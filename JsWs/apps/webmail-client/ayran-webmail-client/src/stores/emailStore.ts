import { create } from 'zustand'
import type { Email, SearchParams, SortParams, ComposeData } from '../types/email'
import type { Folder } from '../types/folder'
import {
  loadTrustedSenders,
  addTrustedSenderToDb,
  removeTrustedSenderFromDb,
} from '../services/trustedSendersDb'

interface EmailState {
  selectedFolderId: string | null
  selectedEmailId: string | null
  folders: Folder[]
  emails: Email[]
  totalCount: number
  currentPage: number
  pageSize: number
  isLoading: boolean
  error: string | null
  search: SearchParams
  sort: SortParams
  groupBySender: boolean
  compose: ComposeData | null
  trustedSenders: string[]

  setSelectedFolder: (folderId: string | null) => void
  setSelectedEmail: (emailId: string | null) => void
  setFolders: (folders: Folder[]) => void
  setEmails: (emails: Email[], totalCount: number) => void
  setCurrentPage: (page: number) => void
  setLoading: (loading: boolean) => void
  setError: (error: string | null) => void
  setSearch: (search: SearchParams) => void
  setSort: (sort: SortParams) => void
  setGroupBySender: (group: boolean) => void
  openCompose: (data: ComposeData) => void
  closeCompose: () => void
  markAsRead: (emailId: string) => void
  toggleStar: (emailId: string) => void
  addTrustedSender: (email: string) => void
  removeTrustedSender: (email: string) => void
  isTrustedSender: (email: string) => boolean
  initTrustedSenders: () => Promise<void>
}

export const useEmailStore = create<EmailState>()((set, get) => ({
  selectedFolderId: null,
  selectedEmailId: null,
  folders: [],
  emails: [],
  totalCount: 0,
  currentPage: 1,
  pageSize: 50,
  isLoading: false,
  error: null,
  search: {},
  sort: { field: 'date', direction: 'desc' },
  groupBySender: false,
  compose: null,
  trustedSenders: [],

  setSelectedFolder: (folderId) =>
    set({ selectedFolderId: folderId, selectedEmailId: null, currentPage: 1 }),
  setSelectedEmail: (emailId) => set({ selectedEmailId: emailId }),
  setFolders: (folders) => set({ folders }),
  setEmails: (emails, totalCount) => set({ emails, totalCount }),
  setCurrentPage: (page) => set({ currentPage: page }),
  setLoading: (isLoading) => set({ isLoading }),
  setError: (error) => set({ error }),
  setSearch: (search) => set({ search, currentPage: 1 }),
  setSort: (sort) => set({ sort }),
  setGroupBySender: (groupBySender) => set({ groupBySender }),
  openCompose: (compose) => set({ compose }),
  closeCompose: () => set({ compose: null }),

  markAsRead: (emailId) =>
    set((state) => ({
      emails: state.emails.map((e) =>
        e.id === emailId ? { ...e, isRead: true } : e
      ),
    })),

  toggleStar: (emailId) =>
    set((state) => ({
      emails: state.emails.map((e) =>
        e.id === emailId ? { ...e, isStarred: !e.isStarred } : e
      ),
    })),

  addTrustedSender: (email) => {
    const { trustedSenders } = get()
    if (trustedSenders.includes(email)) return
    set({ trustedSenders: [...trustedSenders, email] })
    addTrustedSenderToDb(email).catch(console.error)
  },

  removeTrustedSender: (email) => {
    set((state) => ({
      trustedSenders: state.trustedSenders.filter((s) => s !== email),
    }))
    removeTrustedSenderFromDb(email).catch(console.error)
  },

  isTrustedSender: (email) => get().trustedSenders.includes(email),

  initTrustedSenders: async () => {
    const senders = await loadTrustedSenders()
    set({ trustedSenders: senders })
  },
}))
