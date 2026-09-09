import { describe, it, expect, beforeEach, vi } from 'vitest'
import React from 'react'
import { renderHook, waitFor, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { PropsWithChildren } from 'react'
import { useAllMedia } from './useAllMedia'
import { useTabStore, makeDefaultTab } from '../stores/tabStore'
import { useUiStore } from '../stores/uiStore'
import type { GalleryMediaRow } from '../lib/tauri'
import type { PagedResult } from '../types/pagination'

vi.mock('../lib/tauri', () => ({
  listAllMediaPaged: vi.fn(),
}))

import * as tauri from '../lib/tauri'

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

const makeRow = (overrides: Partial<GalleryMediaRow> = {}): GalleryMediaRow => ({
  id: 'm-1',
  entryId: 'e-1',
  journalId: 'j-1',
  fileType: 'image/png',
  storagePath: '/local/m-1.png',
  thumbnailPath: null,
  cloudPath: null,
  uploadStatus: 'pending',
  createdAt: 1_700_000_000,
  entryDate: 1_700_000_000,
  durationSeconds: null,
  entryTitle: '',
  entryPreview: '',
  ...overrides,
})

const makePagedResult = (
  rows: GalleryMediaRow[],
  total?: number,
): PagedResult<GalleryMediaRow> => ({
  items: rows,
  total: total ?? rows.length,
})

function seedActiveTab() {
  const tab = makeDefaultTab()
  useTabStore.setState({ tabs: [tab], activeTabId: tab.id })
  return tab
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(tauri.listAllMediaPaged).mockResolvedValue(makePagedResult([]))
  seedActiveTab()
  // uiStore is persisted/module-level — pin the default so page-size tests
  // don't leak into each other.
  useUiStore.setState({ mediaPageSize: 20 })
})

describe('useAllMedia', () => {
  // 1. Initial load returns { media, total, totalPages, page=1, isLoading=false }
  it('returns page 1 with items and total after initial load', async () => {
    const rows = [makeRow({ id: 'm-1' }), makeRow({ id: 'm-2' })]
    vi.mocked(tauri.listAllMediaPaged).mockResolvedValue(makePagedResult(rows, 42))

    const { result } = renderHook(() => useAllMedia(), { wrapper: createWrapper() })
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    expect(result.current.media).toHaveLength(2)
    expect(result.current.total).toBe(42)
    expect(result.current.totalPages).toBe(3) // ceil(42/20) = 3
    expect(result.current.page).toBe(1)
    expect(result.current.error).toBeNull()
    expect(tauri.listAllMediaPaged).toHaveBeenCalledWith(null, 1, 'revealed', null, 20)
  })

  // 2. kind change resets page to 1 and refetches with new kind
  it('resets page to 1 and refetches with new kind when kind changes', async () => {
    vi.mocked(tauri.listAllMediaPaged).mockResolvedValue(makePagedResult([makeRow()], 1))

    const { result, rerender } = renderHook(
      ({ kind }: { kind?: 'image' | 'video' | 'audio' | null }) => useAllMedia({ kind }),
      {
        initialProps: { kind: null as 'image' | 'video' | 'audio' | null },
        wrapper: createWrapper(),
      },
    )
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    rerender({ kind: 'image' })
    await waitFor(() => {
      expect(tauri.listAllMediaPaged).toHaveBeenLastCalledWith('image', 1, 'revealed', null, 20)
    })
    expect(result.current.page).toBe(1)
  })

  // 3. setPage(3) triggers refetch with page 3
  it('triggers a refetch with page 3 when setPage(3) is called', async () => {
    vi.mocked(tauri.listAllMediaPaged).mockResolvedValue(makePagedResult([], 100))

    const { result } = renderHook(() => useAllMedia(), { wrapper: createWrapper() })
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    act(() => {
      result.current.setPage(3)
    })

    await waitFor(() => {
      expect(tauri.listAllMediaPaged).toHaveBeenLastCalledWith(null, 3, 'revealed', null, 20)
    })
    expect(result.current.page).toBe(3)
  })

  // 4. invalidate() re-fetches the current page
  it('re-fetches the current page when invalidate() is called', async () => {
    vi.mocked(tauri.listAllMediaPaged).mockResolvedValue(makePagedResult([makeRow()], 1))

    const { result } = renderHook(() => useAllMedia(), { wrapper: createWrapper() })
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    const callsBefore = vi.mocked(tauri.listAllMediaPaged).mock.calls.length

    await act(async () => {
      await result.current.invalidate()
    })

    expect(tauri.listAllMediaPaged).toHaveBeenCalledTimes(callsBefore + 1)
    expect(tauri.listAllMediaPaged).toHaveBeenLastCalledWith(null, 1, 'revealed', null, 20)
  })

  // 5. setPage writes to tabStore under viewKey 'media'
  it('writes the new page to tabStore under viewKey "media"', async () => {
    vi.mocked(tauri.listAllMediaPaged).mockResolvedValue(makePagedResult([], 100))

    const { result } = renderHook(() => useAllMedia(), { wrapper: createWrapper() })
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    act(() => {
      result.current.setPage(2)
    })

    await waitFor(() => {
      const { tabs, activeTabId } = useTabStore.getState()
      const tab = tabs.find((t) => t.id === activeTabId)
      expect(tab?.pagination?.['media']).toBe(2)
    })
  })

  // 6. mediaPageSize flows into the fetch and the totalPages math
  it('passes mediaPageSize to the fetch and derives totalPages from it', async () => {
    useUiStore.setState({ mediaPageSize: 12 })
    vi.mocked(tauri.listAllMediaPaged).mockResolvedValue(makePagedResult([], 42))

    const { result } = renderHook(() => useAllMedia(), { wrapper: createWrapper() })
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    expect(tauri.listAllMediaPaged).toHaveBeenCalledWith(null, 1, 'revealed', null, 12)
    expect(result.current.totalPages).toBe(4) // ceil(42/12) = 4
  })

  // 7. Changing mediaPageSize mid-session resets page 3 → 1 (old page number
  //    is meaningless under a new page size) and refetches
  it('resets page to 1 and refetches when mediaPageSize changes', async () => {
    vi.mocked(tauri.listAllMediaPaged).mockResolvedValue(makePagedResult([], 100))

    const { result } = renderHook(() => useAllMedia(), { wrapper: createWrapper() })
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    act(() => {
      result.current.setPage(3)
    })
    await waitFor(() => expect(result.current.page).toBe(3))

    act(() => {
      useUiStore.getState().setMediaPageSize(40)
    })

    await waitFor(() => {
      expect(tauri.listAllMediaPaged).toHaveBeenLastCalledWith(null, 1, 'revealed', null, 40)
    })
    expect(result.current.page).toBe(1)
  })
})
