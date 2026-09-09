import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

vi.mock('../lib/tauri', () => ({
  statsEmotionTrend: vi.fn(),
}))

import * as tauri from '../lib/tauri'
import { useEmotionTrend } from './useEmotionTrend'
import { __clearStatsCache } from './useStats'

beforeEach(() => {
  vi.mocked(tauri.statsEmotionTrend).mockReset()
  __clearStatsCache()
})

describe('useEmotionTrend', () => {
  it('fetches day buckets and computes ratios', async () => {
    vi.mocked(tauri.statsEmotionTrend).mockResolvedValueOnce([
      {
        period_start: '2026-01-01',
        bad_count: 1,
        neutral_count: 1,
        good_count: 2,
        total_count: 4,
      },
    ])

    const { result } = renderHook(() => useEmotionTrend('30d'))

    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(tauri.statsEmotionTrend).toHaveBeenCalledWith('day', 30)
    expect(result.current.rows).toHaveLength(1)
    expect(result.current.rows[0].goodRatio).toBe(0.5)
    expect(result.current.rows[0].badRatio).toBe(0.25)
  })

  it('uses week bucket for 90d period', async () => {
    vi.mocked(tauri.statsEmotionTrend).mockResolvedValueOnce([])

    const { result } = renderHook(() => useEmotionTrend('90d'))
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(tauri.statsEmotionTrend).toHaveBeenCalledWith('week', 90)
  })
})
