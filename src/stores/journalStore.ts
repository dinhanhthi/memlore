import { create } from 'zustand'
import type { Journal } from '../types/journal'

interface JournalState {
  journals: Journal[]
  activeJournalId: string | null

  setJournals: (journals: Journal[]) => void
  setActiveJournalId: (id: string | null) => void
}

export const useJournalStore = create<JournalState>()((set) => ({
  journals: [],
  activeJournalId: null,

  setJournals: (journals) => set({ journals }),

  setActiveJournalId: (id) => set({ activeJournalId: id }),
}))
