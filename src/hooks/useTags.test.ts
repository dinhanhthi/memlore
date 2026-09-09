import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import type { Tag } from '../types/journal'
import { useInvisibleLockStore } from '../stores/invisibleLockStore'

vi.mock('../lib/tauri', () => ({
  listTags: vi.fn().mockResolvedValue([]),
  createTag: vi.fn(),
  deleteTag: vi.fn(),
  updateTag: vi.fn(),
  getTagsWithCounts: vi.fn().mockResolvedValue([]),
}))

import * as tauri from '../lib/tauri'
import { useTags } from './useTags'

const mockTag: Tag = { id: 'tag-1', name: 'work', color: '#8B5CF6' }
const mockTag2: Tag = { id: 'tag-2', name: 'personal', color: '#10B981' }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(tauri.getTagsWithCounts).mockResolvedValue([])
  useInvisibleLockStore.setState({ activeVaultId: null })
})

describe('useTags', () => {
  it('fetches tagsWithCounts on mount and derives sorted `tags` from it', async () => {
    vi.mocked(tauri.getTagsWithCounts).mockResolvedValue([
      [mockTag2, 1],
      [mockTag, 3],
    ])

    const { result } = renderHook(() => useTags())

    await waitFor(() => expect(result.current.isLoading).toBe(false))

    expect(result.current.tagsWithCounts).toEqual([
      [mockTag2, 1],
      [mockTag, 3],
    ])
    expect(result.current.tags.map((tag) => tag.id)).toEqual([mockTag2.id, mockTag.id])
  })

  it('does NOT call listTags (single source of truth = getTagsWithCounts)', async () => {
    // Regression guard: previous version dual-fetched, wasting an IPC round-trip.
    vi.mocked(tauri.getTagsWithCounts).mockResolvedValue([[mockTag, 1]])
    const { result } = renderHook(() => useTags())
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(tauri.listTags).not.toHaveBeenCalled()
  })

  it('starts with isLoading true', () => {
    vi.mocked(tauri.getTagsWithCounts).mockReturnValue(new Promise(() => {}))

    const { result } = renderHook(() => useTags())
    expect(result.current.isLoading).toBe(true)
  })

  it('sets error state when fetch fails', async () => {
    vi.mocked(tauri.getTagsWithCounts).mockRejectedValue(new Error('DB error'))

    const { result } = renderHook(() => useTags())

    await waitFor(() => expect(result.current.isLoading).toBe(false))

    expect(result.current.error).toBeTruthy()
  })

  it('refresh re-fetches tagsWithCounts', async () => {
    vi.mocked(tauri.getTagsWithCounts).mockResolvedValue([[mockTag, 1]])

    const { result } = renderHook(() => useTags())
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    vi.mocked(tauri.getTagsWithCounts).mockResolvedValue([
      [mockTag, 1],
      [mockTag2, 0],
    ])

    await act(async () => {
      await result.current.refresh()
    })

    expect(result.current.tagsWithCounts).toHaveLength(2)
    expect(result.current.tags).toHaveLength(2)
  })

  it('createTag upserts locally and emits tags-changed', async () => {
    vi.mocked(tauri.getTagsWithCounts)
      .mockResolvedValueOnce([])
      .mockResolvedValue([[mockTag, 0]])
    vi.mocked(tauri.createTag).mockResolvedValue(mockTag)
    const { result } = renderHook(() => useTags())
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    await act(async () => {
      await result.current.createTag('work', '#8B5CF6')
    })

    await waitFor(() => expect(result.current.tags).toEqual([mockTag]))

    expect(tauri.createTag).toHaveBeenCalledWith('work', '#8B5CF6')
    expect(result.current.tagsWithCounts).toEqual([[mockTag, 0]])
    // Refetch fired via the tags-changed event listener (1 mount + 1 event)
    expect(tauri.getTagsWithCounts).toHaveBeenCalledTimes(2)
  })

  it('deleteTag calls tauri deleteTag and emits tags-changed', async () => {
    vi.mocked(tauri.deleteTag).mockResolvedValue(undefined)
    const { result } = renderHook(() => useTags())
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    await act(async () => {
      await result.current.deleteTag('tag-1')
    })

    expect(tauri.deleteTag).toHaveBeenCalledWith('tag-1')
    expect(tauri.getTagsWithCounts).toHaveBeenCalledTimes(2)
  })

  it('refetches on memlore:tags-changed custom event', async () => {
    const { result } = renderHook(() => useTags())
    await waitFor(() => expect(tauri.getTagsWithCounts).toHaveBeenCalledTimes(1))

    act(() => {
      window.dispatchEvent(new CustomEvent('memlore:tags-changed'))
    })

    await waitFor(() => expect(tauri.getTagsWithCounts).toHaveBeenCalledTimes(2))
    expect(result.current.error).toBeNull()
  })

  it('refetches on memlore:entries-changed (counts depend on entries)', async () => {
    renderHook(() => useTags())
    await waitFor(() => expect(tauri.getTagsWithCounts).toHaveBeenCalledTimes(1))

    act(() => {
      window.dispatchEvent(new CustomEvent('memlore:entries-changed'))
    })

    await waitFor(() => expect(tauri.getTagsWithCounts).toHaveBeenCalledTimes(2))
  })

  it('removes event listeners on unmount', async () => {
    const { unmount } = renderHook(() => useTags())
    await waitFor(() => expect(tauri.getTagsWithCounts).toHaveBeenCalledTimes(1))

    unmount()
    act(() => {
      window.dispatchEvent(new CustomEvent('memlore:tags-changed'))
      window.dispatchEvent(new CustomEvent('memlore:entries-changed'))
    })
    await new Promise((r) => setTimeout(r, 10))
    expect(tauri.getTagsWithCounts).toHaveBeenCalledTimes(1)
  })

  it('error is null when fetch succeeds', async () => {
    vi.mocked(tauri.getTagsWithCounts).mockResolvedValue([[mockTag, 5]])

    const { result } = renderHook(() => useTags())
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    expect(result.current.error).toBeNull()
  })

  it('passes the active vault id through to getTagsWithCounts', async () => {
    useInvisibleLockStore.setState({ activeVaultId: 'vault-a' })

    const { result } = renderHook(() => useTags())
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    expect(tauri.getTagsWithCounts).toHaveBeenCalledWith('vault-a')
  })

  it('refetches with the new vault id when the active vault changes', async () => {
    renderHook(() => useTags())
    await waitFor(() => expect(tauri.getTagsWithCounts).toHaveBeenCalledTimes(1))
    expect(tauri.getTagsWithCounts).toHaveBeenLastCalledWith(null)

    act(() => useInvisibleLockStore.setState({ activeVaultId: 'vault-b' }))

    await waitFor(() => expect(tauri.getTagsWithCounts).toHaveBeenCalledTimes(2))
    expect(tauri.getTagsWithCounts).toHaveBeenLastCalledWith('vault-b')
  })

  it('clears the vault-scoped list synchronously when the active vault changes', async () => {
    // Privacy guard: the vault-inclusive list must not survive a lock while
    // the post-lock refetch is still in flight.
    useInvisibleLockStore.setState({ activeVaultId: 'vault-a' })
    vi.mocked(tauri.getTagsWithCounts).mockResolvedValue([[mockTag, 1]])

    const { result } = renderHook(() => useTags())
    await waitFor(() => expect(result.current.tagsWithCounts).toEqual([[mockTag, 1]]))

    vi.mocked(tauri.getTagsWithCounts).mockReturnValue(new Promise(() => {}))
    act(() => useInvisibleLockStore.setState({ activeVaultId: null }))

    expect(result.current.tagsWithCounts).toEqual([])
  })

  it('clears the list when a refetch fails instead of keeping stale tags', async () => {
    // Privacy guard: a failed refetch after locking must not leave the
    // vault-inclusive list in state — most consumers never check `error`.
    vi.mocked(tauri.getTagsWithCounts).mockResolvedValue([[mockTag, 1]])

    const { result } = renderHook(() => useTags())
    await waitFor(() => expect(result.current.tagsWithCounts).toEqual([[mockTag, 1]]))

    vi.mocked(tauri.getTagsWithCounts).mockRejectedValue(new Error('DB error'))
    act(() => {
      window.dispatchEvent(new CustomEvent('memlore:tags-changed'))
    })

    await waitFor(() => expect(result.current.error).toBeTruthy())
    expect(result.current.tagsWithCounts).toEqual([])
  })
})
