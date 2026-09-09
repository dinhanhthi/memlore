import { useCallback, useEffect, useRef } from 'react'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { listAllMediaPaged } from '../lib/tauri'
import type { GalleryMediaRow } from '../lib/tauri'
import { usePageFor, useSetPageFor } from './useActiveTab'
import { type PagedResult } from '../types/pagination'
import { useInvisibleLockStore } from '../stores/invisibleLockStore'
import { useSecondLockStore } from '../stores/secondLockStore'
import { useUiStore } from '../stores/uiStore'

export type MediaKind = 'image' | 'video' | 'audio' | null

export interface UseAllMediaResult {
  media: GalleryMediaRow[]
  total: number
  totalPages: number
  page: number
  setPage: (p: number) => void
  isLoading: boolean
  error: string | null
  invalidate: () => Promise<void>
}

/**
 * Paginated gallery of all media across journals. The backend orders by
 * (created_at DESC, id DESC). Filter by `kind` ('image', 'video', 'audio')
 * to narrow the list. Changing `kind` resets the page to 1 via the
 * fingerprint mechanism.
 *
 * Built on TanStack Query v5: `isPending` drives `isLoading` so the skeleton
 * only shows on the first (cold-cache) load. `keepPreviousData` keeps the
 * previous page visible during pager clicks and kind changes, eliminating
 * intermediate skeleton flashes.
 *
 * Cache window is widened beyond the global default (`gcTime: 30min`,
 * `staleTime: 5min`) so that leaving the Media Gallery for another view and
 * coming back in the same session restores the grid immediately — no cold-
 * cache skeleton flash. Freshness is preserved by the event-driven invalidator
 * below: any insert/delete fires `memlore:media-changed`, which is bridged
 * to `queryClient.invalidateQueries({ queryKey: ['media'] })` at the app
 * level (see src/lib/queryClient.ts). This hook does NOT install a local
 * event listener.
 */
export function useAllMedia(opts: { kind?: MediaKind } = {}): UseAllMediaResult {
  const kind = opts.kind ?? null
  const page = usePageFor('media')
  const setPageFor = useSetPageFor()
  const queryClient = useQueryClient()
  const activeVaultId = useInvisibleLockStore((s) => s.activeVaultId)
  const lockedView = useSecondLockStore((s) => s.lockedView())
  const pageSize = useUiStore((s) => s.mediaPageSize)

  const queryKey = ['media', { kind, page, pageSize, lockedView, activeVaultId }] as const

  const query = useQuery<PagedResult<GalleryMediaRow>>({
    queryKey,
    queryFn: () => listAllMediaPaged(kind, page, lockedView, activeVaultId, pageSize),
    placeholderData: keepPreviousData,
    // Keep gallery pages in cache long enough that switching to another
    // view and back during a normal session does NOT trigger the cold-cache
    // skeleton. `memlore:media-changed` still invalidates eagerly, so a
    // long gcTime never serves stale data after an insert/delete.
    gcTime: 30 * 60_000,
    staleTime: 5 * 60_000,
  })

  // ── Fingerprint-change page reset ──────────────────────────────────────────
  // When kind changes AND page > 1, reset to 1 BEFORE TanStack sends a fetch
  // for (new-kind, old-page). The double-fetch is masked by placeholderData,
  // so visually correct. Without this, navigating to page 2 of "images" then
  // switching to "videos" would fetch page 2 of videos which is rarely what
  // the user wants. The same reset fires when `pageSize` changes: the old
  // page number is no longer meaningful under a new page size, and may even
  // exceed the new last page.
  const prevKindRef = useRef<MediaKind | undefined>(undefined)
  const prevPageSizeRef = useRef<number>(pageSize)
  useEffect(() => {
    const prevKind = prevKindRef.current
    prevKindRef.current = kind
    const prevPageSize = prevPageSizeRef.current
    prevPageSizeRef.current = pageSize
    const kindChanged = prevKind !== undefined && prevKind !== kind
    const pageSizeChanged = prevPageSize !== pageSize
    if ((kindChanged || pageSizeChanged) && page > 1) {
      setPageFor('media', 1)
    }
  }, [kind, pageSize, page, setPageFor])

  // ── invalidate helper ──────────────────────────────────────────────────────
  // Invalidates ALL 'media' queries (via the shared bridge prefix), then
  // auto-shifts back one page when the current page becomes empty after a
  // delete, so the user never lands on an empty page.
  const invalidate = useCallback(async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['media'] })
    const data = queryClient.getQueryData<PagedResult<GalleryMediaRow>>(queryKey)
    if (data && data.items.length === 0 && page > 1) {
      setPageFor('media', Math.max(1, page - 1))
    }
  }, [queryClient, queryKey, page, setPageFor])

  const total = query.data?.total ?? 0

  return {
    media: query.data?.items ?? [],
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    page,
    setPage: (n: number) => setPageFor('media', Math.max(1, n)),
    isLoading: query.isPending,
    error: query.error ? String(query.error) : null,
    invalidate,
  }
}
