import { renderHook, waitFor, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  useStats,
  __clearStatsCache,
  dropStatsCaches,
  hasCachedStats,
  invalidateStatsCache,
} from './useStats'

const makeFetcher = <T>(result: T) => vi.fn(async () => result)
const makeFailingFetcher = (msg: string) =>
  vi.fn(async () => {
    throw new Error(msg)
  })

beforeEach(() => {
  vi.clearAllMocks()
  __clearStatsCache()
})

describe('useStats', () => {
  it('starts in loading state', () => {
    const fetcher = vi.fn(() => new Promise<never>(() => {}))
    const { result } = renderHook(() => useStats(fetcher, 'key-1'))
    expect(result.current.isLoading).toBe(true)
    expect(result.current.data).toBeNull()
    expect(result.current.error).toBeNull()
  })

  it('returns data on successful fetch', async () => {
    const mockData = [{ period_start: '2026-01-01', count: 5 }]
    const { result } = renderHook(() => useStats(makeFetcher(mockData), 'key-2'))
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.data).toEqual(mockData)
    expect(result.current.error).toBeNull()
  })

  it('sets error state on rejection', async () => {
    const { result } = renderHook(() => useStats(makeFailingFetcher('Stats query failed'), 'key-3'))
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.error).toBe('Stats query failed')
    expect(result.current.data).toBeNull()
  })

  it('returns cached data on second mount with same key (no second fetch)', async () => {
    const mockData = [{ period_start: '2026-01-01', count: 3 }]
    const fetcher = makeFetcher(mockData)

    const { result: r1, unmount } = renderHook(() => useStats(fetcher, 'key-4'))
    await waitFor(() => expect(r1.current.isLoading).toBe(false))
    expect(fetcher).toHaveBeenCalledTimes(1)
    unmount()

    const fetcher2 = makeFetcher(mockData)
    const { result: r2 } = renderHook(() => useStats(fetcher2, 'key-4'))
    await waitFor(() => expect(r2.current.isLoading).toBe(false))
    expect(fetcher2).not.toHaveBeenCalled()
    expect(r2.current.data).toEqual(mockData)
  })

  // `ChartsGate` reads these two properties before rendering: a warm key opens
  // the gate with no loading frame, and a failed fetch must NOT look warm.
  it('reports a key as cached only after a successful fetch', async () => {
    expect(hasCachedStats('key-cached')).toBe(false)

    const { result } = renderHook(() => useStats(makeFetcher([1, 2, 3]), 'key-cached'))
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(hasCachedStats('key-cached')).toBe(true)
  })

  it('caches a failed fetch as an error so remount does not refetch', async () => {
    const fetcher = makeFailingFetcher('boom')
    const { result, unmount } = renderHook(() => useStats(fetcher, 'key-failed'))
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.error).toBe('boom')
    // Error is settled (gate can stay closed) but is not a warm success.
    expect(hasCachedStats('key-failed')).toBe(false)
    unmount()

    const fetcher2 = makeFailingFetcher('boom-again')
    const { result: r2 } = renderHook(() => useStats(fetcher2, 'key-failed'))
    expect(r2.current.isLoading).toBe(false)
    expect(r2.current.error).toBe('boom')
    expect(fetcher2).not.toHaveBeenCalled()
  })

  it('invalidateStatsCache drops a warm key', async () => {
    const { result } = renderHook(() => useStats(makeFetcher([1]), 'key-invalidate'))
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(hasCachedStats('key-invalidate')).toBe(true)

    act(() => {
      invalidateStatsCache()
    })
    expect(hasCachedStats('key-invalidate')).toBe(false)
  })

  it('ignores an in-flight resolve after invalidateStatsCache', async () => {
    const resolvers: Array<(value: number[]) => void> = []
    const fetcher = vi.fn(
      () =>
        new Promise<number[]>((resolve) => {
          resolvers.push(resolve)
        }),
    )

    const { result } = renderHook(() => useStats(fetcher, 'key-inflight'))
    expect(result.current.isLoading).toBe(true)
    expect(resolvers).toHaveLength(1)

    act(() => {
      invalidateStatsCache()
    })

    await act(async () => {
      resolvers[0]([42])
    })

    expect(hasCachedStats('key-inflight')).toBe(false)
    expect(result.current.data).toBeNull()
  })

  it('dropStatsCaches drops a warm key without refetching a mounted hook', async () => {
    const fetcher = makeFetcher([1])
    const { result } = renderHook(() => useStats(fetcher, 'key-silent-drop'))
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(fetcher).toHaveBeenCalledTimes(1)

    act(() => {
      dropStatsCaches()
    })

    expect(hasCachedStats('key-silent-drop')).toBe(false)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(result.current.data).toEqual([1])
  })

  it('refetches a mounted hook after invalidateStatsCache', async () => {
    const fetcher = makeFetcher([{ n: 1 }])
    const { result } = renderHook(() => useStats(fetcher, 'key-refetch'))
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(fetcher).toHaveBeenCalledTimes(1)

    const fetcher2 = makeFetcher([{ n: 2 }])
    fetcher.mockImplementation(fetcher2)

    act(() => {
      invalidateStatsCache()
    })

    await waitFor(() => expect(result.current.data).toEqual([{ n: 2 }]))
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('calls fetcher again for a different cache key (cache miss)', async () => {
    const data1 = [{ period_start: '2026-01-01', count: 3 }]
    const data2 = [{ period_start: '2026-01-01', count: 10 }]

    const { result: r1, unmount } = renderHook(() => useStats(makeFetcher(data1), 'key-5a'))
    await waitFor(() => expect(r1.current.isLoading).toBe(false))
    unmount()

    const fetcher2 = makeFetcher(data2)
    const { result: r2 } = renderHook(() => useStats(fetcher2, 'key-5b'))
    await waitFor(() => expect(r2.current.isLoading).toBe(false))
    expect(fetcher2).toHaveBeenCalledTimes(1)
    expect(r2.current.data).toEqual(data2)
  })

  it('applies cached value synchronously when cacheKey changes mid-lifecycle', async () => {
    const dataA = [{ period_start: '2026-01-01', count: 3 }]
    const dataB = [{ period_start: '2026-02-01', count: 7 }]

    // Pre-populate cache for both keys
    const { unmount: u1 } = renderHook(() => useStats(makeFetcher(dataA), 'key-6a'))
    await waitFor(() => {})
    u1()

    const { unmount: u2 } = renderHook(() => useStats(makeFetcher(dataB), 'key-6b'))
    await waitFor(() => {})
    u2()

    // Now test a component that switches cacheKey mid-lifecycle
    let currentKey = 'key-6a'
    const fetcher = vi.fn(async () => dataA)
    const { result, rerender } = renderHook(() => useStats(fetcher, currentKey))
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.data).toEqual(dataA)

    // Switch to the pre-cached key — data should update synchronously
    currentKey = 'key-6b'
    act(() => {
      rerender()
    })

    expect(result.current.data).toEqual(dataB)
    expect(result.current.isLoading).toBe(false)
    // fetcher should not have been called for the cache-hit path
    expect(fetcher).toHaveBeenCalledTimes(0)
  })
})
