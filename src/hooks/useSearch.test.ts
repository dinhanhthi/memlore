import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useSearch } from './useSearch'
import type { SearchResult } from '../types/entry'

vi.mock('../lib/tauri', () => ({
  searchEntries: vi.fn(),
}))

import * as tauri from '../lib/tauri'

const makeResult = (overrides: Partial<SearchResult> = {}): SearchResult => ({
  id: 'r1',
  journal_id: 'j1',
  title: 'Result',
  preview_text: 'preview',
  entry_date: 1_700_000_000,
  ...overrides,
})

// Tests use real timers. The hook's debounce is 300ms — waitFor polls until
// the backend is actually called, so we don't need to pin a specific delay.

beforeEach(() => {
  vi.resetAllMocks()
})

describe('useSearch', () => {
  it('returns empty results and does not call backend for blank query', async () => {
    const { result } = renderHook(() => useSearch(''))
    // Wait a tick to ensure no backend call is scheduled.
    await new Promise((r) => setTimeout(r, 50))
    expect(result.current.results).toEqual([])
    expect(result.current.isLoading).toBe(false)
    expect(tauri.searchEntries).not.toHaveBeenCalled()
  })

  it('returns empty results for whitespace-only query', async () => {
    renderHook(() => useSearch('   '))
    await new Promise((r) => setTimeout(r, 50))
    expect(tauri.searchEntries).not.toHaveBeenCalled()
  })

  it('debounces and calls backend after the debounce window', async () => {
    vi.mocked(tauri.searchEntries).mockResolvedValue([makeResult()])

    const { result } = renderHook(() => useSearch('hello'))
    expect(result.current.isLoading).toBe(true)
    // Immediately after render, the debounce hasn't elapsed yet.
    expect(tauri.searchEntries).not.toHaveBeenCalled()

    await waitFor(() =>
      expect(tauri.searchEntries).toHaveBeenCalledWith('hello', undefined, 'revealed', null),
    )
  })

  it('trims query before sending to backend', async () => {
    vi.mocked(tauri.searchEntries).mockResolvedValue([])
    renderHook(() => useSearch('  padded  '))
    await waitFor(() =>
      expect(tauri.searchEntries).toHaveBeenCalledWith('padded', undefined, 'revealed', null),
    )
  })

  it('only calls backend once when query changes rapidly', async () => {
    vi.mocked(tauri.searchEntries).mockResolvedValue([])

    const { rerender } = renderHook(({ q }: { q: string }) => useSearch(q), {
      initialProps: { q: 'a' },
    })
    rerender({ q: 'ab' })
    rerender({ q: 'abc' })

    await waitFor(() =>
      expect(tauri.searchEntries).toHaveBeenCalledWith('abc', undefined, 'revealed', null),
    )
    // After the debounce only the final query hits the backend.
    expect(tauri.searchEntries).toHaveBeenCalledTimes(1)
  })

  it('populates results on successful search', async () => {
    const found = [makeResult({ id: 'x1', title: 'Hit' })]
    vi.mocked(tauri.searchEntries).mockResolvedValue(found)

    const { result } = renderHook(() => useSearch('hit'))

    await waitFor(() => expect(result.current.results).toEqual(found))
    expect(result.current.isLoading).toBe(false)
    expect(result.current.error).toBeNull()
  })

  it('sets error on backend failure', async () => {
    vi.mocked(tauri.searchEntries).mockRejectedValue(new Error('boom'))

    const { result } = renderHook(() => useSearch('x'))

    await waitFor(() => expect(result.current.error).toBe('boom'))
    expect(result.current.isLoading).toBe(false)
  })

  it('clears results when query is cleared', async () => {
    vi.mocked(tauri.searchEntries).mockResolvedValue([makeResult()])

    const { result, rerender } = renderHook(({ q }: { q: string }) => useSearch(q), {
      initialProps: { q: 'hello' },
    })

    await waitFor(() => expect(result.current.results).toHaveLength(1))

    rerender({ q: '' })
    expect(result.current.results).toEqual([])
  })
})
