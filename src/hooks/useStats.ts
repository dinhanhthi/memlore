import { useEffect, useRef, useState } from 'react'

type CacheValue = { data: unknown } | { error: string }

const cache = new Map<string, CacheValue>()
let generation = 0
const invalidationListeners = new Set<() => void>()
const extraClears: Array<() => void> = []

function isCachedError(value: CacheValue | undefined): value is { error: string } {
  return value !== undefined && 'error' in value
}

function clearAllCaches(): void {
  cache.clear()
  for (const clear of extraClears) clear()
}

/** Register a companion cache (emotion) to clear with stats. */
export function onStatsCacheInvalidate(clear: () => void): void {
  extraClears.push(clear)
}

export function subscribeStatsCacheInvalidation(listener: () => void): () => void {
  invalidationListeners.add(listener)
  return () => {
    invalidationListeners.delete(listener)
  }
}

export function getStatsCacheGeneration(): number {
  return generation
}

/** Drop caches and ignore in-flight writes without notifying mounted hooks. */
export function dropStatsCaches(): void {
  generation += 1
  clearAllCaches()
}

/** Clear every stats/emotion cache entry, ignore in-flight writes, and refetch. */
export function invalidateStatsCache(): void {
  dropStatsCaches()
  for (const listener of invalidationListeners) listener()
}

/** Exposed for test teardown only — do not call in production code. */
export function __clearStatsCache(): void {
  generation += 1
  clearAllCaches()
}

/**
 * Whether `cacheKey` already has a successful value — lets a caller decide,
 * before any hook runs, that data is warm and no loading state is needed.
 * Used by `ChartsGate` so returning to a warm Statistics tab renders the
 * charts straight away instead of flashing one skeleton frame.
 *
 * Cached errors do not count as warm: the gate stays closed and offers retry.
 */
export function hasCachedStats(cacheKey: string): boolean {
  const cached = cache.get(cacheKey)
  return cached !== undefined && !isCachedError(cached)
}

export interface UseStatsResult<T> {
  data: T | null
  isLoading: boolean
  error: string | null
}

function readCached<T>(cacheKey: string): { data: T | null; error: string | null } | null {
  const cached = cache.get(cacheKey)
  if (cached === undefined) return null
  if (isCachedError(cached)) return { data: null, error: cached.error }
  return { data: cached.data as T, error: null }
}

/**
 * Generic hook for fetching stats data from the Tauri backend.
 *
 * Accepts a typed fetcher function (from src/lib/tauri.ts) and an explicit
 * cache key. Responses (including errors) are cached in a module-scoped Map
 * for the session. `invalidateStatsCache()` drops the map and bumps a
 * generation counter so in-flight resolves cannot repopulate after lock
 * or an entry mutation.
 *
 * When `cacheKey` changes to a key already in cache (e.g. user tabs between
 * periods), the cached value is applied synchronously — no second fetch.
 */
export function useStats<T>(fetcher: () => Promise<T>, cacheKey: string): UseStatsResult<T> {
  const [data, setData] = useState<T | null>(() => readCached<T>(cacheKey)?.data ?? null)
  const [isLoading, setIsLoading] = useState<boolean>(() => cache.get(cacheKey) === undefined)
  const [error, setError] = useState<string | null>(() => readCached<T>(cacheKey)?.error ?? null)

  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher

  useEffect(() => {
    let cancelled = false

    const applyCached = (): boolean => {
      const hit = readCached<T>(cacheKey)
      if (!hit) return false
      setData(hit.data)
      setError(hit.error)
      setIsLoading(false)
      return true
    }

    const run = async () => {
      if (applyCached()) return

      const gen = generation
      setIsLoading(true)
      setError(null)

      try {
        const result = await fetcherRef.current()
        if (cancelled || gen !== generation) return
        cache.set(cacheKey, { data: result })
        setData(result)
      } catch (err: unknown) {
        if (cancelled || gen !== generation) return
        const message = err instanceof Error ? err.message : String(err)
        cache.set(cacheKey, { error: message })
        setError(message)
        setData(null)
      } finally {
        if (!cancelled && gen === generation) setIsLoading(false)
      }
    }

    void run()
    const unsubscribe = subscribeStatsCacheInvalidation(() => {
      void run()
    })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [cacheKey])

  return { data, isLoading, error }
}
