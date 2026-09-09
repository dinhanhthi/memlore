import { useCallback, useState } from 'react'

/**
 * Last overlay keep-results choice for this app session.
 * Not written to SQLite or localStorage — close/reopen restores
 * it; app restart resets to false.
 */
let sessionKeepResults = false

/**
 * Session-scoped keep-results toggle for the search overlay.
 * When ON, SearchOverlayContent stays mounted (hidden) so query,
 * filters, mode, and last results survive close/reopen.
 */
export function useSearchOverlayKeepResults(): {
  keepResults: boolean
  setKeepResults: (next: boolean) => void
} {
  const [keepResults, setKeepResultsState] = useState(sessionKeepResults)

  const setKeepResults = useCallback((next: boolean) => {
    sessionKeepResults = next
    setKeepResultsState(next)
  }, [])

  return { keepResults, setKeepResults }
}

/** Keep SearchOverlayContent mounted while the overlay is open or keep-results is on. */
export function shouldRetainSearchOverlayContent(open: boolean, keepResults: boolean): boolean {
  return open || keepResults
}

/**
 * Remount SearchOverlayContent when the vault or second-lock view
 * changes so keep-results never spans those isolation boundaries.
 */
export function searchOverlayRetentionKey(
  activeVaultId: string | null,
  lockedView: string,
): string {
  return `${activeVaultId ?? ''}:${lockedView}`
}

/** Test-only: reset module state between cases. */
export function __resetSearchOverlayKeepResultsForTests(): void {
  sessionKeepResults = false
}
