import { useEffect, useMemo, useState } from 'react'
import { semanticSearch } from '../lib/tauri'
import type { SearchFilters, SemanticHit } from '../types/entry'
import { useInvisibleLockStore } from '../stores/invisibleLockStore'
import { useSecondLockStore } from '../stores/secondLockStore'

const DEBOUNCE_MS = 300
const DEFAULT_LIMIT = 20

/**
 * Debounced semantic (cosine-ranked) search. Mirrors `useSearch` but
 * invokes the `semantic_search` Tauri command which embeds the query and
 * ranks `entries_embeddings` rows by cosine similarity against the
 * active embedder.
 *
 * Empty / whitespace-only queries skip the backend. Errors surface in
 * `error` so the overlay can show a friendly fallback.
 *
 * Filters are applied after cosine top-K in the backend (acceptable
 * trade-off documented in the plan's Risks section).
 *
 * **Stub note (A4):** until A3b-1b lights up the real ONNX backend, the
 * stub embedder produces deterministic-but-not-meaningful vectors. The
 * pipeline is structurally correct (top-K cosine ranking, snippet
 * trimming, score chip) — semantic relevance becomes meaningful for
 * free when the real embedder lands behind the same trait.
 */
export function useSemanticSearch(query: string, filters?: SearchFilters) {
  const [results, setResults] = useState<SemanticHit[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const activeVaultId = useInvisibleLockStore((s) => s.activeVaultId)
  const lockedView = useSecondLockStore((s) => s.lockedView())

  // Stabilize the filters object to prevent re-firing the debounce effect on
  // every render when the caller passes a fresh object literal each time.
  const filtersKey = useMemo(() => JSON.stringify(filters ?? {}), [filters])

  useEffect(() => {
    const trimmed = query.trim()
    if (!trimmed) {
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
      // Pass `lockedView` so the backend excludes second-lock entries (Covered
      // treated as Hidden) and `activeVaultId` so it excludes invisible ones —
      // mirrors `useSearch`. Both are in the deps array, so a mid-flight re-lock
      // triggers cleanup (cancelled = true) + a fresh call.
      semanticSearch(trimmed, DEFAULT_LIMIT, filters, lockedView, activeVaultId)
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- filtersKey is a stable serialization of filters
  }, [query, filtersKey, lockedView, activeVaultId])

  return { results, isLoading, error }
}
