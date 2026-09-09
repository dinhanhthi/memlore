import { useEffect, useState } from 'react'
import { getAiSettings } from '../lib/tauri'
import type { AIFullSettings } from '../types/ai'

/**
 * One-shot `getAiSettings()` probe. Re-runs when `gate` changes.
 * Catch → `false`. Does not subscribe to `useAiSettingsStore` — toggling
 * a flag in Settings is only picked up on the next probe, not live.
 */
export function useAiSettingsProbe(
  read: (s: AIFullSettings) => boolean,
  gate?: unknown,
): boolean | null {
  const [enabled, setEnabled] = useState<boolean | null>(null)

  useEffect(() => {
    let cancelled = false
    getAiSettings()
      .then((s) => {
        if (!cancelled) setEnabled(read(s))
      })
      .catch(() => {
        if (!cancelled) setEnabled(false)
      })
    return () => {
      cancelled = true
    }
    // `read` is a per-call-site property accessor; listing it would re-probe
    // every render when wrappers pass an inline arrow.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gate])

  return enabled
}
