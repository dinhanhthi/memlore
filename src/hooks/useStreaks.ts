import { useCallback, useEffect, useState } from 'react'
import { recalculateStreak } from '../lib/tauri'
import type { StreakInfo } from '../lib/tauri'

const STREAK_REFRESH_EVENT = 'memlore:streak-refresh'

/** Call this after entry create/delete to refresh the streak display globally. */
export function emitStreakRefresh() {
  window.dispatchEvent(new Event(STREAK_REFRESH_EVENT))
}

/**
 * Recalculates streak data on mount and listens for refresh events
 * dispatched by entry mutations.
 */
export function useStreaks() {
  const [streakInfo, setStreakInfo] = useState<StreakInfo | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const updated = await recalculateStreak()
      setStreakInfo(updated)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    setIsLoading(true)
    setError(null)

    recalculateStreak()
      .then((info) => {
        if (cancelled) return
        setStreakInfo(info)
        setIsLoading(false)
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
  }, [])

  // Listen for global refresh events from entry mutations
  useEffect(() => {
    const handler = () => {
      refresh()
    }
    window.addEventListener(STREAK_REFRESH_EVENT, handler)
    return () => window.removeEventListener(STREAK_REFRESH_EVENT, handler)
  }, [refresh])

  return { streakInfo, isLoading, error, refresh }
}
