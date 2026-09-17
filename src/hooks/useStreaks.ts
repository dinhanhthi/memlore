import { useCallback, useEffect, useState } from 'react'
import { recalculateStreak } from '../lib/tauri'
import type { StreakInfo } from '../lib/tauri'

const STREAK_REFRESH_EVENT = 'memlore:streak-refresh'

type StreakRefreshEvent = CustomEvent<StreakInfo>

/**
 * Recalculate streak once and push the result to every `useStreaks`
 * subscriber (footer pill, dashboard card). Await this after a mutation
 * that changes day-buckets — create, delete, or `updateEntryDate` — so
 * the footer paints before `emitEntriesChanged` floods the backend mutex
 * with list refetches.
 *
 * Never throws: a streak IPC failure must not abort entry create/delete
 * or skip `emitEntriesChanged` / `markEntryDateUserEdited`.
 */
export async function emitStreakRefresh(): Promise<void> {
  try {
    const updated = await recalculateStreak()
    window.dispatchEvent(new CustomEvent(STREAK_REFRESH_EVENT, { detail: updated }))
  } catch (err) {
    console.error('Failed to refresh streak:', err)
  }
}

/**
 * Recalculates streak data on mount and listens for refresh events
 * dispatched by entry mutations.
 */
export function useStreaks() {
  const [streakInfo, setStreakInfo] = useState<StreakInfo | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const applyStreak = useCallback((info: StreakInfo) => {
    setStreakInfo(info)
    setIsLoading(false)
    setError(null)
  }, [])

  const refresh = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    await emitStreakRefresh()
    setIsLoading(false)
  }, [])

  useEffect(() => {
    let cancelled = false
    setIsLoading(true)
    setError(null)

    recalculateStreak()
      .then((info) => {
        if (cancelled) return
        applyStreak(info)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        const message = err instanceof Error ? err.message : String(err)
        setError(message)
        setIsLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [applyStreak])

  // Apply the already-computed payload from emitStreakRefresh — do not
  // kick off another recalculate_streak, which would queue behind the
  // entries-list refetch on AppState's mutex and leave the footer stale.
  useEffect(() => {
    const handler = (e: Event) => {
      const info = (e as StreakRefreshEvent).detail
      if (!info) return
      applyStreak(info)
    }
    window.addEventListener(STREAK_REFRESH_EVENT, handler)
    return () => window.removeEventListener(STREAK_REFRESH_EVENT, handler)
  }, [applyStreak])

  return { streakInfo, isLoading, error, refresh }
}
