import { create } from 'zustand'
import type { Entry } from '../types/entry'

interface EntryState {
  /**
   * The currently-displayed entry list. Scoped to the active tab's journal
   * (or all-entries / tag-filter mode). Replaced wholesale on every fetch.
   */
  entries: Entry[]

  /**
   * Lookup map of every entry the app has seen this session, keyed by id.
   *
   * Unlike `entries`, this is NEVER replaced wholesale — it accumulates so
   * consumers that resolve an entry by id (e.g. tab titles for inactive
   * tabs whose journal is no longer the active scope) keep working when
   * the visible list shifts to a different journal.
   */
  entriesById: Record<string, Entry>

  isLoading: boolean
  error: string | null

  setEntries: (entries: Entry[]) => void
  /** Merge entries into `entriesById` without touching the visible list. */
  mergeEntries: (entries: Entry[]) => void
  setLoading: (loading: boolean) => void
  setError: (error: string | null) => void
  updateEntry: (entry: Entry) => void
  removeEntry: (id: string) => void
  addEntry: (entry: Entry) => void
}

function indexBy(entries: Entry[]): Record<string, Entry> {
  const out: Record<string, Entry> = {}
  for (const e of entries) out[e.id] = e
  return out
}

export const useEntryStore = create<EntryState>()((set) => ({
  entries: [],
  entriesById: {},
  isLoading: false,
  error: null,

  setEntries: (entries) =>
    set((state) => ({
      entries,
      entriesById: { ...state.entriesById, ...indexBy(entries) },
    })),

  mergeEntries: (entries) =>
    set((state) => ({
      entriesById: { ...state.entriesById, ...indexBy(entries) },
    })),

  setLoading: (loading) => set({ isLoading: loading }),

  setError: (error) => set({ error }),

  updateEntry: (entry) =>
    set((state) => ({
      entries: state.entries.map((e) => (e.id === entry.id ? entry : e)),
      entriesById: { ...state.entriesById, [entry.id]: entry },
    })),

  removeEntry: (id) =>
    set((state) => {
      const { [id]: _removed, ...rest } = state.entriesById
      return {
        entries: state.entries.filter((e) => e.id !== id),
        entriesById: rest,
      }
    }),

  addEntry: (entry) =>
    set((state) => ({
      entries: [entry, ...state.entries],
      entriesById: { ...state.entriesById, [entry.id]: entry },
    })),
}))
