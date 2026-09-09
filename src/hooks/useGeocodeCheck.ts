import { useCallback, useEffect, useRef, useState } from 'react'
import { geocodeCheck } from '../lib/tauri'

export type GeocodeCheckStatus = 'idle' | 'checking' | 'success' | 'error'

/**
 * Known stable error codes returned by `geocode_check`. Anything else falls
 * through to `unknown` so the UI can still render *something* sensible.
 */
export type GeocodeCheckErrorCode =
  | 'missing_api_key'
  | 'invalid_key'
  | 'rate_limited'
  | 'network_error'
  | 'server_error'
  | 'invalid_response'
  | 'unknown'

const KNOWN_CODES = new Set<GeocodeCheckErrorCode>([
  'missing_api_key',
  'invalid_key',
  'rate_limited',
  'network_error',
  'server_error',
  'invalid_response',
])

function normalizeError(err: unknown): GeocodeCheckErrorCode {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  return KNOWN_CODES.has(raw as GeocodeCheckErrorCode) ? (raw as GeocodeCheckErrorCode) : 'unknown'
}

interface UseGeocodeCheckResult {
  status: GeocodeCheckStatus
  errorCode: GeocodeCheckErrorCode | null
  check: (provider: string, apiKey?: string) => Promise<void>
  reset: () => void
}

/**
 * Per-provider hook that probes a geocoding provider with a fixed test query.
 * Keeps a small state machine — `idle` → `checking` → `success` | `error`.
 * Successful and failed results auto-reset to `idle` after `autoResetMs`
 * (default 5s) so the inline indicator doesn't stick around forever.
 * The hook is single-flight: starting a new `check()` discards the result of
 * any previous in-flight call.
 */
export function useGeocodeCheck(autoResetMs = 5000): UseGeocodeCheckResult {
  const [status, setStatus] = useState<GeocodeCheckStatus>('idle')
  const [errorCode, setErrorCode] = useState<GeocodeCheckErrorCode | null>(null)
  const inFlightIdRef = useRef(0)
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const reset = useCallback(() => {
    inFlightIdRef.current++
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current)
    resetTimerRef.current = null
    setStatus('idle')
    setErrorCode(null)
  }, [])

  const scheduleReset = useCallback(() => {
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current)
    resetTimerRef.current = setTimeout(() => {
      setStatus('idle')
      setErrorCode(null)
      resetTimerRef.current = null
    }, autoResetMs)
  }, [autoResetMs])

  const check = useCallback(
    async (provider: string, apiKey?: string) => {
      if (resetTimerRef.current) {
        clearTimeout(resetTimerRef.current)
        resetTimerRef.current = null
      }
      const id = ++inFlightIdRef.current
      setStatus('checking')
      setErrorCode(null)
      try {
        await geocodeCheck(provider, apiKey)
        if (id !== inFlightIdRef.current) return
        setStatus('success')
        scheduleReset()
      } catch (err) {
        if (id !== inFlightIdRef.current) return
        setStatus('error')
        setErrorCode(normalizeError(err))
        scheduleReset()
      }
    },
    [scheduleReset],
  )

  // Cancel any pending auto-reset + invalidate in-flight probes on unmount
  // so a deferred setState never lands on a torn-down component.
  useEffect(() => {
    return () => {
      inFlightIdRef.current++
      if (resetTimerRef.current) {
        clearTimeout(resetTimerRef.current)
        resetTimerRef.current = null
      }
    }
  }, [])

  return { status, errorCode, check, reset }
}
