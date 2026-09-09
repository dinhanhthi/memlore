import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { useStreaks, emitStreakRefresh } from './useStreaks'
import type { StreakInfo } from '../lib/tauri'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

vi.mock('../lib/tauri', () => ({
  recalculateStreak: vi.fn(),
}))

import * as tauri from '../lib/tauri'

const makeStreak = (overrides: Partial<StreakInfo> = {}): StreakInfo => ({
  current_streak: 0,
  longest_streak: 0,
  last_entry_date: null,
  ...overrides,
})

beforeEach(() => {
  vi.resetAllMocks()
})

describe('useStreaks', () => {
  it('starts in loading state before data resolves', () => {
    vi.mocked(tauri.recalculateStreak).mockReturnValue(new Promise(() => {}))
    const { result } = renderHook(() => useStreaks())
    expect(result.current.isLoading).toBe(true)
    expect(result.current.streakInfo).toBeNull()
    expect(result.current.error).toBeNull()
  })

  it('returns streak info on successful fetch', async () => {
    const streak = makeStreak({ current_streak: 5, longest_streak: 10 })
    vi.mocked(tauri.recalculateStreak).mockResolvedValue(streak)

    const { result } = renderHook(() => useStreaks())

    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.streakInfo).toEqual(streak)
    expect(result.current.error).toBeNull()
  })

  it('sets error state on backend failure', async () => {
    vi.mocked(tauri.recalculateStreak).mockRejectedValue(new Error('db error'))

    const { result } = renderHook(() => useStreaks())

    await waitFor(() => expect(result.current.error).toBe('db error'))
    expect(result.current.isLoading).toBe(false)
    expect(result.current.streakInfo).toBeNull()
  })

  it('exposes a refresh function that calls recalculateStreak', async () => {
    const initial = makeStreak({ current_streak: 3 })
    const updated = makeStreak({ current_streak: 4 })
    vi.mocked(tauri.recalculateStreak).mockResolvedValueOnce(initial).mockResolvedValueOnce(updated)

    const { result } = renderHook(() => useStreaks())
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    await act(async () => {
      await result.current.refresh()
    })
    await waitFor(() => expect(result.current.streakInfo?.current_streak).toBe(4))
    expect(tauri.recalculateStreak).toHaveBeenCalledTimes(2)
  })

  it('calls recalculateStreak on mount for fresh data', async () => {
    vi.mocked(tauri.recalculateStreak).mockResolvedValue(makeStreak())

    renderHook(() => useStreaks())
    await waitFor(() => expect(tauri.recalculateStreak).toHaveBeenCalledTimes(1))
  })

  it('refreshes when streak-refresh event is dispatched', async () => {
    const initial = makeStreak({ current_streak: 0 })
    const updated = makeStreak({ current_streak: 1 })
    vi.mocked(tauri.recalculateStreak).mockResolvedValueOnce(initial).mockResolvedValueOnce(updated)

    const { result } = renderHook(() => useStreaks())
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    await act(async () => {
      emitStreakRefresh()
      await new Promise((r) => setTimeout(r, 10))
    })
    await waitFor(() => expect(result.current.streakInfo?.current_streak).toBe(1))
    expect(tauri.recalculateStreak).toHaveBeenCalledTimes(2)
  })
})
