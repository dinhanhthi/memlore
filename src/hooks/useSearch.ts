import { useEffect, useMemo, useState } from 'react'
import { searchEntries } from '../lib/tauri'
import type { SearchFilters, SearchResult } from '../types/entry'
import { useInvisibleLockStore } from '../stores/invisibleLockStore'
import { useSecondLockStore } from '../stores/secondLockStore'

const DEBOUNCE_MS = 300

/**
 * Debounced full-text search. Returns results, loading, and error state
 * for the current query. Empty or whitespace-only queries produce no results
 * without hitting the backend — unless filters are active, in which case the
 * backend is called to list entries matching those filters.
 */
export function useSearch(query: string, filters?: SearchFilters) {
  const [results, setResults] = useState<SearchResult[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const activeVaultId = useInvisibleLockStore((s) => s.activeVaultId)
  const lockedView = useSecondLockStore((s) => s.lockedView())

  // Stable JSON key so referentially-fresh-but-equal filter objects
  // don't re-trigger the debounce on every render. Mirrors
  // useSemanticSearch's filtersKey pattern.
  const filtersKey = useMemo(() => JSON.stringify(filters ?? {}), [filters])

  useEffect(() => {
    const trimmed = query.trim()
    // Blank query + no filters → empty results (preserves existing
    // behavior). Blank query WITH filters → call backend; the Tauri
    // command routes to list_entries_with_filters.
    const hasFilters = filters !== undefined && Object.keys(filters).length > 0
    if (!trimmed && !hasFilters) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- search reset; would need TanStack Query to fix properly
      setResults([])
      setIsLoading(false)
      setError(null)
      return
    }

    let cancelled = false
    setIsLoading(true)
    setError(null)

    const handle = setTimeout(() => {
      searchEntries(trimmed, filters, lockedView, activeVaultId)
        .then((found) => {
          if (cancelled) return
          setResults(found)
          setIsLoading(false)
        })
        .catch((err: unknown) => {
          if (cancelled) return
          const message = err instanceof Error ? err.message : String(err)
          setError(message)
          setIsLoading(false)
        })
    }, DEBOUNCE_MS)

    return () => {
      cancelled = true
      clearTimeout(handle)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- filtersKey is the stable proxy for filters
  }, [query, filtersKey, lockedView, activeVaultId])

  return { results, isLoading, error }
}
