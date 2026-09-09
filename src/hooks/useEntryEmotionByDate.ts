import { useEffect, useState } from 'react'
import { getEmotionByDate } from '../lib/tauri'
import type { EmotionKey } from '../types/entry'
import { useInvisibleLockStore } from '../stores/invisibleLockStore'
import { useSecondLockStore } from '../stores/secondLockStore'
import {
  getStatsCacheGeneration,
  onStatsCacheInvalidate,
  subscribeStatsCacheInvalidation,
} from './useStats'

type EmotionCacheValue = { data: Map<string, EmotionKey[]> } | { error: string }

const emotionCache = new Map<string, EmotionCacheValue>()

onStatsCacheInvalidate(() => {
  emotionCache.clear()
})

function emotionCacheKey(year: number, revealInvisible: string | null, lockedView: string): string {
  return `${year}|${revealInvisible}|${lockedView}`
}

function isEmotionError(value: EmotionCacheValue | undefined): value is { error: string } {
  return value !== undefined && 'error' in value
}

function rowsToMap(rows: Array<[string, EmotionKey]>): Map<string, EmotionKey[]> {
  const map = new Map<string, EmotionKey[]>()
  for (const [date, emotion] of rows) {
    const existing = map.get(date)
    if (existing) {
      existing.push(emotion)
    } else {
      map.set(date, [emotion])
    }
  }
  return map
}

function readCached(key: string): { data: Map<string, EmotionKey[]>; error: string | null } | null {
  const cached = emotionCache.get(key)
  if (cached === undefined) return null
  if (isEmotionError(cached)) return { data: new Map(), error: cached.error }
  return { data: cached.data, error: null }
}

/** Warm-cache check for `ChartsGate` — errors do not count as warm. */
export function hasCachedEntryEmotion(year: number): boolean {
  const revealInvisible = useInvisibleLockStore.getState().activeVaultId
  const lockedView = useSecondLockStore.getState().lockedView()
  const cached = emotionCache.get(emotionCacheKey(year, revealInvisible, lockedView))
  return cached !== undefined && !isEmotionError(cached)
}

/**
 * Fetch per-day emotions for `year` and expose them as a Map for O(1)
 * lookup — used by the calendar month-grid day-cell dot renderer and by
 * the year-long emotion heatmap on the Statistics page.
 *
 * Shared module cache keyed `${year}|${revealInvisible}|${lockedView}` so
 * `ChartsGate` can warm it and `CalendarPanel` reuses the same fetch.
 * Invalidated with stats via `invalidateStatsCache()`.
 *
 * The value is an ORDERED array of distinct emotions for that day
 * (most-recently-tagged first). A day with no tagged emotion is absent
 * from the Map. The array preserves the backend's ordering so callers
 * that only need a single colour (e.g. a year-heatmap cell) can pick
 * `arr[0]` and reliably get the latest emotion.
 */
export function useEntryEmotionByDate(year: number): {
  data: Map<string, EmotionKey[]>
  isLoading: boolean
  error: string | null
} {
  const activeVaultId = useInvisibleLockStore((s) => s.activeVaultId)
  const lockedView = useSecondLockStore((s) => s.lockedView())
  const cacheKey = emotionCacheKey(year, activeVaultId, lockedView)

  const [data, setData] = useState<Map<string, EmotionKey[]>>(
    () => readCached(cacheKey)?.data ?? new Map(),
  )
  const [isLoading, setIsLoading] = useState(() => emotionCache.get(cacheKey) === undefined)
  const [error, setError] = useState<string | null>(() => readCached(cacheKey)?.error ?? null)

  useEffect(() => {
    let cancelled = false

    const applyCached = (): boolean => {
      const hit = readCached(cacheKey)
      if (!hit) return false
      setData(hit.data)
      setError(hit.error)
      setIsLoading(false)
      return true
    }

    const fetchData = async () => {
      if (applyCached()) return

      const gen = getStatsCacheGeneration()
      setIsLoading(true)
      setError(null)
      try {
        const rows = await getEmotionByDate(year, lockedView, activeVaultId)
        if (cancelled || gen !== getStatsCacheGeneration()) return
        const map = rowsToMap(rows)
        emotionCache.set(cacheKey, { data: map })
        setData(map)
      } catch (err: unknown) {
        if (cancelled || gen !== getStatsCacheGeneration()) return
        const message = err instanceof Error ? err.message : String(err)
        emotionCache.set(cacheKey, { error: message })
        setError(message)
        setData(new Map())
      } finally {
        if (!cancelled && gen === getStatsCacheGeneration()) setIsLoading(false)
      }
    }

    void fetchData()
    const unsubscribe = subscribeStatsCacheInvalidation(() => {
      void fetchData()
    })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [year, lockedView, activeVaultId, cacheKey])

  return { data, isLoading, error }
}
