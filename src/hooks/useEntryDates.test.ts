import { renderHook, act, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useEntryDates } from './useEntryDates'

// Mock the tauri IPC layer — tests must never call a real backend.
vi.mock('../lib/tauri', () => ({
  listEntryDates: vi.fn(),
}))

import { listEntryDates } from '../lib/tauri'

const mockListEntryDates = vi.mocked(listEntryDates)

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('useEntryDates', () => {
  it('loads on mount and sets dates', async () => {
    const timestamps = [1_700_000_000, 1_600_000_000, 1_500_000_000]
    mockListEntryDates.mockResolvedValue(timestamps)

    const { result } = renderHook(() => useEntryDates('journal-1'))

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(result.current.dates).toEqual(timestamps)
    expect(result.current.error).toBeNull()
    expect(mockListEntryDates).toHaveBeenCalledWith('journal-1', 'revealed', null)
  })

  it('calls with null journalId when null is passed', async () => {
    mockListEntryDates.mockResolvedValue([])

    const { result } = renderHook(() => useEntryDates(null))

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(mockListEntryDates).toHaveBeenCalledWith(null, 'revealed', null)
  })

  it('re-fetches when journalId changes', async () => {
    const ts1 = [1_000_000]
    const ts2 = [2_000_000, 3_000_000]
    mockListEntryDates.mockResolvedValueOnce(ts1).mockResolvedValueOnce(ts2)

    const { result, rerender } = renderHook(({ jid }) => useEntryDates(jid), {
      initialProps: { jid: 'journal-1' as string | null },
    })

    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.dates).toEqual(ts1)
    expect(mockListEntryDates).toHaveBeenCalledTimes(1)

    rerender({ jid: 'journal-2' })

    await waitFor(() =>
      expect(mockListEntryDates).toHaveBeenCalledWith('journal-2', 'revealed', null),
    )
    await waitFor(() => expect(result.current.dates).toEqual(ts2))
    expect(mockListEntryDates).toHaveBeenCalledTimes(2)
  })

  it('refetch() triggers a new fetch', async () => {
    mockListEntryDates.mockResolvedValue([1_000_000])

    const { result } = renderHook(() => useEntryDates('journal-1'))

    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(mockListEntryDates).toHaveBeenCalledTimes(1)

    mockListEntryDates.mockResolvedValue([2_000_000])

    await act(async () => {
      await result.current.refetch()
    })

    expect(mockListEntryDates).toHaveBeenCalledTimes(2)
    expect(result.current.dates).toEqual([2_000_000])
  })

  it('ignores stale response when journalId changes mid-fetch', async () => {
    // First fetch: journal-1 — resolves slowly
    let resolveFirst!: (v: number[]) => void
    const firstPromise = new Promise<number[]>((res) => {
      resolveFirst = res
    })

    // Second fetch: journal-2 — resolves immediately
    const secondDates = [9_999_999]
    mockListEntryDates.mockReturnValueOnce(firstPromise).mockResolvedValueOnce(secondDates)

    const { result, rerender } = renderHook(({ jid }) => useEntryDates(jid), {
      initialProps: { jid: 'journal-1' as string | null },
    })

    // Trigger journal-2 fetch while journal-1 is still in flight
    rerender({ jid: 'journal-2' })

    // Wait for the second (journal-2) fetch to settle
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.dates).toEqual(secondDates)

    // Resolve the stale first fetch — it should be ignored
    act(() => {
      resolveFirst([1_111_111])
    })

    // Dates should still be journal-2's result
    await new Promise((r) => setTimeout(r, 10))
    expect(result.current.dates).toEqual(secondDates)
  })

  it('sets error state on rejection and keeps previous dates', async () => {
    const initialDates = [1_000_000]
    mockListEntryDates.mockResolvedValueOnce(initialDates)

    const { result } = renderHook(() => useEntryDates('journal-1'))

    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.dates).toEqual(initialDates)

    mockListEntryDates.mockRejectedValue(new Error('DB error'))

    await act(async () => {
      await result.current.refetch()
    })

    expect(result.current.error).toBe('DB error')
    // Previous dates are kept on error
    expect(result.current.dates).toEqual(initialDates)
    expect(result.current.isLoading).toBe(false)
  })
})
