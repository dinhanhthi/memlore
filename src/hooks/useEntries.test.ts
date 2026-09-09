import { describe, it, expect, beforeEach, vi } from 'vitest'
import React from 'react'
import { renderHook, act, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { PropsWithChildren } from 'react'
import { useEntries } from './useEntries'
import { useTabStore, makeDefaultTab } from '../stores/tabStore'
import { useJournalStore } from '../stores/journalStore'
import type { Entry } from '../types/entry'
import type { PagedResult } from '../types/pagination'

// ---------------------------------------------------------------------------
// Mock all IPC wrappers used by useEntries
// ---------------------------------------------------------------------------
vi.mock('../lib/tauri', () => ({
  listEntriesPaged: vi.fn(),
  listAllEntriesPaged: vi.fn(),
  listFavoriteEntriesPaged: vi.fn(),
  listEntriesByTagPaged: vi.fn(),
  createEntry: vi.fn(),
  updateEntry: vi.fn(),
  softDeleteEntry: vi.fn(),
  toggleFavorite: vi.fn(),
  updateEntryLocation: vi.fn(),
  getSetting: vi.fn().mockResolvedValue(null),
  listJournals: vi.fn(),
}))

// Import after mock registration
import * as tauri from '../lib/tauri'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const makeEntry = (overrides: Partial<Entry> = {}): Entry => ({
  id: 'entry-1',
  journal_id: 'journal-1',
  title: 'Test Entry',
  preview_text: 'Preview',
  content_text: 'Full content',
  entry_date: 1744640400,
  created_at: 1744640400,
  updated_at: 1744640400,
  latitude: null,
  longitude: null,
  location_label: null,
  location_address: null,
  weather_summary: null,
  weather_icon: null,
  emotion: null,
  is_favorite: false,
  is_deleted: false,
  is_locked: false,
  is_invisible: false,
  vault_id: null,
  cover_media_id: null,
  content_language: null,
  entry_date_user_edited: false,
  media_count: 0,
  from_chat: false,
  ...overrides,
})

const makePagedResult = (entries: Entry[], total?: number): PagedResult<Entry> => ({
  items: entries,
  total: total ?? entries.length,
})

/** Seed a real active tab so useSetPageFor / usePageFor resolve correctly. */
function seedActiveTab() {
  const tab = makeDefaultTab()
  useTabStore.setState({ tabs: [tab], activeTabId: tab.id })
  return tab
}

/**
 * Create a fresh QueryClientProvider wrapper per test.
 * A fresh client per test prevents cross-test cache leakage.
 */
function createWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  })
  return ({ children }: PropsWithChildren) =>
    React.createElement(QueryClientProvider, { client }, children)
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
beforeEach(() => {
  vi.resetAllMocks()
  // Default: all paged fetchers return empty result
  vi.mocked(tauri.listAllEntriesPaged).mockResolvedValue(makePagedResult([]))
  vi.mocked(tauri.listEntriesPaged).mockResolvedValue(makePagedResult([]))
  vi.mocked(tauri.listFavoriteEntriesPaged).mockResolvedValue(makePagedResult([]))
  vi.mocked(tauri.listEntriesByTagPaged).mockResolvedValue(makePagedResult([]))
  vi.mocked(tauri.getSetting).mockResolvedValue(null)
  // Reset Zustand state so the self-heal test's pre-seed doesn't leak into
  // subsequent tests.
  useJournalStore.setState({ journals: [], activeJournalId: null })
  seedActiveTab()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('useEntries', () => {
  // 1. Initial state then populates
  it('returns empty entries initially then populates after fetch', async () => {
    vi.mocked(tauri.listAllEntriesPaged).mockResolvedValue(makePagedResult([makeEntry()], 1))

    const { result } = renderHook(() => useEntries(), { wrapper: createWrapper() })

    // After mount and fetch resolves
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    expect(result.current.entries).toHaveLength(1)
    expect(result.current.total).toBe(1)
    expect(result.current.totalPages).toBe(1)
    expect(result.current.page).toBe(1)
    expect(result.current.error).toBeNull()
  })

  // 2. journalId calls listEntriesPaged
  it('calls listEntriesPaged when journalId is provided', async () => {
    vi.mocked(tauri.listEntriesPaged).mockResolvedValue(makePagedResult([makeEntry()], 1))

    const { result } = renderHook(() => useEntries({ journalId: 'journal-1' }), {
      wrapper: createWrapper(),
    })

    await waitFor(() => expect(result.current.isLoading).toBe(false))

    expect(tauri.listEntriesPaged).toHaveBeenCalledWith(
      'journal-1',
      'newest',
      'all',
      null,
      null,
      1,
      1,
      'revealed',
      null,
      'all',
    )
    expect(tauri.listAllEntriesPaged).not.toHaveBeenCalled()
    expect(result.current.entries).toHaveLength(1)
  })

  // 3. favoritesOnly + journalId calls listFavoriteEntriesPaged with journalId
  it('calls listFavoriteEntriesPaged with journalId when favoritesOnly and journalId are set', async () => {
    vi.mocked(tauri.listFavoriteEntriesPaged).mockResolvedValue(
      makePagedResult([makeEntry({ is_favorite: true })], 1),
    )

    const { result } = renderHook(() => useEntries({ favoritesOnly: true, journalId: 'j1' }), {
      wrapper: createWrapper(),
    })

    await waitFor(() => expect(result.current.isLoading).toBe(false))

    expect(tauri.listFavoriteEntriesPaged).toHaveBeenCalledWith(
      'j1',
      'newest',
      'all',
      null,
      null,
      1,
      1,
      'revealed',
      null,
      'all',
    )
    expect(result.current.entries).toHaveLength(1)
  })

  // 4. favoritesOnly + journalId=null calls listFavoriteEntriesPaged with null
  it('calls listFavoriteEntriesPaged with null when favoritesOnly and journalId is null', async () => {
    vi.mocked(tauri.listFavoriteEntriesPaged).mockResolvedValue(makePagedResult([], 0))

    const { result } = renderHook(() => useEntries({ favoritesOnly: true, journalId: null }), {
      wrapper: createWrapper(),
    })

    await waitFor(() => expect(result.current.isLoading).toBe(false))

    expect(tauri.listFavoriteEntriesPaged).toHaveBeenCalledWith(
      null,
      'newest',
      'all',
      null,
      null,
      1,
      1,
      'revealed',
      null,
      'all',
    )
  })

  // 5. tagId calls listEntriesByTagPaged
  it('calls listEntriesByTagPaged when tagId is provided', async () => {
    vi.mocked(tauri.listEntriesByTagPaged).mockResolvedValue(makePagedResult([makeEntry()], 1))

    const { result } = renderHook(() => useEntries({ tagId: 'tag-abc' }), {
      wrapper: createWrapper(),
    })

    await waitFor(() => expect(result.current.isLoading).toBe(false))

    expect(tauri.listEntriesByTagPaged).toHaveBeenCalledWith(
      'tag-abc',
      null,
      false,
      'newest',
      'all',
      null,
      null,
      1,
      1,
      'revealed',
      null,
      'all',
    )
    expect(tauri.listEntriesPaged).not.toHaveBeenCalled()
    expect(tauri.listAllEntriesPaged).not.toHaveBeenCalled()
  })

  it('passes journalId through to listEntriesByTagPaged when tag and journal filters are both set', async () => {
    vi.mocked(tauri.listEntriesByTagPaged).mockResolvedValue(makePagedResult([makeEntry()], 1))

    const { result } = renderHook(() => useEntries({ tagId: 'tag-abc', journalId: 'journal-2' }), {
      wrapper: createWrapper(),
    })

    await waitFor(() => expect(result.current.isLoading).toBe(false))

    expect(tauri.listEntriesByTagPaged).toHaveBeenCalledWith(
      'tag-abc',
      'journal-2',
      false,
      'newest',
      'all',
      null,
      null,
      1,
      1,
      'revealed',
      null,
      'all',
    )
  })

  it('passes favoritesOnly through to listEntriesByTagPaged when tag and starred filters are both set', async () => {
    vi.mocked(tauri.listEntriesByTagPaged).mockResolvedValue(makePagedResult([makeEntry()], 1))

    const { result } = renderHook(() => useEntries({ tagId: 'tag-abc', favoritesOnly: true }), {
      wrapper: createWrapper(),
    })

    await waitFor(() => expect(result.current.isLoading).toBe(false))

    expect(tauri.listEntriesByTagPaged).toHaveBeenCalledWith(
      'tag-abc',
      null,
      true,
      'newest',
      'all',
      null,
      null,
      1,
      1,
      'revealed',
      null,
      'all',
    )
    expect(tauri.listFavoriteEntriesPaged).not.toHaveBeenCalled()
  })

  // 5b. createEntry self-heals stale journal id
  it('createEntry retries with a refreshed journal id when backend returns JOURNAL_NOT_FOUND', async () => {
    vi.mocked(tauri.listAllEntriesPaged).mockResolvedValue(makePagedResult([]))
    const newEntry = makeEntry({ id: 'recovered-entry', journal_id: 'fresh-journal' })
    // First call fails with the typed error; second call (after refetch) succeeds.
    vi.mocked(tauri.createEntry)
      .mockRejectedValueOnce(new Error('JOURNAL_NOT_FOUND: no journal with id stale-journal'))
      .mockResolvedValueOnce(newEntry)
    vi.mocked(tauri.listJournals).mockResolvedValue([
      {
        id: 'fresh-journal',
        name: 'My Journal',
        color: '#4F46E5',
        sort_order: 0,
        created_at: 0,
        updated_at: 0,
        is_deleted: false,
        is_locked: false,
        is_invisible: false,
        vault_id: null,
        is_initial_placeholder: false,
      },
    ])

    // Pre-seed the Zustand store as if the UI had cached the stale id.
    useJournalStore.setState({
      journals: [
        {
          id: 'stale-journal',
          name: 'My Journal',
          color: '#4F46E5',
          sort_order: 0,
          created_at: 0,
          updated_at: 0,
          is_deleted: false,
          is_locked: false,
          is_invisible: false,
          vault_id: null,
          is_initial_placeholder: false,
        },
      ],
      activeJournalId: 'stale-journal',
    })

    const { result } = renderHook(() => useEntries(), { wrapper: createWrapper() })
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    let returned: Entry | undefined
    await act(async () => {
      returned = await result.current.createEntry({
        journal_id: 'stale-journal',
        entry_date: Date.now(),
      })
    })

    expect(tauri.createEntry).toHaveBeenCalledTimes(2)
    expect(tauri.listJournals).toHaveBeenCalledOnce()
    // First call used the stale id; second call swapped to the fresh id.
    expect(vi.mocked(tauri.createEntry).mock.calls[0][0].journal_id).toBe('stale-journal')
    expect(vi.mocked(tauri.createEntry).mock.calls[1][0].journal_id).toBe('fresh-journal')
    expect(returned?.id).toBe('recovered-entry')

    // The Zustand store is updated in-place so EntryList's listEntriesPaged
    // query (keyed on activeJournalId) refetches with the fresh id and the
    // newly-created entry actually shows up. Without this the entry exists
    // in the DB but the visible list stays empty.
    const store = useJournalStore.getState()
    expect(store.journals.map((j) => j.id)).toEqual(['fresh-journal'])
    expect(store.activeJournalId).toBe('fresh-journal')
  })

  // 6. createEntry fires IPC, window event, returns entry
  it('createEntry calls the IPC, fires memlore:entries-changed event, and returns the new entry', async () => {
    vi.mocked(tauri.listAllEntriesPaged).mockResolvedValue(makePagedResult([]))
    const newEntry = makeEntry({ id: 'new-entry' })
    vi.mocked(tauri.createEntry).mockResolvedValue(newEntry)

    const eventListener = vi.fn()
    window.addEventListener('memlore:entries-changed', eventListener)

    const { result } = renderHook(() => useEntries(), { wrapper: createWrapper() })
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    let returned: Entry | undefined
    await act(async () => {
      returned = await result.current.createEntry({
        journal_id: 'journal-1',
        entry_date: Date.now(),
      })
    })

    expect(tauri.createEntry).toHaveBeenCalledOnce()
    expect(eventListener).toHaveBeenCalledOnce()
    expect(returned?.id).toBe('new-entry')

    window.removeEventListener('memlore:entries-changed', eventListener)
  })

  // 7. deleteEntry calls IPC and fires event
  it('deleteEntry calls the IPC and fires memlore:entries-changed event', async () => {
    vi.mocked(tauri.listAllEntriesPaged).mockResolvedValue(
      makePagedResult([makeEntry({ id: 'e1' })], 1),
    )
    vi.mocked(tauri.softDeleteEntry).mockResolvedValue(undefined)

    const eventListener = vi.fn()
    window.addEventListener('memlore:entries-changed', eventListener)

    const { result } = renderHook(() => useEntries(), { wrapper: createWrapper() })
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    await act(async () => {
      await result.current.deleteEntry('e1')
    })

    expect(tauri.softDeleteEntry).toHaveBeenCalledWith('e1')
    expect(eventListener).toHaveBeenCalledOnce()

    window.removeEventListener('memlore:entries-changed', eventListener)
  })

  // 8. toggleFavorite on favoritesOnly view with result=false triggers invalidate (second fetch)
  it('toggleFavorite on favoritesOnly view when unfavoriting triggers a refetch', async () => {
    const favEntry = makeEntry({ id: 'e1', is_favorite: true })
    vi.mocked(tauri.listFavoriteEntriesPaged).mockResolvedValue(makePagedResult([favEntry], 1))
    vi.mocked(tauri.toggleFavorite).mockResolvedValue(false)

    const { result } = renderHook(() => useEntries({ favoritesOnly: true, journalId: null }), {
      wrapper: createWrapper(),
    })
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    // Fetcher called once on mount
    expect(tauri.listFavoriteEntriesPaged).toHaveBeenCalledTimes(1)

    await act(async () => {
      await result.current.toggleFavorite('e1')
    })

    // After invalidate, the fetcher should be called a second time
    await waitFor(() => expect(tauri.listFavoriteEntriesPaged).toHaveBeenCalledTimes(2))
  })

  // 9. setPage propagates to tabStore
  it('setPage propagates to tabStore', async () => {
    vi.mocked(tauri.listAllEntriesPaged).mockResolvedValue(makePagedResult([], 50))

    const { result } = renderHook(() => useEntries(), { wrapper: createWrapper() })
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    act(() => {
      result.current.setPage(2)
    })

    await waitFor(() => {
      const { tabs, activeTabId } = useTabStore.getState()
      const tab = tabs.find((t) => t.id === activeTabId)
      expect(tab?.pagination?.['all']).toBe(2)
    })
  })

  // 10. Fingerprint change (sort) resets page to 1
  it('changing sort resets page to 1 when already on page 2', async () => {
    vi.mocked(tauri.listAllEntriesPaged).mockResolvedValue(makePagedResult([], 50))

    const { result, rerender } = renderHook(
      ({ sort }: { sort: 'newest' | 'oldest' }) => useEntries({ sort }),
      { initialProps: { sort: 'newest' as 'newest' | 'oldest' }, wrapper: createWrapper() },
    )
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    // Advance to page 2
    act(() => {
      result.current.setPage(2)
    })

    await waitFor(() => expect(result.current.page).toBe(2))

    // Change sort — fingerprint changes — page should reset to 1
    rerender({ sort: 'oldest' })

    await waitFor(() => expect(result.current.page).toBe(1))
  })

  // 10b. Toggling favoritesOnly inside a tag-filtered view must not leave
  // page stuck on a page number that no longer exists in the narrowed
  // result set — regression guard for the tag+starred combo.
  it('toggling favoritesOnly while tagId is set resets page to 1 when already on page 2', async () => {
    vi.mocked(tauri.listEntriesByTagPaged).mockResolvedValue(makePagedResult([], 50))

    const { result, rerender } = renderHook(
      ({ favoritesOnly }: { favoritesOnly: boolean }) =>
        useEntries({ tagId: 'tag-abc', favoritesOnly }),
      { initialProps: { favoritesOnly: false }, wrapper: createWrapper() },
    )
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    act(() => {
      result.current.setPage(2)
    })
    await waitFor(() => expect(result.current.page).toBe(2))

    rerender({ favoritesOnly: true })

    await waitFor(() => expect(result.current.page).toBe(1))
  })

  // Additional: updateEntry calls IPC and returns the updated entry
  it('updateEntry calls the IPC and returns the updated entry', async () => {
    vi.mocked(tauri.listEntriesPaged).mockResolvedValue(
      makePagedResult([makeEntry({ id: 'e1' })], 1),
    )
    const updated = makeEntry({ id: 'e1', title: 'New Title' })
    vi.mocked(tauri.updateEntry).mockResolvedValue(updated)

    const { result } = renderHook(() => useEntries({ journalId: 'journal-1' }), {
      wrapper: createWrapper(),
    })
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    let returned: Entry | undefined
    await act(async () => {
      returned = await result.current.updateEntry('e1', 'New Title')
    })

    expect(tauri.updateEntry).toHaveBeenCalledWith('e1', 'New Title', undefined, undefined)
    expect(returned?.title).toBe('New Title')
  })

  // toggleFavorite on non-favorites view patches in place but refetches favorites caches
  it('toggleFavorite on a non-favorites view refetches favorites without refetching the current view', async () => {
    const entry = makeEntry({ id: 'e1', is_favorite: false })
    vi.mocked(tauri.listEntriesPaged).mockResolvedValue(makePagedResult([entry], 1))
    vi.mocked(tauri.listFavoriteEntriesPaged).mockResolvedValue(makePagedResult([], 0))
    vi.mocked(tauri.toggleFavorite).mockResolvedValue(true)

    const wrapper = createWrapper()
    const { result: allEntries } = renderHook(() => useEntries({ journalId: 'journal-1' }), {
      wrapper,
    })
    const { result: favorites } = renderHook(
      () => useEntries({ favoritesOnly: true, journalId: null }),
      { wrapper },
    )
    await waitFor(() => expect(allEntries.current.isLoading).toBe(false))
    await waitFor(() => expect(favorites.current.isLoading).toBe(false))

    const journalCallsBefore = vi.mocked(tauri.listEntriesPaged).mock.calls.length
    const favoritesCallsBefore = vi.mocked(tauri.listFavoriteEntriesPaged).mock.calls.length

    await act(async () => {
      await allEntries.current.toggleFavorite('e1')
    })

    // Current (journal) view: in-place patch only — no refetch
    expect(tauri.listEntriesPaged).toHaveBeenCalledTimes(journalCallsBefore)
    // Favorites view: must refetch so the newly favorited entry appears
    await waitFor(() =>
      expect(tauri.listFavoriteEntriesPaged).toHaveBeenCalledTimes(favoritesCallsBefore + 1),
    )
  })

  // custom-range plumbing: fromTs and toTs are threaded through to the fetcher
  it('passes fromTs and toTs through to the paged fetcher', async () => {
    vi.mocked(tauri.listAllEntriesPaged).mockResolvedValue(makePagedResult([makeEntry()], 1))

    const { result } = renderHook(() => useEntries({ fromTs: 1000, toTs: 2000 }), {
      wrapper: createWrapper(),
    })

    await waitFor(() => expect(result.current.isLoading).toBe(false))

    expect(tauri.listAllEntriesPaged).toHaveBeenCalledWith(
      'newest',
      'all',
      1000,
      2000,
      1,
      1,
      'revealed',
      null,
      'all',
    )
  })

  it('passes lockFilter through to the paged fetcher (non-default)', async () => {
    vi.mocked(tauri.listAllEntriesPaged).mockResolvedValue(makePagedResult([makeEntry()], 1))

    const { result } = renderHook(() => useEntries({ lockFilter: 'secondLocked' }), {
      wrapper: createWrapper(),
    })

    await waitFor(() => expect(result.current.isLoading).toBe(false))

    expect(tauri.listAllEntriesPaged).toHaveBeenCalledWith(
      'newest',
      'all',
      null,
      null,
      1,
      1,
      'revealed',
      null,
      'secondLocked',
    )
  })
})
