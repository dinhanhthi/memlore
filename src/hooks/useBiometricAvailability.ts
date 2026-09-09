import { useEffect, useState } from 'react'
import * as tauri from '../lib/tauri'

export interface UseBiometricAvailability {
  /** True only when the platform probe answered "yes". */
  available: boolean
  /** True while the probe is in flight; false once it settles either way. */
  loading: boolean
}

/**
 * `useBiometricAvailability` — one-shot probe of `is_biometric_available()`,
 * the real backend command behind OS-keystore unlock (there is no
 * `is_os_kek_available` command).
 *
 * Failure policy: a rejected probe resolves to `available: false`, never
 * throws and never leaves `loading` stuck. Callers therefore degrade to
 * password-only — the guaranteed fallback on every platform — instead of
 * blocking on a platform question they cannot answer.
 *
 * `useAuth` exposes the same flag, but it also owns the whole lock/unlock
 * lifecycle; first-run onboarding has no session yet and only needs this bit.
 */
export function useBiometricAvailability(): UseBiometricAvailability {
  const [available, setAvailable] = useState(false)
  const [loading, setLoading] = useState(true)

  // Mount-only probe. The cancelled flag is React 18 StrictMode double-mount
  // safety (same pattern as useAuth.ts / useDeviceList.ts).
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const ok = await tauri.isBiometricAvailable()
        if (!cancelled) setAvailable(ok)
      } catch {
        // Probe failed (no keystore, platform error) — treat as unavailable.
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
