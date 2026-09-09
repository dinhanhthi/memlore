import { useEffect, useState } from 'react'
import { listMapPins } from '../lib/tauri'
import type { MapPin } from '../types/map'
import { useInvisibleLockStore } from '../stores/invisibleLockStore'
import { useSecondLockStore } from '../stores/secondLockStore'

interface UseMapPinsResult {
  pins: MapPin[]
  isLoading: boolean
  error: string | null
  isEmpty: boolean
}

/**
 * One-shot fetch of every pin for the Locations Map. The backend already
 * soft-caps the result set, so there is no pagination to juggle here.
 *
 * Errors are surfaced as a single `error` string (Tauri commands reject
 * with either `Error` instances or plain strings — both are coerced).
 *
 * FOLLOW-UP: the hook does not refetch after mount. The result set goes
 * stale when the user creates/deletes an entry with GPS, adds/removes a
 * GPS-tagged photo, or locks/unlocks the app. The map picks up the new
 * state only on view remount. Refetch-on-focus (or an event-driven
 * invalidation scheme across all read-side hooks) is tracked in
 * `docs/memory/features/phase-4-features.md` under Locations follow-ups.
 */
export function useMapPins(): UseMapPinsResult {
  const [pins, setPins] = useState<MapPin[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const activeVaultId = useInvisibleLockStore((s) => s.activeVaultId)
  const lockedView = useSecondLockStore((s) => s.lockedView())

  useEffect(() => {
    let cancelled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data-fetch on mount; would need TanStack Query to fix properly
    setIsLoading(true)
    setError(null)
    listMapPins(lockedView, activeVaultId)
      .then((rows) => {
        if (cancelled) return
        setPins(rows)
        setIsLoading(false)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setPins([])
        setError(err instanceof Error ? err.message : String(err))
        setIsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [lockedView, activeVaultId])

  return {
    pins,
    isLoading,
    error,
    isEmpty: pins.length === 0,
  }
}
