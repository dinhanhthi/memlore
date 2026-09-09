import { useEffect, useState } from 'react'
import { icloudAvailability } from '../lib/tauri'

export interface UseIcloudAvailability {
  /** True only when iCloud Drive is present and readable. */
  available: boolean
  /** True while the probe is in flight; false once it settles either way. */
  loading: boolean
}

/**
 * One-shot probe of `icloud_availability()`. Failure (or a missing Drive
 * folder) resolves to `available: false` so the picker can disable the
 * iCloud card without blocking Connect.
 */
export function useIcloudAvailability(): UseIcloudAvailability {
  const [available, setAvailable] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const result = await icloudAvailability()
        if (!cancelled) setAvailable(result.available)
      } catch {
        if (!cancelled) setAvailable(false)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  return { available, loading }
}
