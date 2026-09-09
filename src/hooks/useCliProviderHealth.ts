import { useCallback, useEffect, useRef, useState } from 'react'
import { type CliHealth, checkCliProviderHealth } from '../lib/tauri'
import { providerUsesSubprocess } from '../types/ai'

export interface UseCliProviderHealthResult {
  /** `null` while the first probe is in flight or when the active
   *  provider is not a CLI provider. */
  health: CliHealth | null
  /** True while a probe is in flight. */
  loading: boolean
  /** Last error string from the Tauri command, if any. */
  error: string | null
  /** Force a re-probe. */
  recheck: () => void
}

/**
 * Run `check_cli_provider_health` whenever `providerId` is a CLI
 * provider. Returns `null` health when the provider is HTTP-based
 * (no probe needed) so the consuming UI can render nothing.
 *
 * The hook owns its own debounce: rapid provider changes only fire
 * the latest probe. A `recheck` callback re-runs the probe on
 * demand (Settings panel's Recheck button).
 *
 * `model` is passed through to the backend so the Codex probe uses
 * the slot's configured model (Plus accounts have limited model
 * access; a hard-coded probe model would false-negative).
 */
export function useCliProviderHealth(
  providerId: string,
  model?: string,
): UseCliProviderHealthResult {
  const [health, setHealth] = useState<CliHealth | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Token survives across renders so a slow probe that resolves
  // after the user switches provider doesn't overwrite the new
  // provider's result.
  const runIdRef = useRef(0)

  const run = useCallback(async (id: string, m: string | undefined) => {
    if (!providerUsesSubprocess(id)) {
      // Bump the runId so any in-flight CLI→CLI probe gets
      // invalidated on a CLI→HTTP transition. Without this, a slow
      // claude probe could resolve after the user has switched to
      // an HTTP provider and stamp stale `health` back into the
      // store (visible as a flicker on the next CLI→CLI switch).
      runIdRef.current++
      setHealth(null)
      setLoading(false)
      setError(null)
      return
    }
    const myRun = ++runIdRef.current
    setLoading(true)
    setError(null)
    try {
      const h = await checkCliProviderHealth(id, m)
      if (runIdRef.current === myRun) {
        setHealth(h)
      }
    } catch (e) {
      if (runIdRef.current === myRun) {
        setError(String(e))
        setHealth(null)
      }
    } finally {
      if (runIdRef.current === myRun) {
        setLoading(false)
      }
    }
  }, [])

  useEffect(() => {
    void run(providerId, model)
  }, [providerId, model, run])

  const recheck = useCallback(() => {
    void run(providerId, model)
  }, [providerId, model, run])

  return { health, loading, error, recheck }
}
