import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useRecentEntries } from './useRecentEntries'
import { useInvisibleLockStore } from '../stores/invisibleLockStore'
import { useSecondLockStore } from '../stores/secondLockStore'
import type { Entry } from '../types/entry'
import type { PagedResult } from '../types/pagination'

vi.mock('../lib/tauri', () => ({
  listAllEntriesPaged: vi.fn(),
}))

import * as tauri from '../lib/tauri'

const makeEntry = (overrides: Partial<Entry> = {}): Entry => ({
  id: 'entry-1',
  journal_id: 'journal-1',
  title: 'Test Entry',
  preview_text: null,
  content_text: null,
  entry_date: 1_686_830_400,
  created_at: 1_686_830_400,
  updated_at: 1_686_830_400,
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
  media_count: 0,
  from_chat: false,
  content_language: null,
  entry_date_user_edited: false,
  ...overrides,
})

const makePagedResult = (entries: Entry[], total?: number): PagedResult<Entry> => ({
  items: entries,
  total: total ?? entries.length,
})

beforeEach(() => {
  vi.resetAllMocks()
  useInvisibleLockStore.setState({ activeVaultId: null })
  useSecondLockStore.setState({ isEnabled: false, isSessionUnlocked: false, showExistence: false })
})

describe('useRecentEntries', () => {
  it('requests page 1 with default lock args and slices to the limit', async () => {
    const items = Array.from({ length: 8 }, (_, i) => makeEntry({ id: `entry-${i}` }))
    vi.mocked(tauri.listAllEntriesPaged).mockResolvedValue(makePagedResult(items))

    const { result } = renderHook(() => useRecentEntries(3))
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(tauri.listAllEntriesPaged).toHaveBeenCalledWith(
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
    expect(result.current.entries).toHaveLength(3)
    expect(result.current.entries.map((entry) => entry.id)).toEqual([
      'entry-0',
      'entry-1',
      'entry-2',
    ])
    expect(result.current.error).toBeNull()
  })

  it('returns at most the default limit of 3', async () => {
    const items = Array.from({ length: 8 }, (_, i) => makeEntry({ id: `entry-${i}` }))
    vi.mocked(tauri.listAllEntriesPaged).mockResolvedValue(makePagedResult(items))

    const { result } = renderHook(() => useRecentEntries())
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(result.current.entries).toHaveLength(3)
  })

  it('passes lockedView and activeVaultId from the lock stores', async () => {
    useInvisibleLockStore.setState({ activeVaultId: 'vault-1' })
    useSecondLockStore.setState({ isEnabled: true, isSessionUnlocked: false, showExistence: false })
    vi.mocked(tauri.listAllEntriesPaged).mockResolvedValue(makePagedResult([]))

    const { result } = renderHook(() => useRecentEntries())
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(tauri.listAllEntriesPaged).toHaveBeenCalledWith(
      'newest',
      'all',
      null,
      null,
      1,
      1,
      'hidden',
      'vault-1',
      'all',
    )
  })

  it('refetches on memlore:entries-changed', async () => {
    vi.mocked(tauri.listAllEntriesPaged)
      .mockResolvedValueOnce(makePagedResult([makeEntry({ id: 'old' })]))
      .mockResolvedValueOnce(makePagedResult([makeEntry({ id: 'new' })]))

    const { result } = renderHook(() => useRecentEntries())
    await waitFor(() => {
      expect(result.current.entries.map((entry) => entry.id)).toEqual(['old'])
    })

    act(() => {
      window.dispatchEvent(new CustomEvent('memlore:entries-changed'))
    })

    await waitFor(() => {
      expect(result.current.entries.map((entry) => entry.id)).toEqual(['new'])
    })
    expect(tauri.listAllEntriesPaged).toHaveBeenCalledTimes(2)
  })

  it('ignores stale responses after unmount', async () => {
    let resolveFetch: (value: PagedResult<Entry>) => void = () => undefined
    vi.mocked(tauri.listAllEntriesPaged).mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve
      }),
    )

    const { result, unmount } = renderHook(() => useRecentEntries())
    expect(result.current.entries).toEqual([])
    unmount()

    await act(async () => {
      resolveFetch(makePagedResult([makeEntry()]))
      await Promise.resolve()
    })

    expect(result.current.entries).toEqual([])
  })

  it('captures error and clears entries when the fetch rejects', async () => {
    vi.mocked(tauri.listAllEntriesPaged).mockRejectedValue(new Error('locked'))

    const { result } = renderHook(() => useRecentEntries())
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(result.current.error).toBe('locked')
    expect(result.current.entries).toEqual([])
  })
})
