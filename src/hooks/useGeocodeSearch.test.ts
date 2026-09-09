import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { GeocodeSuggestion } from '../types/geocoding'

vi.mock('../lib/tauri', () => ({
  geocodeSearch: vi.fn(),
  geocodeResolve: vi.fn(),
}))

import { geocodeSearch } from '../lib/tauri'
import { useGeocodeSearch } from './useGeocodeSearch'

const mockedSearch = vi.mocked(geocodeSearch)

const fakeSuggestion: GeocodeSuggestion = {
  place_id: 'nom-1',
  label: 'Paris',
  address: 'Paris, France',
  latitude: 48.8566,
  longitude: 2.3522,
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

// Helper: advance timers AND flush any pending promises
async function advanceAndFlush(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms)
    // flush microtasks
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('useGeocodeSearch', () => {
  it('does_not_call_invoke_below_min_length — query length 1 → invoke never called; suggestions = []', async () => {
    const { result } = renderHook(() => useGeocodeSearch('a'))

    await advanceAndFlush(400)

    expect(mockedSearch).not.toHaveBeenCalled()
    expect(result.current.suggestions).toEqual([])
    expect(result.current.isLoading).toBe(false)
  })

  it('does_not_call_invoke_for_blank_query — whitespace-only query → invoke never called', async () => {
    const { result } = renderHook(() => useGeocodeSearch('   '))

    await advanceAndFlush(400)

    expect(mockedSearch).not.toHaveBeenCalled()
    expect(result.current.suggestions).toEqual([])
    expect(result.current.isLoading).toBe(false)
  })

  it('calls_invoke_with_trimmed_query_at_min_length — query "  ab  " → called with "ab"', async () => {
    mockedSearch.mockResolvedValueOnce([fakeSuggestion])

    const { result } = renderHook(() => useGeocodeSearch('  ab  '))

    await advanceAndFlush(400)

    expect(mockedSearch).toHaveBeenCalledTimes(1)
    const [query] = mockedSearch.mock.calls[0]
    expect(query).toBe('ab')
    expect(result.current.suggestions).toEqual([fakeSuggestion])
  })

  it('debounces_rapid_input_to_single_call — 5 rapid updates → only 1 invoke after debounce', async () => {
    mockedSearch.mockResolvedValueOnce([fakeSuggestion])

    const { rerender } = renderHook(({ q }) => useGeocodeSearch(q), {
      initialProps: { q: 'pa' },
    })

    // Rapid updates within debounce window — no timer advance yet
    await act(async () => {
      rerender({ q: 'par' })
    })
    await act(async () => {
      rerender({ q: 'pari' })
    })
    await act(async () => {
      rerender({ q: 'paris' })
    })
    await act(async () => {
      rerender({ q: 'paris ' })
    })

    // Advance past debounce and flush
    await advanceAndFlush(400)

    expect(mockedSearch).toHaveBeenCalledTimes(1)
  })

  it('discards_stale_responses_on_new_query — first request resolves after second; only second result wins', async () => {
    let resolveFirst!: (v: GeocodeSuggestion[]) => void
    const firstPromise = new Promise<GeocodeSuggestion[]>((r) => {
      resolveFirst = r
    })

    const secondResult: GeocodeSuggestion = {
      place_id: 'nom-2',
      label: 'London',
      address: 'London, UK',
      latitude: 51.5074,
      longitude: -0.1278,
    }
    mockedSearch.mockReturnValueOnce(firstPromise).mockResolvedValueOnce([secondResult])

    const { result, rerender } = renderHook(({ q }) => useGeocodeSearch(q), {
      initialProps: { q: 'pa' },
    })

    // Trigger first request
    await advanceAndFlush(400)

    // Change query before first resolves
    await act(async () => {
      rerender({ q: 'lo' })
    })

    // Trigger second request
    await advanceAndFlush(400)

    // Now resolve the FIRST (stale) promise — should be discarded
    await act(async () => {
      resolveFirst([fakeSuggestion])
      await Promise.resolve()
      await Promise.resolve()
    })

    // Only the second result (London) should be kept
    expect(result.current.suggestions).toEqual([secondResult])
    expect(result.current.isLoading).toBe(false)
  })

  it('surfaces_error_for_failed_invoke — invoke rejects → error state populated, suggestions empty', async () => {
    mockedSearch.mockRejectedValueOnce(new Error('Network error'))

    const { result } = renderHook(() => useGeocodeSearch('ha'))

    await advanceAndFlush(400)

    expect(result.current.error).toMatch(/Network error/)
    expect(result.current.suggestions).toEqual([])
    expect(result.current.isLoading).toBe(false)
  })

  it('passes_session_token_to_invoke — sessionToken is passed as third arg to geocodeSearch', async () => {
    mockedSearch.mockResolvedValueOnce([fakeSuggestion])

    const { result } = renderHook(() => useGeocodeSearch('ha'))

    await advanceAndFlush(400)

    const sessionToken = result.current.sessionToken
    expect(typeof sessionToken).toBe('string')
    expect(sessionToken.length).toBeGreaterThan(0)

    expect(mockedSearch).toHaveBeenCalledTimes(1)
    // The token was passed into geocodeSearch as the third arg
    expect(mockedSearch).toHaveBeenCalledWith('ha', expect.any(Number), sessionToken)
  })

  it('discards_stale_responses_when_query_drops_below_min_length — pending request resolves after query shrinks; suggestions stay empty', async () => {
    let resolveFirst!: (v: GeocodeSuggestion[]) => void
    const firstPromise = new Promise<GeocodeSuggestion[]>((r) => {
      resolveFirst = r
    })
    mockedSearch.mockReturnValueOnce(firstPromise)

    const { result, rerender } = renderHook(({ q }) => useGeocodeSearch(q), {
      initialProps: { q: 'pa' },
    })

    // Fire the first request
    await advanceAndFlush(400)
    expect(mockedSearch).toHaveBeenCalledTimes(1)

    // Shrink the query to length 1 (below min)
    await act(async () => {
      rerender({ q: 'p' })
    })

    // Now resolve the in-flight request — its results must be discarded
    await act(async () => {
      resolveFirst([fakeSuggestion])
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(result.current.suggestions).toEqual([])
    expect(result.current.isLoading).toBe(false)
  })

  it('returns_stable_session_token_across_renders — token does not change between rerenders', async () => {
    mockedSearch.mockResolvedValue([fakeSuggestion])

    const { result, rerender } = renderHook(({ q }) => useGeocodeSearch(q), {
      initialProps: { q: 'ha' },
    })

    await advanceAndFlush(400)

    const tokenBefore = result.current.sessionToken

    await act(async () => {
      rerender({ q: 'han' })
    })

    await advanceAndFlush(400)

    const tokenAfter = result.current.sessionToken

    expect(tokenAfter).toBe(tokenBefore)
    expect(typeof tokenAfter).toBe('string')
    expect(tokenAfter.length).toBeGreaterThan(0)
  })
})
