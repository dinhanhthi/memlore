import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useChatContextPreflight } from './useChatContextPreflight'
import type { ChatAttachmentRef, ChatContextPreflight } from '../types/ai'

vi.mock('../lib/tauri', () => ({
  chatRagPreflight: vi.fn(),
}))

import * as tauri from '../lib/tauri'

const makePreflight = (overrides: Partial<ChatContextPreflight> = {}): ChatContextPreflight => ({
  estimatedBytes: 1024,
  totalBytes: 1024,
  entriesIncluded: 1,
  entriesTotal: 1,
  trimmed: false,
  needsConfirm: false,
  blocked: false,
  ...overrides,
})

beforeEach(() => {
  vi.resetAllMocks()
})

describe('useChatContextPreflight', () => {
  it('returns_null_when_no_attachments_and_rag_off', async () => {
    const { result } = renderHook(() => useChatContextPreflight([], '', false))

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.preflight).toBeNull()
    expect(tauri.chatRagPreflight).not.toHaveBeenCalled()
  })

  it('debounces_and_ignores_stale_responses', async () => {
    let resolveFirst: (value: ChatContextPreflight) => void = () => undefined
    const stale = makePreflight({ estimatedBytes: 111 })
    const fresh = makePreflight({ estimatedBytes: 222 })

    vi.mocked(tauri.chatRagPreflight)
      .mockImplementationOnce(
        () =>
          new Promise<ChatContextPreflight>((resolve) => {
            resolveFirst = resolve
          }),
      )
      .mockResolvedValueOnce(fresh)

    const attachments: ChatAttachmentRef[] = [{ kind: 'entry', id: 'e1' }]

    const { result, rerender } = renderHook(
      ({ q }: { q: string }) => useChatContextPreflight(attachments, q, true),
      { initialProps: { q: 'a' } },
    )

    rerender({ q: 'ab' })
    rerender({ q: 'abc' })

    await waitFor(() => expect(tauri.chatRagPreflight).toHaveBeenCalledTimes(1))
    expect(tauri.chatRagPreflight).toHaveBeenCalledWith(attachments, 'abc')

    rerender({ q: 'abcd' })

    await waitFor(() => expect(tauri.chatRagPreflight).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(result.current.preflight).toEqual(fresh))

    await act(async () => {
      resolveFirst(stale)
      await Promise.resolve()
    })

    expect(result.current.preflight).toEqual(fresh)
  })

  it('passes_attachments_through_unchanged', async () => {
    const attachments: ChatAttachmentRef[] = [
      { kind: 'entry', id: 'e1' },
      { kind: 'period', start: 100, end: 200, label: 'July' },
    ]
    vi.mocked(tauri.chatRagPreflight).mockResolvedValue(makePreflight())

    renderHook(() => useChatContextPreflight(attachments, 'hello', true))

    await waitFor(() => expect(tauri.chatRagPreflight).toHaveBeenCalledWith(attachments, 'hello'))
  })

  it('returns_null_when_the_preflight_call_rejects', async () => {
    vi.mocked(tauri.chatRagPreflight).mockRejectedValue(new Error('boom'))

    const { result } = renderHook(() =>
      useChatContextPreflight([{ kind: 'entry', id: 'e1' }], '', true),
    )

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.preflight).toBeNull()
  })
})
