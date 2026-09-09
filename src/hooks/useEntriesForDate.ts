import { useCallback, useEffect, useRef, useState } from 'react'
import { listEntriesForDateRange } from '../lib/tauri'
import type { Entry } from '../types/entry'
import { useInvisibleLockStore } from '../stores/invisibleLockStore'
import { useSecondLockStore } from '../stores/secondLockStore'

export interface UseEntriesForDateResult {
  entries: Entry[]
  isLoading: boolean
  error: string | null
  refetch: () => Promise<void>
}

/**
 * Fetch all non-deleted entries written on `selectedDateIso` (YYYY-MM-DD) within
 * the given journal scope. When `selectedDateIso` is null returns an empty
 * list without hitting the backend.
 *
 * Used by CalendarPanel's right pane. Independent of the paged useEntries +
 * tabStore page state so opening the calendar can't disturb EntryList's page.
 */
export function useEntriesForDate(
  journalId: string | null,
  selectedDateIso: string | null,
): UseEntriesForDateResult {
  const [entries, setEntries] = useState<Entry[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const genRef = useRef(0)
  const activeVaultId = useInvisibleLockStore((s) => s.activeVaultId)
  const lockedView = useSecondLockStore((s) => s.lockedView())

  const fetchEntries = useCallback(async () => {
    if (!selectedDateIso) {
      setEntries([])
      setIsLoading(false)
      setError(null)
      return
    }
    const [y, m, d] = selectedDateIso.split('-').map(Number)
    if (!y || !m || !d) {
      setEntries([])
      setIsLoading(false)
      setError(null)
      return
    }
    const fromTs = Math.floor(new Date(y, m - 1, d, 0, 0, 0, 0).getTime() / 1000)
    const toTs = Math.floor(new Date(y, m - 1, d + 1, 0, 0, 0, 0).getTime() / 1000)

    const gen = ++genRef.current
    setIsLoading(true)
    setError(null)
    try {
      const result = await listEntriesForDateRange(
        journalId,
        fromTs,
        toTs,
        lockedView,
        activeVaultId,
      )
      if (gen !== genRef.current) return
      setEntries(result)
      setIsLoading(false)
    } catch (err: unknown) {
      if (gen !== genRef.current) return
      setError(err instanceof Error ? err.message : String(err))
      setIsLoading(false)
    }
  }, [journalId, lockedView, activeVaultId, selectedDateIso])

  useEffect(() => {
    void fetchEntries()
  }, [fetchEntries])

  // Refresh when EntryList mutates — same broadcast useEntryDates listens to.
  useEffect(() => {
    const handler = () => {
      void fetchEntries()
    }
    window.addEventListener('memlore:entries-changed', handler)
    return () => window.removeEventListener('memlore:entries-changed', handler)
  }, [fetchEntries])

  return { entries, isLoading, error, refetch: fetchEntries }
}
