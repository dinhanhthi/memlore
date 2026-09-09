import { create } from 'zustand'

/**
 * In-flight "set location from saved alias" flags, keyed by entry id.
 *
 * The entry-card context menu closes immediately on pick; the card and
 * open editor read this store so they can show a loading state in the
 * location slot until `updateEntryLocation` returns.
 */
interface EntryLocationPendingState {
  pendingIds: ReadonlySet<string>
  begin: (entryId: string) => void
  end: (entryId: string) => void
  isPending: (entryId: string) => boolean
}

export const useEntryLocationPendingStore = create<EntryLocationPendingState>((set, get) => ({
  pendingIds: new Set(),

  begin: (entryId) =>
    set((s) => {
      if (s.pendingIds.has(entryId)) return s
      const pendingIds = new Set(s.pendingIds)
      pendingIds.add(entryId)
      return { pendingIds }
    }),

  end: (entryId) =>
    set((s) => {
      if (!s.pendingIds.has(entryId)) return s
      const pendingIds = new Set(s.pendingIds)
      pendingIds.delete(entryId)
      return { pendingIds }
    }),

  isPending: (entryId) => get().pendingIds.has(entryId),
}))
