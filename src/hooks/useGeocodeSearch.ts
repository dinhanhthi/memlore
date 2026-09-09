import { useState, useEffect, useRef } from 'react'
import { geocodeSearch } from '../lib/tauri'
import { randomId } from '../lib/randomId'
import type { GeocodeSuggestion } from '../types/geocoding'

interface UseGeocodeSearchOptions {
  minLength?: number
  debounceMs?: number
  limit?: number
  enabled?: boolean
}

interface UseGeocodeSearchResult {
  suggestions: GeocodeSuggestion[]
  isLoading: boolean
  error: string | null
  sessionToken: string
}

export function useGeocodeSearch(
  query: string,
  opts: UseGeocodeSearchOptions = {},
): UseGeocodeSearchResult {
  const { minLength = 2, debounceMs = 300, limit = 5, enabled = true } = opts

  const [suggestions, setSuggestions] = useState<GeocodeSuggestion[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Stable session token for the lifetime of this hook instance
  const sessionTokenRef = useRef<string>(randomId())

  // In-flight request counter to discard stale responses
  const inFlightIdRef = useRef<number>(0)

  const trimmed = query.trim()

  useEffect(() => {
    // Disabled — reset and make no network request
    if (!enabled) {
      inFlightIdRef.current++
      setSuggestions([])
      setError(null)
      setIsLoading(false)
      return
    }

    // Below min length — reset immediately, no invoke. Bump the in-flight id
    // so any earlier in-flight request resolves into a no-op (otherwise its
    // late results would re-populate the cleared dropdown — see C2 in review).
    if (trimmed.length < minLength) {
      inFlightIdRef.current++
      setSuggestions([])
      setError(null)
      setIsLoading(false)
      return
    }

    setIsLoading(true)

    const currentId = ++inFlightIdRef.current

    const timer = setTimeout(() => {
      geocodeSearch(trimmed, limit, sessionTokenRef.current)
        .then((results) => {
          // Discard stale responses
          if (currentId !== inFlightIdRef.current) return
          setSuggestions(results)
          setError(null)
          setIsLoading(false)
        })
        .catch((err: unknown) => {
          // Discard stale errors too
          if (currentId !== inFlightIdRef.current) return
          const message = err instanceof Error ? err.message : String(err)
          setError(message)
          setSuggestions([])
          setIsLoading(false)
        })
    }, debounceMs)

    return () => {
      clearTimeout(timer)
    }
  }, [trimmed, minLength, debounceMs, limit, enabled])

  return {
    suggestions,
    isLoading,
    error,
    sessionToken: sessionTokenRef.current,
  }
}
