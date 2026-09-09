/**
 * useAiAuditLog — paginated + filterable hook for the AI audit log.
 *
 * Pagination strategy: rows accumulate (append-only) on `loadMore`.
 * When `filter` changes the list resets to offset=0 and fetches fresh.
 * Deduplication by `id` prevents duplicates when the caller triggers
 * `loadMore` concurrently or after a `refresh`.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { aiAuditRowKey } from '../lib/aiAuditKey'
import {
  clearAiAuditLog,
  getAiAuditRetentionDays,
  listAiAuditLog,
  setAiAuditRetentionDays,
} from '../lib/tauri'
import type { AiAuditLogFilter, AiAuditLogRow } from '../types/ai'

// ─── Filter canonicalization ──────────────────────────────────────────────────
// Empty arrays are coerced to undefined so the backend treats them as "no filter"
// (rather than "no rows"). This is the hook boundary — callers need not worry.
function canonicalizeFilter(f: AiAuditLogFilter): AiAuditLogFilter {
  return {
    ...f,
    features: f.features && f.features.length > 0 ? f.features : undefined,
    providers: f.providers && f.providers.length > 0 ? f.providers : undefined,
    classifications:
      f.classifications && f.classifications.length > 0 ? f.classifications : undefined,
  }
}

const PAGE_SIZE = 25

export interface UseAiAuditLogReturn {
  rows: AiAuditLogRow[]
  isLoading: boolean
  error: string | null
  filter: AiAuditLogFilter
  setFilter: (f: AiAuditLogFilter) => void
  loadMore: () => void
  hasMore: boolean
  clearAll: () => Promise<void>
  refresh: () => void
  retention: number
  isRetentionLoading: boolean
  setRetention: (days: number) => Promise<void>
}

export function useAiAuditLog(): UseAiAuditLogReturn {
  const [rows, setRows] = useState<AiAuditLogRow[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilterState] = useState<AiAuditLogFilter>({})
  const [offset, setOffset] = useState(0)
  const [hasMore, setHasMore] = useState(true)
  const [retention, setRetentionState] = useState<number>(90)
  const [isRetentionLoading, setIsRetentionLoading] = useState(true)

  // Track the current filter version so in-flight requests from a
  // previous filter don't overwrite results from the latest one.
  const filterVersionRef = useRef(0)

  // ── Load a page of rows ──────────────────────────────────────────────────

  const fetchPage = useCallback(
    async (currentFilter: AiAuditLogFilter, currentOffset: number, version: number) => {
      setIsLoading(true)
      setError(null)
      try {
        const page = (await listAiAuditLog(currentFilter, PAGE_SIZE, currentOffset)) ?? []
        // Discard stale row/error state updates (filter changed while request was in-flight),
        // but always clear isLoading so the spinner is never stuck.
        if (version !== filterVersionRef.current) return

        setRows((prev) => {
          if (currentOffset === 0) {
            // Fresh load after filter change
            return page
          }
          // Append — dedup by composite key (device_id, local_seq) in case of race
          const seen = new Set(prev.map(aiAuditRowKey))
          const fresh = page.filter((r) => !seen.has(aiAuditRowKey(r)))
          return [...prev, ...fresh]
        })
        setHasMore(page.length === PAGE_SIZE)
      } catch (e) {
        if (version !== filterVersionRef.current) return
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        // Always clear loading — prevents the spinner getting stuck on stale
        // fetches that were discarded by a version mismatch.
        // Note: SQLite reads complete server-side regardless of whether we
        // keep the result; full request cancellation across Tauri IPC is
        // non-trivial and not worth the complexity for fast local reads.
        setIsLoading(false)
      }
    },
    [],
  )

  // ── Fetch first page when filter changes ─────────────────────────────────

  useEffect(() => {
    filterVersionRef.current += 1
    const version = filterVersionRef.current
    setOffset(0)
    setRows([])
    setHasMore(true)
    fetchPage(filter, 0, version)
  }, [filter, fetchPage])

  // ── Load retention setting once on mount ─────────────────────────────────

  useEffect(() => {
    void (async () => {
      try {
        setRetentionState(await getAiAuditRetentionDays())
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setIsRetentionLoading(false)
      }
    })()
  }, [])

  // ── Public API ────────────────────────────────────────────────────────────

  const setFilter = useCallback((f: AiAuditLogFilter) => {
    setFilterState(canonicalizeFilter(f))
  }, [])

  const loadMore = useCallback(() => {
    if (isLoading || !hasMore) return
    const nextOffset = offset + PAGE_SIZE
    setOffset(nextOffset)
    fetchPage(filter, nextOffset, filterVersionRef.current)
  }, [isLoading, hasMore, offset, filter, fetchPage])

  const clearAll = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      await clearAiAuditLog()
      // Reset to a clean slate
      filterVersionRef.current += 1
      const version = filterVersionRef.current
      setRows([])
      setOffset(0)
      setHasMore(false)
      // Re-check (will come back empty, hasMore=false)
      await fetchPage(filter, 0, version)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setIsLoading(false)
    }
  }, [filter, fetchPage])

  const refresh = useCallback(() => {
    // Trigger a fresh fetch by bumping the filter reference identity
    setFilterState((prev) => ({ ...prev }))
  }, [])

  const setRetention = useCallback(async (days: number) => {
    await setAiAuditRetentionDays(days)
    // Re-read the server-normalized value so local state stays consistent
    // even if a non-UI caller submitted a free-form number.
    try {
      const actual = await getAiAuditRetentionDays()
      setRetentionState(actual)
    } catch {
      // Non-critical — fall back to the optimistic value
      setRetentionState(days)
    }
  }, [])

  return {
    rows,
    isLoading,
    error,
    filter,
    setFilter,
    loadMore,
    hasMore,
    clearAll,
    refresh,
    retention,
    isRetentionLoading,
    setRetention,
  }
}
