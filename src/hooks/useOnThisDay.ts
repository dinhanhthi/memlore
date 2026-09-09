import { useEffect, useState } from 'react'
import { listOnThisDay } from '../lib/tauri'
import type { Entry } from '../types/entry'
import { useInvisibleLockStore } from '../stores/invisibleLockStore'
import { useSecondLockStore } from '../stores/secondLockStore'

export interface DatePoint {
  month: number
  day: number
}

export interface DateGroup {
  date: DatePoint
  entries: Entry[]
}

interface UseOnThisDayResult {
  groups: DateGroup[]
  isLoading: boolean
  error: string | null
  isEmpty: boolean
}

/**
 * Fetch entries that share a calendar (month, day) with each requested date
 * across every journal, then optionally narrow the result to one journal on
 * the client. Used by the "On This Day" throwback view. Fetches all dates in
 * parallel via Promise.all. Re-fetches only when the set of (month, day) pairs
 * or the journal scope changes — uses a serialised dep key to avoid infinite
 * loops when callers pass a new array object on every render.
 */
export function useOnThisDay(
  dates: DatePoint[],
  journalId: string | null = null,
): UseOnThisDayResult {
  const [groups, setGroups] = useState<DateGroup[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Serialise the dates into a stable string so that passing a new array
  // object with identical (month, day) values does not trigger a re-fetch.
  const datesKey = dates.map((d) => `${d.month}-${d.day}`).join(',')
  const activeVaultId = useInvisibleLockStore((s) => s.activeVaultId)
  const lockedView = useSecondLockStore((s) => s.lockedView())

  useEffect(() => {
    let cancelled = false
    setIsLoading(true)
    setError(null)

    // Snapshot the dates at effect time so the closure references the correct
    // values even if the component re-renders before the fetches resolve.
    const snapshot = dates

    Promise.all(snapshot.map((d) => listOnThisDay(d.month, d.day, lockedView, activeVaultId)))
      .then((results) => {
        if (cancelled) return
        const fetched: DateGroup[] = snapshot.map((d, i) => ({
          date: d,
          entries:
            journalId === null
              ? results[i]
              : results[i].filter((entry) => entry.journal_id === journalId),
        }))
        setGroups(fetched)
        setIsLoading(false)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setGroups([])
        setError(err instanceof Error ? err.message : String(err))
        setIsLoading(false)
      })

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datesKey, journalId, lockedView, activeVaultId])

  const isEmpty = groups.every((g) => g.entries.length === 0)

  return { groups, isLoading, error, isEmpty }
}
