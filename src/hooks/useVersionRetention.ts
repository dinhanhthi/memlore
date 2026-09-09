import { useCallback, useEffect, useState } from 'react'
import { getVersionRetentionDays, setVersionRetentionDays } from '../lib/tauri'

// ── Module-level cache for imperative (non-React) access ──────────────
let cachedDays: number | null = null
let retentionHydrated = false

/** Hydrate the module cache from SQLite. Safe to call multiple times. */
export async function hydrateVersionRetention(): Promise<void> {
  try {
    cachedDays = await getVersionRetentionDays()
    retentionHydrated = true
  } catch {
    // Leave default; palette will gate on hydrated.
  }
}

/** Non-reactive read — for command palette and non-React callers. */
export function getVersionRetention(): number | null {
  return cachedDays
}

export function isVersionRetentionHydrated(): boolean {
  return retentionHydrated
}

/** Imperative setter — for command palette and non-React callers. */
export async function setVersionRetentionImperative(days: number): Promise<void> {
  await setVersionRetentionDays(days)
  cachedDays = days
  retentionHydrated = true
}

export interface UseVersionRetentionResult {
  /** Retention in days (3, 7, or 15). Null until the initial fetch resolves. */
  days: number | null
  isLoading: boolean
  error: string | null
  setDays: (days: number) => Promise<void>
}

/** Get/set the version-history retention setting (Settings → Data panel). */
export function useVersionRetention(): UseVersionRetentionResult {
  const [days, setDaysState] = useState<number | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    getVersionRetentionDays()
      .then((value) => {
        if (!cancelled) setDaysState(value)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load retention')
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const setDays = useCallback(async (value: number): Promise<void> => {
    await setVersionRetentionDays(value)
    setDaysState(value)
  }, [])

  return { days, isLoading, error, setDays }
}
