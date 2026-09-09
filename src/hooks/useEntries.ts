// useEntries no longer populates entryStore. Other consumers that need per-id lookup
// keep using entryStore.entriesById which is populated by EditorPanel mutations.

import { useCallback, useEffect, useRef } from 'react'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  createEntry as tauriCreateEntry,
  updateEntry as tauriUpdateEntry,
  updateEntryLocation,
  softDeleteEntry,
  toggleFavorite as tauriToggleFavorite,
  getSetting,
  listEntriesPaged,
  listAllEntriesPaged,
  listFavoriteEntriesPaged,
  listEntriesByTagPaged,
  listJournals,
} from '../lib/tauri'
import { emitJournalsChanged } from './useJournals'
import { emitStreakRefresh } from './useStreaks'
import { applyEntryWeather } from './applyEntryWeather'
import { useJournalStore } from '../stores/journalStore'
import { emitMediaChanged } from '../lib/mediaEvents'
import { usePageFor, useSetPageFor } from './useActiveTab'
import type { CreateEntryParams, Entry } from '../types/entry'
import type {
  EntrySort,
  EntryTimeRange,
  LockFilter,
  PagedResult,
  PaginatedViewKey,
} from '../types/pagination'
import { PAGE_SIZE } from '../types/pagination'
import { useInvisibleLockStore } from '../stores/invisibleLockStore'
import { useSecondLockStore } from '../stores/secondLockStore'

/**
 * Broadcast to refresh the calendar heatmap after entry create/delete.
 *
 * Invariant: only mutations that shift which *day-bucket* an entry lives in
 * need to re-fetch the heatmap — create (new day-bucket) and soft-delete
 * (day-bucket count decreases). Do NOT call this from `updateEntry`,
 * `toggleFavorite`, emotion/weather/location edits, etc. — those don't
 * change per-day counts and an extra fetch would just flicker the UI.
 */
export function emitEntriesChanged() {
  window.dispatchEvent(new CustomEvent('memlore:entries-changed'))
}

/**
 * Payload for `memlore:entry-patched`. The listener in `useEntries`
 * merges `patch` into the matching item by id — no refetch, no
 * "Loading" flicker. Use this for high-frequency micro-updates like
 * auto-save title / preview changes; reserve `emitEntriesChanged` for
 * shape-changing edits (create, delete, favourite toggle on a
 * favourites-only view, etc.) where a full refetch is justified.
 */
export interface EntryPatchDetail {
  id: string
  patch: Partial<Entry>
}

export function emitEntryPatched(id: string, patch: Partial<Entry>): void {
  window.dispatchEvent(
    new CustomEvent<EntryPatchDetail>('memlore:entry-patched', { detail: { id, patch } }),
  )
}

export interface UseEntriesParams {
  /** Scopes any of the views below (tag, favorites, or plain) to one journal.
   * Null = all journals. */
  journalId?: string | null
  /** Combinable with `favoritesOnly` — narrows the tagged list to favorites. */
  tagId?: string | null
  /** When true, returns favorites within the journalId/tagId scope (or global
   * when both are null). */
  favoritesOnly?: boolean
  sort?: EntrySort
  range?: EntryTimeRange
  /** Custom date-range bounds in seconds. Used when caller's TimeRange is `kind: 'custom'`. */
  fromTs?: number | null
  /** Custom date-range bounds in seconds. Used when caller's TimeRange is `kind: 'custom'`. */
  toTs?: number | null
  firstDayOfWeek?: 0 | 1
  lockFilter?: LockFilter
}

