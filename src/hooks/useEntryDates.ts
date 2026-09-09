import { useCallback, useEffect, useRef, useState } from 'react'
import { listEntryDates } from '../lib/tauri'
import { useInvisibleLockStore } from '../stores/invisibleLockStore'
import { useSecondLockStore } from '../stores/secondLockStore'

export interface UseEntryDatesResult {
  dates: number[]
  isLoading: boolean
  error: string | null
  refetch: () => Promise<void>
}

/**
 * Returns all entry_date timestamps for the given journal scope. Used by
 * CalendarPanel — does NOT paginate. EntryList mutations should call refetch()
 * to keep the heatmap accurate.
 *
 * A generation counter (via useRef) is used to ignore stale responses when
 * journalId changes mid-fetch — the same staleness pattern as usePagedQuery.
 */
export function useEntryDates(journalId: string | null): UseEntryDatesResult {
  const [dates, setDates] = useState<number[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Generation counter — bumped before every fetch. Resolved responses whose
  // captured generation is stale are silently discarded.
  const genRef = useRef(0)
  const activeVaultId = useInvisibleLockStore((s) => s.activeVaultId)
  const lockedView = useSecondLockStore((s) => s.lockedView())

  const fetchDates = useCallback(async (): Promise<void> => {
    const gen = ++genRef.current
    setIsLoading(true)
    setError(null)
    try {
      const result = await listEntryDates(journalId, lockedView, activeVaultId)
      if (gen !== genRef.current) return // stale — discard
      setDates(result)
      setIsLoading(false)
    } catch (err: unknown) {
      if (gen !== genRef.current) return // stale — discard
      // Keep previous dates on error (mirror usePagedQuery error semantics).
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      setIsLoading(false)
    }
  }, [journalId, lockedView, activeVaultId])

  useEffect(() => {
    void fetchDates()
  }, [fetchDates])

  return { dates, isLoading, error, refetch: fetchDates }
}
