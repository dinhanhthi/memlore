import { useEffect, useState, useCallback } from 'react'
import { useJournalStore } from '../stores/journalStore'
import { useInvisibleLockStore } from '../stores/invisibleLockStore'
import {
  listJournals,
  createJournal as tauriCreateJournal,
  updateJournal as tauriUpdateJournal,
  deleteJournal as tauriDeleteJournal,
  countEntriesInJournal,
} from '../lib/tauri'
import type { Journal } from '../types/journal'

const JOURNALS_CHANGED_EVENT = 'memlore:journals-changed'

/** Broadcast that the journal list has changed (create, update, delete,
 * or sync pulled new/tombstoned journals from a peer). Subscribers (e.g.
 * useJournals) refetch. */
export function emitJournalsChanged() {
  window.dispatchEvent(new CustomEvent(JOURNALS_CHANGED_EVENT))
}

export function useJournals() {
  const { journals, activeJournalId, setJournals, setActiveJournalId } = useJournalStore()
  const activeVaultId = useInvisibleLockStore((s) => s.activeVaultId)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchJournals = useCallback(() => {
    setIsLoading(true)
    setError(null)

    listJournals(activeVaultId)
      .then((fetched: Journal[]) => {
        setJournals(fetched)
        setIsLoading(false)
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        setError(message)
        setIsLoading(false)
      })
  }, [setJournals, activeVaultId])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data-fetch on mount; would need TanStack Query to fix properly
    fetchJournals()
    // Refetch when the journal list changes — local CRUD or sync pulling
    // new/tombstoned journals from a peer (syncStore fans out this event
    // on transition into 'synced', covering the piggyback-upsert path
    // from entry pulls too). Without this, a peer's journal lands in
    // SQLite but the sidebar shows the stale in-memory list until reload.
    const handler = () => {
      fetchJournals()
    }
    window.addEventListener(JOURNALS_CHANGED_EVENT, handler)
    return () => {
      window.removeEventListener(JOURNALS_CHANGED_EVENT, handler)
    }
  }, [fetchJournals])

  const activeJournal = journals.find((j) => j.id === activeJournalId) ?? null

  const createJournal = async (
    name: string,
    color?: string,
    autoTagIds: string[] = [],
  ): Promise<Journal> => {
    const journal = await tauriCreateJournal(name, color, autoTagIds)
    const updated = await listJournals(activeVaultId)
    setJournals(updated)
    emitJournalsChanged()
    return journal
  }

  const updateJournal = async (
    id: string,
    name: string,
    color?: string,
    autoTagIds?: string[],
  ): Promise<Journal> => {
    const journal = await tauriUpdateJournal(id, name, color, autoTagIds)
    const updated = await listJournals(activeVaultId)
    setJournals(updated)
    emitJournalsChanged()
    return journal
  }

  const deleteJournal = async (id: string): Promise<void> => {
    await tauriDeleteJournal(id)
    const updated = await listJournals(activeVaultId)
    setJournals(updated)
    // [I3] Read latest activeJournalId from store, not closure
    const currentActiveId = useJournalStore.getState().activeJournalId
    if (currentActiveId === id) {
      setActiveJournalId(updated.length > 0 ? updated[0].id : null)
    }
    emitJournalsChanged()
    // The backend soft-deletes every entry in this journal, so the cached
    // ['entries'] pages and the calendar heatmap are both stale. Dispatched by
    // literal (not `emitEntriesChanged`) because `useEntries` already imports
    // `emitJournalsChanged` from here — importing back would close the cycle.
    window.dispatchEvent(new CustomEvent('memlore:entries-changed'))
  }

  const getEntryCount = async (journalId: string): Promise<number> => {
    return countEntriesInJournal(journalId)
  }

  const setActiveJournal = (id: string | null) => {
    setActiveJournalId(id)
  }

  return {
    journals,
    activeJournal,
    activeJournalId,
    isLoading,
    error,
    createJournal,
    updateJournal,
    deleteJournal,
    getEntryCount,
    setActiveJournal,
    refresh: fetchJournals,
  }
}
