import { useCallback, useEffect, useRef, useState } from 'react'
import { usePageFor, useSetPageFor } from './useActiveTab'
import { PAGE_SIZE, type PagedResult, type PaginatedViewKey } from '../types/pagination'

export interface UsePagedQueryOpts<T> {
  viewKey: PaginatedViewKey
  /**
   * Async function that fetches a page. Stored in a ref internally so the
   * caller does NOT need to wrap it in `useCallback` — the effect re-fires
   * on `[fingerprint, page]` only, and always calls the latest fetcher.
   */
  fetcher: (page: number) => Promise<PagedResult<T>>
  /** Filter+sort fingerprint. Any change resets page to 1 and refetches. */
  fingerprint: string
  /** Items per page used only for totalPages math. Defaults to PAGE_SIZE (20). */
  pageSize?: number
}

export interface UsePagedQueryResult<T> {
  items: T[]
  total: number
  /** Math.max(1, Math.ceil(total / pageSize)) — derived, not stored. */
  totalPages: number
  /** 1-based page number, persisted in tabStore. Defaults to 1. */
  page: number
  isLoading: boolean
  error: string | null
  /** Set the current page. Clamped to ≥ 1 only; does NOT clamp to totalPages. */
  setPage: (page: number) => void
  /**
   * Re-fetch the current page immediately. On an empty page this does NOT
   * shift back — use `invalidate` after mutations instead.
   */
  refetch: () => Promise<void>
  /**
   * Re-fetch the current page. If the page returns empty items but total > 0
   * and page > 1, automatically shifts to max(1, page - 1) and lets the
   * effect re-fetch. Call after mutations that may delete the last item on a page.
   */
  invalidate: () => Promise<void>
  /**
   * Optimistically patch a single item in the current page by applying
   * `updater` to the matching item. No-op when the id is not in the
   * current page. Use for cheap mutations whose new state is known on the
   * client (e.g. toggle_favorite returns the new `is_favorite`) and which
   * don't reorder the list — avoids a full page refetch while keeping the
   * UI visually consistent.
   */
  patchItem: (predicate: (item: T) => boolean, updater: (item: T) => T) => void
}

export function usePagedQuery<T>(opts: UsePagedQueryOpts<T>): UsePagedQueryResult<T> {
  const { viewKey, fetcher, fingerprint, pageSize = PAGE_SIZE } = opts

  const page = usePageFor(viewKey)
  const setPageFor = useSetPageFor()

  const [items, setItems] = useState<T[]>([])
  const [total, setTotal] = useState(0)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Generation counter — bumped before every fetch. Resolved responses whose
  // captured generation is stale are silently discarded.
  const genRef = useRef(0)

  // Caller may pass an inline lambda; keep the latest reference so the effect
  // never sees a stale closure regardless of useCallback discipline.
  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher

  // Track the previous fingerprint to detect changes vs. initial mount.
  const prevFingerprintRef = useRef<string | undefined>(undefined)

  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  const setPage = useCallback(
    (n: number) => {
      setPageFor(viewKey, Math.max(1, n))
    },
    [setPageFor, viewKey],
  )

  // Single shared async fetch path used by the effect, refetch, and invalidate.
  // `shiftOnEmpty=true` (invalidate semantics) shifts to page-1 when the current
  // page comes back empty but total>0 and page>1.
  const runFetch = useCallback(
    async (forPage: number, opts: { shiftOnEmpty: boolean }): Promise<void> => {
      const gen = ++genRef.current
      setIsLoading(true)
      setError(null)
      try {
        const result = await fetcherRef.current(forPage)
        if (gen !== genRef.current) return // stale — discard
        // The web preview's invoke router returns `null` for unhandled
        // commands (see web/mocks/invokeRouter.ts); treat a nullish result
        // as an empty page rather than throwing on `result.items`. The real
        // backend always returns a fully-populated PagedResult.
        const items = result?.items ?? []
        const total = result?.total ?? 0
        if (opts.shiftOnEmpty && items.length === 0 && total > 0 && forPage > 1) {
          // Mutation removed the last item on this page. Shift back; the effect
          // re-fires on the page change and runs a fresh fetch. Keep isLoading=true
          // through the gap so the UI doesn't flash "empty, done" before refetch.
          setPageFor(viewKey, Math.max(1, forPage - 1))
          return
        }
        setItems(items)
        setTotal(total)
        setIsLoading(false)
      } catch (err: unknown) {
        if (gen !== genRef.current) return // stale — discard
        // Preserve the previous items/total so a transient error doesn't
        // collapse the pager to "page 1 of 1" and lose the user's place.
        setError(String(err))
        setIsLoading(false)
      }
    },
    [setPageFor, viewKey],
  )

  // Single combined effect keyed on [fingerprint, page].
  //
  // Fingerprint-change path: if page > 1 reset it to 1 and return — the
  // resulting page change re-enters this effect with the new fingerprint and
  // page=1, and the fetch branch then runs. This avoids fetching page=N
  // against the new filter set before page resets to 1.
  //
  // Fetch branch: runFetch(page) with shiftOnEmpty=false (effect-driven fetches
  // shouldn't second-guess the page; invalidate is the only path that shifts).
  useEffect(() => {
    const prevFp = prevFingerprintRef.current
    const fingerprintChanged = prevFp !== undefined && prevFp !== fingerprint

    prevFingerprintRef.current = fingerprint

    if (fingerprintChanged && page > 1) {
      setPageFor(viewKey, 1)
      return
    }

    void runFetch(page, { shiftOnEmpty: false })
  }, [fingerprint, page, runFetch, setPageFor, viewKey])

  const refetch = useCallback(() => runFetch(page, { shiftOnEmpty: false }), [runFetch, page])

  const invalidate = useCallback(() => runFetch(page, { shiftOnEmpty: true }), [runFetch, page])

  const patchItem = useCallback((predicate: (item: T) => boolean, updater: (item: T) => T) => {
    setItems((prev) => {
      let changed = false
      const next = prev.map((item) => {
        if (!predicate(item)) return item
        changed = true
        return updater(item)
      })
      return changed ? next : prev
    })
  }, [])

  return {
    items,
    total,
    totalPages,
    page,
    isLoading,
    error,
    setPage,
    refetch,
    invalidate,
    patchItem,
  }
}
