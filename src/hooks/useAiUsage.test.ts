import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('../lib/tauri', () => ({
  summarizeAiUsage: vi.fn(),
}))

import * as tauri from '../lib/tauri'
import { useAiUsage } from './useAiUsage'
import type { AiUsageSummary } from '../types/ai'

function makeSummary(): AiUsageSummary {
  return {
    period: '30d',
    since_ms: 0,
    headline: {
      calls: 10,
      tokens_in: 500,
      tokens_out: 200,
      payload_bytes: 1024,
      null_token_calls: 1,
    },
    per_provider: [
      {
        provider_id: 'openai',
        calls: 10,
        tokens_in: 500,
        tokens_out: 200,
        payload_bytes: 1024,
        null_token_calls: 1,
      },
    ],
    breakdown: [
      {
        provider_id: 'openai',
        model_id: 'gpt-4o-mini',
        feature: 'smart_title',
        calls: 10,
        tokens_in: 500,
        tokens_out: 200,
        payload_bytes: 1024,
        avg_latency_ms: 120.0,
        error_rate: 0.0,
        null_token_calls: 1,
      },
    ],
    daily: [{ date: '2026-05-01', calls: 10, tokens_in: 500, tokens_out: 200 }],
  }
}

beforeEach(() => {
  vi.mocked(tauri.summarizeAiUsage).mockReset()
})

describe('useAiUsage', () => {
  // ── Test 1: returns the summary and clears isLoading ────────────────────────

  it('fetches and returns the summary; isLoading is false after resolve', async () => {
    const expected = makeSummary()
    vi.mocked(tauri.summarizeAiUsage).mockResolvedValue(expected)

    const { result } = renderHook(() => useAiUsage('30d'))

    await waitFor(() => expect(result.current.isLoading).toBe(false))

    expect(result.current.summary).toEqual(expected)
    expect(result.current.error).toBeNull()
    expect(vi.mocked(tauri.summarizeAiUsage)).toHaveBeenCalledWith('30d')
  })

  // ── Test 2: period change triggers a new invoke call ────────────────────────

  it('triggers a new invoke call when period changes', async () => {
    const summary30d = makeSummary()
    const summary7d: AiUsageSummary = { ...makeSummary(), period: '7d' }

    vi.mocked(tauri.summarizeAiUsage)
      .mockResolvedValueOnce(summary30d) // initial period '30d'
      .mockResolvedValueOnce(summary7d) // after switching to '7d'

    const { result } = renderHook(() => useAiUsage('30d'))

    // Wait for first fetch to complete
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.summary?.period).toBe('30d')

    // Switch period
    act(() => {
      result.current.setPeriod('7d')
    })

    // Should trigger a new fetch with '7d'
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    const calls = vi.mocked(tauri.summarizeAiUsage).mock.calls
    expect(calls.length).toBe(2)
    expect(calls[1][0]).toBe('7d')
  })
})
