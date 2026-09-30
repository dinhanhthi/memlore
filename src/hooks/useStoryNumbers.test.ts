import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useStoryNumbers } from './useStoryNumbers'
import { __clearStatsCache } from './useStats'
import type {
  EntriesOverTimePoint,
  MoodHistogramRow,
  StreakCalendarDay,
  StreakInfo,
  WritingHourRow,
  WritingVolumePoint,
} from '../lib/tauri'

vi.mock('../lib/tauri', () => ({
  statsEntriesOverTime: vi.fn(),
  statsWritingVolume: vi.fn(),
  statsMoodHistogram: vi.fn(),
  statsWritingHours: vi.fn(),
  statsStreakCalendar: vi.fn(),
}))

vi.mock('./useStreaks', () => ({
  useStreaks: vi.fn(),
}))

import * as tauri from '../lib/tauri'
import { useStreaks } from './useStreaks'

function settledStreak(info: StreakInfo | null = null) {
  vi.mocked(useStreaks).mockReturnValue({
    streakInfo: info,
    isLoading: false,
    error: null,
    refresh: vi.fn(),
  })
}

beforeEach(() => {
  vi.resetAllMocks()
  __clearStatsCache()
  vi.mocked(tauri.statsEntriesOverTime).mockResolvedValue([])
  vi.mocked(tauri.statsWritingVolume).mockResolvedValue([])
  vi.mocked(tauri.statsMoodHistogram).mockResolvedValue([])
  vi.mocked(tauri.statsWritingHours).mockResolvedValue([])
  vi.mocked(tauri.statsStreakCalendar).mockResolvedValue([])
  settledStreak(null)
})

describe('useStoryNumbers', () => {
  it('sums totals and keeps series in row order', async () => {
    const entries: EntriesOverTimePoint[] = [
      { period_start: '2026-01-01', count: 2 },
      { period_start: '2026-01-08', count: 5 },
      { period_start: '2026-01-15', count: 0 },
    ]
    const volume: WritingVolumePoint[] = [
      { period_start: '2026-01-01', total_words: 100, entry_count: 2 },
      { period_start: '2026-01-08', total_words: 40, entry_count: 5 },
    ]
    vi.mocked(tauri.statsEntriesOverTime).mockResolvedValue(entries)
    vi.mocked(tauri.statsWritingVolume).mockResolvedValue(volume)
    settledStreak({ current_streak: 4, longest_streak: 11, last_entry_date: null })

    const { result } = renderHook(() => useStoryNumbers('90d', 2026))
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    expect(result.current.entries).toEqual({ total: 7, series: [2, 5, 0] })
    expect(result.current.words).toEqual({ total: 140, series: [100, 40] })
    expect(result.current.streak).toEqual({ current: 4, longest: 11 })
    expect(result.current.error).toBeNull()
    expect(tauri.statsEntriesOverTime).toHaveBeenCalledWith('week', 90)
    expect(tauri.statsWritingVolume).toHaveBeenCalledWith('week', 90)
  })

  it('maps the mood histogram into percentages that sum to 100', async () => {
    const rows: MoodHistogramRow[] = [
      { emotion: 'good', count: 1 },
      { emotion: 'neutral', count: 1 },
      { emotion: 'bad', count: 1 },
    ]
    vi.mocked(tauri.statsMoodHistogram).mockResolvedValue(rows)

    const { result } = renderHook(() => useStoryNumbers('30d', 2026))
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    const { good, neutral, bad } = result.current.mood
    expect(good + neutral + bad).toBe(100)
    expect(result.current.mood).toEqual({ good: 34, neutral: 33, bad: 33 })
    expect(tauri.statsMoodHistogram).toHaveBeenCalledWith(30)
  })

  it('returns a null peak hour when every hour count is 0', async () => {
    const rows: WritingHourRow[] = [
      { hour: 0, count: 0 },
      { hour: 9, count: 0 },
      { hour: 23, count: 0 },
    ]
    vi.mocked(tauri.statsWritingHours).mockResolvedValue(rows)

    const { result } = renderHook(() => useStoryNumbers('7d', 2026))
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    expect(result.current.hours.peak).toBeNull()
    expect(result.current.hours.rows).toEqual(rows)
    expect(tauri.statsWritingHours).toHaveBeenCalledWith(7)
  })

  it('returns the streak calendar rows for the given year', async () => {
    const days: StreakCalendarDay[] = [
      { date: '2024-03-01', entry_count: 1 },
      { date: '2024-03-02', entry_count: 0 },
    ]
    vi.mocked(tauri.statsStreakCalendar).mockResolvedValue(days)

    const { result } = renderHook(() => useStoryNumbers('30d', 2024))
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    expect(result.current.heatmap.days).toEqual(days)
    expect(tauri.statsStreakCalendar).toHaveBeenCalledWith(2024)
    expect(result.current.streak).toEqual({ current: 0, longest: 0 })
  })

  it('keeps a successful total when another fetcher fails', async () => {
    vi.mocked(tauri.statsEntriesOverTime).mockResolvedValue([
      { period_start: '2026-06-01', count: 3 },
      { period_start: '2026-06-02', count: 4 },
    ])
    vi.mocked(tauri.statsMoodHistogram).mockRejectedValue(new Error('mood unavailable'))

    const { result } = renderHook(() => useStoryNumbers('30d', 2026))
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    expect(result.current.error).toBe('mood unavailable')
    expect(result.current.entries).toEqual({ total: 7, series: [3, 4] })
    expect(result.current.words.total).toBe(0)
  })
})
