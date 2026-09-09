import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useMemoryTexts } from './useMemoryTexts'
import type { MemoryItemRow } from '../lib/tauri'

vi.mock('../lib/tauri', () => ({
  listMemoryItems: vi.fn(),
}))

import * as tauri from '../lib/tauri'

const makeItem = (overrides: Partial<MemoryItemRow> = {}): MemoryItemRow => ({
  id: 'm1',
  text: 'Some fact',
  sourceType: 'daily_chat',
  enabled: true,
  isDeleted: false,
  createdAt: 0,
  updatedAt: 0,
  ...overrides,
})

beforeEach(() => {
  vi.resetAllMocks()
})

describe('useMemoryTexts', () => {
  it('returns an empty map and does not call backend for no ids', async () => {
    const { result } = renderHook(() => useMemoryTexts([]))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.texts.size).toBe(0)
    expect(tauri.listMemoryItems).not.toHaveBeenCalled()
  })

  it('resolves text for each memory id present in the live list', async () => {
    vi.mocked(tauri.listMemoryItems).mockResolvedValue([
      makeItem({ id: 'm1', text: 'First fact' }),
      makeItem({ id: 'm2', text: 'Second fact' }),
    ])

    const { result } = renderHook(() => useMemoryTexts(['m1', 'm2']))

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.texts.get('m1')).toBe('First fact')
    expect(result.current.texts.get('m2')).toBe('Second fact')
  })

  it('still resolves text for a disabled-but-live memory', async () => {
    vi.mocked(tauri.listMemoryItems).mockResolvedValue([
      makeItem({ id: 'm1', text: 'Disabled fact', enabled: false }),
    ])

    const { result } = renderHook(() => useMemoryTexts(['m1']))

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.texts.get('m1')).toBe('Disabled fact')
  })

  it('omits ids for memories that were deleted (no longer in the live list)', async () => {
    vi.mocked(tauri.listMemoryItems).mockResolvedValue([makeItem({ id: 'm2' })])

    const { result } = renderHook(() => useMemoryTexts(['m1', 'm2']))

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.texts.has('m1')).toBe(false)
    expect(result.current.texts.has('m2')).toBe(true)
  })

  it('resolves to an empty map when the backend call fails', async () => {
    vi.mocked(tauri.listMemoryItems).mockRejectedValue(new Error('boom'))

    const { result } = renderHook(() => useMemoryTexts(['m1']))

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.texts.size).toBe(0)
  })

  it('fetches exactly once for duplicate ids and an equal-but-new array on re-render', async () => {
    vi.mocked(tauri.listMemoryItems).mockResolvedValue([
      makeItem({ id: 'm1', text: 'First fact' }),
      makeItem({ id: 'm2', text: 'Second fact' }),
    ])

    const { result, rerender } = renderHook(({ ids }) => useMemoryTexts(ids), {
      initialProps: { ids: ['m1', 'm1', 'm2'] },
    })

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(tauri.listMemoryItems).toHaveBeenCalledTimes(1)

    // Equal-but-NEW array reference, same unique ids in a different order —
    // `idsKey` dedupes + sorts, so it must be identical and the effect must
    // not re-fetch (the single-fetch-per-transcript claim this hook exists
    // to satisfy).
    rerender({ ids: ['m2', 'm1'] })

    expect(tauri.listMemoryItems).toHaveBeenCalledTimes(1)
  })
})
