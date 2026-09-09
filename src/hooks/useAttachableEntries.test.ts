import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useAttachableEntries } from './useAttachableEntries'
import type { ChatAttachableEntry } from '../lib/tauri'

vi.mock('../lib/tauri', () => ({
  chatSearchAttachableEntries: vi.fn(),
}))

import * as tauri from '../lib/tauri'

const makeEntry = (overrides: Partial<ChatAttachableEntry> = {}): ChatAttachableEntry => ({
  id: 'e1',
  title: 'Morning walk',
  entryDate: 1_700_000_000,
  ...overrides,
})

beforeEach(() => {
  vi.resetAllMocks()
})

describe('useAttachableEntries', () => {
  it('returns_recent_entries_for_empty_query', async () => {
    const recent = [makeEntry({ id: 'e1' }), makeEntry({ id: 'e2' })]
    vi.mocked(tauri.chatSearchAttachableEntries).mockResolvedValue(recent)

    const { result } = renderHook(() => useAttachableEntries(''))

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(tauri.chatSearchAttachableEntries).toHaveBeenCalledWith('', 5)
    expect(result.current.entries).toEqual(recent)
  })

  it('debounces_rapid_queries', async () => {
    vi.mocked(tauri.chatSearchAttachableEntries).mockResolvedValue([])

    const { rerender } = renderHook(({ q }: { q: string }) => useAttachableEntries(q), {
      initialProps: { q: 'd' },
    })
    rerender({ q: 'da' })
    rerender({ q: 'da ' })
    rerender({ q: 'da n' })

    await waitFor(() => expect(tauri.chatSearchAttachableEntries).toHaveBeenCalledWith('da n', 5))
    expect(tauri.chatSearchAttachableEntries).toHaveBeenCalledTimes(1)
  })

  it('ignores_stale_response_after_newer_query', async () => {
    let resolveFirst: (entries: ChatAttachableEntry[]) => void = () => undefined
    const staleEntry = makeEntry({ id: 'stale' })
    const freshEntry = makeEntry({ id: 'fresh' })

    vi.mocked(tauri.chatSearchAttachableEntries)
      .mockImplementationOnce(
        () =>
          new Promise<ChatAttachableEntry[]>((resolve) => {
            resolveFirst = resolve
          }),
      )
      .mockResolvedValueOnce([freshEntry])

    const { result, rerender } = renderHook(({ q }: { q: string }) => useAttachableEntries(q), {
      initialProps: { q: 'a' },
    })

    await waitFor(() => expect(tauri.chatSearchAttachableEntries).toHaveBeenCalledTimes(1))

    rerender({ q: 'ab' })

    await waitFor(() => expect(tauri.chatSearchAttachableEntries).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(result.current.entries).toEqual([freshEntry]))

    await act(async () => {
      resolveFirst([staleEntry])
      await Promise.resolve()
    })

    expect(result.current.entries).toEqual([freshEntry])
  })

  it('degrades_to_empty_list_when_the_call_rejects', async () => {
    vi.mocked(tauri.chatSearchAttachableEntries).mockRejectedValue(new Error('boom'))

    const { result } = renderHook(() => useAttachableEntries('query'))

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.entries).toEqual([])
  })
})