export function useEntries(params: UseEntriesParams = {}): {
  entries: Entry[]
  total: number
  totalPages: number
  page: number
  setPage: (p: number) => void
  isLoading: boolean
  error: string | null
  createEntry: (params: CreateEntryParams) => Promise<Entry>
  updateEntry: (
    id: string,
    title?: string,
    contentText?: string,
    previewText?: string,
  ) => Promise<Entry>
  deleteEntry: (id: string) => Promise<void>
  toggleFavorite: (id: string) => Promise<boolean>
} {
  const {
    journalId = null,
    tagId = null,
    favoritesOnly = false,
    sort = 'newest',
    range = 'all',
    fromTs = null,
    toTs = null,
    firstDayOfWeek = 1,
    lockFilter = 'all',
  } = params

  // viewKey precedence: tagId > favoritesOnly > journalId > none. Every
  // branch that toggles `favoritesOnly` gets its own pagination bucket (here
  // and in the `favorites:` branch below) — reusing one bucket across a
  // starred toggle would leave a stale page number when the result set
  // shrinks, and the fingerprint-based page-reset effect keys off `viewKey`,
  // not the raw `favoritesOnly` flag, so it wouldn't catch this otherwise.
  let viewKey: PaginatedViewKey
  if (tagId) {
    viewKey = favoritesOnly
      ? `tag:${tagId}:${journalId ?? 'all'}:favorites`
      : `tag:${tagId}:${journalId ?? 'all'}`
  } else if (favoritesOnly) {
    viewKey = `favorites:${journalId ?? 'all'}`
  } else if (journalId) {
    viewKey = `journal:${journalId}`
  } else {
    viewKey = 'all'
  }

  const page = usePageFor(viewKey)
  const setPageFor = useSetPageFor()
  const activeVaultId = useInvisibleLockStore((s) => s.activeVaultId)
  const lockedView = useSecondLockStore((s) => s.lockedView())

  const queryClient = useQueryClient()

  // Stable, JSON-serializable queryKey. Top-level 'entries' ensures the
  // app-level bridge (invalidateQueries({ queryKey: ['entries'] })) catches all
  // variants when memlore:entries-changed fires.
  const queryKey = [
    'entries',
    {
      viewKey,
      journalId: journalId ?? null,
      tagId: tagId ?? null,
      favoritesOnly,
      sort,
      range,
      fromTs: fromTs ?? null,
      toTs: toTs ?? null,
      firstDayOfWeek,
      page,
      lockedView,
      activeVaultId,
      lockFilter,
    },
  ] as const

  const query = useQuery<PagedResult<Entry>>({
    queryKey,
    queryFn: async (): Promise<PagedResult<Entry>> => {
      if (tagId) {
        return listEntriesByTagPaged(
          tagId,
          journalId ?? null,
          favoritesOnly,
          sort,
          range,
          fromTs,
          toTs,
          firstDayOfWeek,
          page,
          lockedView,
          activeVaultId,
          lockFilter,
        )
      }
      if (favoritesOnly) {
        return listFavoriteEntriesPaged(
          journalId ?? null,
          sort,
          range,
          fromTs,
          toTs,
          firstDayOfWeek,
          page,
          lockedView,
          activeVaultId,
          lockFilter,
        )
      }
      if (journalId) {
        return listEntriesPaged(
          journalId,
          sort,
          range,
          fromTs,
          toTs,
          firstDayOfWeek,
          page,
          lockedView,
          activeVaultId,
          lockFilter,
        )
      }
      return listAllEntriesPaged(
        sort,
        range,
        fromTs,
        toTs,
        firstDayOfWeek,
        page,
        lockedView,
        activeVaultId,
        lockFilter,
      )
    },
    // Keep previous page visible during pager clicks and filter changes —
    // eliminates intermediate skeleton flash for any non-cold cache miss.
    // `keepPreviousData` is the v5 named sentinel for `placeholderData: (prev) => prev`.
    // isPending stays false (cached data exists), isFetching becomes true.
    // The skeleton keys on isPending, not isFetching.
    placeholderData: keepPreviousData,
  })

  // ── Fingerprint-change page reset ──────────────────────────────────────────
  // When filters/sort change AND page > 1, reset to 1 BEFORE TanStack sends a
  // fetch for (new-filter, old-page). The double-fetch (new-filter, old-page)
  // then (new-filter, page-1) is masked by placeholderData, so visually correct.
  const prevFingerprintRef = useRef<string | undefined>(undefined)
  const fingerprint = JSON.stringify({
    viewKey,
    journalId,
    sort,
    range,
    fromTs,
    toTs,
    firstDayOfWeek,
    lockedView,
    activeVaultId,
    lockFilter,
  })
  useEffect(() => {
    const prev = prevFingerprintRef.current
    prevFingerprintRef.current = fingerprint
    if (prev !== undefined && prev !== fingerprint && page > 1) {
      setPageFor(viewKey, 1)
    }
  }, [fingerprint, page, setPageFor, viewKey])

  // ── In-place patch via setQueryData ────────────────────────────────────────
  // `memlore:entry-patched` merges a partial entry into the cached page data
  // without a refetch. Use a ref for queryKey so this effect binds once (on
  // mount / queryClient change) rather than re-subscribing on every render when
  // the queryKey array reference changes.
  const queryKeyRef = useRef(queryKey)
  // Intentional render-time write: the patch listener (below) reads this ref
  // when the event fires, so it must reflect the latest queryKey synchronously.
  // Moving this into useEffect would introduce a one-render lag and miss patches
  // that fire between render and effect.
  queryKeyRef.current = queryKey

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<EntryPatchDetail>).detail
      if (!detail || !detail.id) return
      // setQueriesData walks ALL cached ['entries', ...] variants so cross-page
      // cached entries (e.g. page 1 while viewing page 2) are kept coherent.
      // The updater returns `prev` unchanged when no item matches, making
      // iteration across many pages cheap.
      queryClient.setQueriesData<PagedResult<Entry>>({ queryKey: ['entries'] }, (prev) => {
        if (!prev) return prev
        let changed = false
        const items = prev.items.map((entry) => {
          if (entry.id !== detail.id) return entry
          changed = true
          return { ...entry, ...detail.patch }
        })
        return changed ? { ...prev, items } : prev
      })
    }
    window.addEventListener('memlore:entry-patched', handler as EventListener)
    return () => window.removeEventListener('memlore:entry-patched', handler as EventListener)
  }, [queryClient])

  // ── invalidate helper ──────────────────────────────────────────────────────
  // Invalidates ALL 'entries' queries (via the shared bridge prefix), then
  // auto-shifts back one page when the current page becomes empty after a
  // delete/unfavorite, so the user never lands on an empty page.
  // `data.total === 0` is deliberately included: if the user deletes the only
  // entry on a non-first page the whole view is empty and they'd be stranded.
  const invalidate = useCallback(async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['entries'] })
    const data = queryClient.getQueryData<PagedResult<Entry>>(queryKeyRef.current)
    if (data && data.items.length === 0 && page > 1) {
      setPageFor(viewKey, Math.max(1, page - 1))
    }
  }, [queryClient, page, viewKey, setPageFor])

  // ── Mutations ──────────────────────────────────────────────────────────────

  const createEntry = async (createParams: CreateEntryParams): Promise<Entry> => {
    // Self-heal: when the backend reports `JOURNAL_NOT_FOUND` it means the
    // frontend's cached journal id is stale relative to the DB (most often
    // observed right after the password-mode first-time setup re-keys the
    // SQLCipher DB and swaps the in-process connection — a tiny window in
    // which a previously-loaded journal id can drift). Re-fetch journals,
    // pick the first one, and retry once. This protects every caller from
    // seeing the opaque `FOREIGN KEY constraint failed` SQLite surface.
    let entry: Entry
    try {
      entry = await tauriCreateEntry(createParams)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes('JOURNAL_NOT_FOUND')) {
        // Telemetry: the drift is rare and recoverable; log so we can tell
        // from console logs how often the self-heal path triggers.
        // eslint-disable-next-line no-console
        console.warn('createEntry: stale journal id; refreshing journals and retrying once', {
          stale: createParams.journal_id,
        })
        const fresh = await listJournals(activeVaultId)
        const firstId = fresh[0]?.id
        if (!firstId) {
          throw err
        }
        // Update the Zustand store IN-PLACE so every other subscriber
        // (EntryList's listEntriesPaged query keyed on activeJournalId,
        // the sidebar journal picker, etc.) reads the fresh state
        // synchronously. Just emitting `journals-changed` is not enough:
        // the entry-list query reads `activeJournalId` from the Zustand
        // store via a selector, so if `activeJournalId` still points at
        // the stale id the list call returns empty even though the entry
        // was successfully created. Reset both `journals` and
        // `activeJournalId` (when it matches the stale id) so the next
        // query tick picks the fresh id without a paint flash.
        const journalStore = useJournalStore.getState()
        journalStore.setJournals(fresh)
        if (journalStore.activeJournalId === createParams.journal_id) {
          journalStore.setActiveJournalId(firstId)
        }
        emitJournalsChanged()
        entry = await tauriCreateEntry({ ...createParams, journal_id: firstId })
      } else {
        throw err
      }
    }
    emitStreakRefresh()
    // emitEntriesChanged() is bridged at the app level to
    // queryClient.invalidateQueries({ queryKey: ['entries'] }) — no explicit
    // invalidate needed here.
    emitEntriesChanged()

    // Best-effort: apply default location when the feature is enabled and
    // a valid coordinate pair is stored. Does not fail the entry creation.
    // The location patch will be visible on the next refetch.
    void (async () => {
      try {
        const [enabled, rawLat, rawLng, label, address] = await Promise.all([
          getSetting('default_location_enabled'),
          getSetting('default_location_lat'),
          getSetting('default_location_lng'),
          getSetting('default_location_label'),
          getSetting('default_location_address'),
        ])
        if (enabled !== 'true') return
        const lat = rawLat ? Number.parseFloat(rawLat) : NaN
        const lng = rawLng ? Number.parseFloat(rawLng) : NaN
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return
        await updateEntryLocation(entry.id, lat, lng, label ?? null, address ?? null)
        await applyEntryWeather(entry.id, lat, lng, entry.entry_date)
      } catch {
        // Silently ignore — default location is a convenience feature
      }
    })()

    return entry
  }

  const updateEntry = async (
    id: string,
    title?: string,
    contentText?: string,
    previewText?: string,
  ): Promise<Entry> => {
    const entry = await tauriUpdateEntry(id, title, contentText, previewText)
    // No invalidate: text updates don't reorder the list under any of our sort modes.
    // (recentlyEdited would, but we accept the small drift to avoid a refetch storm during typing.)
    return entry
  }

  const deleteEntry = async (id: string): Promise<void> => {
    await softDeleteEntry(id)
    emitStreakRefresh()
    // emitEntriesChanged() triggers the bridge → invalidateQueries(['entries']).
    emitEntriesChanged()
    // Soft-delete cascades to media rows — invalidate the gallery cache too.
    emitMediaChanged()
  }

  const toggleFavorite = async (id: string): Promise<boolean> => {
    const newValue = await tauriToggleFavorite(id)
    // Asymmetric handling:
    // • Un-favoriting on a favorites-only view removes the entry from the list
    //   entirely, so a full invalidate (refetch) is required.
    // • On any other view, flip the star icon in-place on lists that already
    //   contain the entry (All Entries, journal, tag, etc.) — no refetch needed
    //   for the *current* view.
    // • Favorites is a separate filtered query: favoriting from All Entries must
    //   refetch favorites caches so the entry appears there; unfavoriting from
    //   elsewhere must refetch favorites so the entry is removed. Patching
    //   is_favorite on a favorites-cache row is not enough — the row may be absent
    //   (new favorite) or must drop out of the filtered list (unfavorite).
    if (favoritesOnly && newValue === false) {
      await invalidate()
    } else {
      queryClient.setQueriesData<PagedResult<Entry>>({ queryKey: ['entries'] }, (prev) => {
        if (!prev) return prev
        let changed = false
        const items = prev.items.map((entry) => {
          if (entry.id !== id) return entry
          changed = true
          return { ...entry, is_favorite: newValue }
        })
        return changed ? { ...prev, items } : prev
      })
      await queryClient.invalidateQueries({
        queryKey: ['entries'],
        predicate: (query) => {
          const filters = query.queryKey[1] as { favoritesOnly?: boolean } | undefined
          return filters?.favoritesOnly === true
        },
      })
    }
    return newValue
  }

  const total = query.data?.total ?? 0

  return {
    entries: query.data?.items ?? [],
    total,
    totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    page,
    setPage: (n: number) => setPageFor(viewKey, Math.max(1, n)),
    isLoading: query.isPending,
    error: query.error ? String(query.error) : null,
    createEntry,
    updateEntry,
    deleteEntry,
    toggleFavorite,
  }
}
