import { renderHook, act, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { EmotionKey } from '../types/entry'
import { hasCachedEntryEmotion, useEntryEmotionByDate } from './useEntryEmotionByDate'
import { useInvisibleLockStore } from '../stores/invisibleLockStore'
import { useSecondLockStore } from '../stores/secondLockStore'
import { __clearStatsCache, invalidateStatsCache } from './useStats'

vi.mock('../lib/tauri', () => ({
  getEmotionByDate: vi.fn(),
}))

import { getEmotionByDate } from '../lib/tauri'

const mockGetEmotionByDate = vi.mocked(getEmotionByDate)

beforeEach(() => {
  vi.clearAllMocks()
  __clearStatsCache()
  useSecondLockStore.setState({
    isEnabled: false,
    isSessionUnlocked: false,
    showExistence: false,
    autoLockMinutes: 5,
  })
  useInvisibleLockStore.setState({ activeVaultId: null, autoLockMinutes: 5 })
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('useEntryEmotionByDate', () => {
  it('calls getEmotionByDate with year and lock visibility on mount', async () => {
    mockGetEmotionByDate.mockResolvedValue([])
    renderHook(() => useEntryEmotionByDate(2026))
    await waitFor(() => {
      expect(mockGetEmotionByDate).toHaveBeenCalledWith(2026, 'revealed', null)
    })
  })

  it('returns a Map with ordered emotions per date from the API response', async () => {
    mockGetEmotionByDate.mockResolvedValue([
      ['2026-01-10', 'good'],
      ['2026-01-10', 'bad'],
      ['2026-03-05', 'neutral'],
    ])

    const { result } = renderHook(() => useEntryEmotionByDate(2026))

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(result.current.data.get('2026-01-10')).toEqual(['good', 'bad'])
    expect(result.current.data.get('2026-03-05')).toEqual(['neutral'])
    expect(result.current.data.size).toBe(2)
  })

  it('refetches when the year prop changes', async () => {
    mockGetEmotionByDate.mockResolvedValue([])

    const { result, rerender } = renderHook(({ year }) => useEntryEmotionByDate(year), {
      initialProps: { year: 2026 },
    })

    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(mockGetEmotionByDate).toHaveBeenCalledWith(2026, 'revealed', null)
    expect(mockGetEmotionByDate).toHaveBeenCalledTimes(1)

    rerender({ year: 2025 })

    await waitFor(() => expect(mockGetEmotionByDate).toHaveBeenCalledWith(2025, 'revealed', null))
    expect(mockGetEmotionByDate).toHaveBeenCalledTimes(2)
  })

  it('reuses the shared cache on a second mount with the same year and locks', async () => {
    mockGetEmotionByDate.mockResolvedValue([['2026-01-10', 'good']])

    const { result: r1, unmount } = renderHook(() => useEntryEmotionByDate(2026))
    await waitFor(() => expect(r1.current.isLoading).toBe(false))
    expect(mockGetEmotionByDate).toHaveBeenCalledTimes(1)
    unmount()

    const { result: r2 } = renderHook(() => useEntryEmotionByDate(2026))
    expect(r2.current.isLoading).toBe(false)
    expect(r2.current.data.get('2026-01-10')).toEqual(['good'])
    expect(mockGetEmotionByDate).toHaveBeenCalledTimes(1)
  })

  it('refetches after invalidateStatsCache (same path as stats)', async () => {
    mockGetEmotionByDate.mockResolvedValue([])

    const { result } = renderHook(() => useEntryEmotionByDate(2026))
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(mockGetEmotionByDate).toHaveBeenCalledTimes(1)

    mockGetEmotionByDate.mockResolvedValue([['2026-02-01', 'bad']])
    act(() => {
      invalidateStatsCache()
    })

    await waitFor(() => expect(result.current.data.get('2026-02-01')).toEqual(['bad']))
    expect(mockGetEmotionByDate).toHaveBeenCalledTimes(2)
  })

  it('sets error state on rejection', async () => {
    mockGetEmotionByDate.mockRejectedValue(new Error('DB error'))

    const { result } = renderHook(() => useEntryEmotionByDate(2026))

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(result.current.error).toBe('DB error')
    expect(result.current.data.size).toBe(0)
  })

  it('hasCachedEntryEmotion is false before success and after error; remount reuses the cached error', async () => {
    expect(hasCachedEntryEmotion(2026)).toBe(false)

    mockGetEmotionByDate.mockResolvedValue([['2026-01-10', 'good']])
    const { unmount: unmountOk } = renderHook(() => useEntryEmotionByDate(2026))
    await waitFor(() => expect(hasCachedEntryEmotion(2026)).toBe(true))
    unmountOk()

    mockGetEmotionByDate.mockRejectedValue(new Error('DB error'))
    const { result, unmount } = renderHook(() => useEntryEmotionByDate(2027))
    expect(hasCachedEntryEmotion(2027)).toBe(false)
    await waitFor(() => expect(result.current.error).toBe('DB error'))
    expect(hasCachedEntryEmotion(2027)).toBe(false)
    unmount()

    const fetcherCalls = mockGetEmotionByDate.mock.calls.length
    const { result: remount } = renderHook(() => useEntryEmotionByDate(2027))
    expect(remount.current.isLoading).toBe(false)
    expect(remount.current.error).toBe('DB error')
    expect(mockGetEmotionByDate).toHaveBeenCalledTimes(fetcherCalls)
  })

  it('lock-partition: flipping lockedView or vault misses the revealed cache', async () => {
    mockGetEmotionByDate.mockResolvedValue([['2026-01-10', 'good']])
    const { rerender } = renderHook(() => useEntryEmotionByDate(2026))
    await waitFor(() => expect(hasCachedEntryEmotion(2026)).toBe(true))

    act(() => {
      useSecondLockStore.setState({
        isEnabled: true,
        isSessionUnlocked: false,
        showExistence: false,
      })
    })
    rerender()
    expect(hasCachedEntryEmotion(2026)).toBe(false)
    await waitFor(() => expect(mockGetEmotionByDate).toHaveBeenCalledWith(2026, 'hidden', null))

    act(() => {
      useSecondLockStore.setState({
        isEnabled: false,
        isSessionUnlocked: false,
        showExistence: false,
      })
      useInvisibleLockStore.setState({ activeVaultId: 'vault-a' })
    })
    rerender()
    expect(hasCachedEntryEmotion(2026)).toBe(false)
    await waitFor(() =>
      expect(mockGetEmotionByDate).toHaveBeenCalledWith(2026, 'revealed', 'vault-a'),
    )
  })

  it('ignores an in-flight resolve after invalidate so emotionCache is not stale-written', async () => {
    const resolvers: Array<(value: Array<[string, EmotionKey]>) => void> = []
    mockGetEmotionByDate.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve)
        }),
    )

    renderHook(() => useEntryEmotionByDate(2026))
    await waitFor(() => expect(resolvers).toHaveLength(1))

    act(() => {
      invalidateStatsCache()
    })
    await waitFor(() => expect(resolvers).toHaveLength(2))

    await act(async () => {
      resolvers[0]([['2026-01-01', 'good']])
    })

    expect(hasCachedEntryEmotion(2026)).toBe(false)
  })

  it('does not refetch after unmount when the cache is invalidated', async () => {
    mockGetEmotionByDate.mockResolvedValue([])

    const { unmount } = renderHook(() => useEntryEmotionByDate(2026))

    await waitFor(() => {
      expect(mockGetEmotionByDate).toHaveBeenCalledTimes(1)
    })

    unmount()

    act(() => {
      invalidateStatsCache()
    })

    await new Promise((r) => setTimeout(r, 10))
    expect(mockGetEmotionByDate).toHaveBeenCalledTimes(1)
  })
})
