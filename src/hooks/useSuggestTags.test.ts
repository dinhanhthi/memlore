import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useSuggestTags } from './useSuggestTags'

vi.mock('../lib/tauri', () => ({
  suggestTags: vi.fn(),
}))

import * as tauri from '../lib/tauri'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useSuggestTags', () => {
  it('starts idle', () => {
    const { result } = renderHook(() => useSuggestTags())
    expect(result.current.state.kind).toBe('idle')
  })

  it('returns suggestions on success', async () => {
    vi.mocked(tauri.suggestTags).mockResolvedValueOnce(['work', 'focus'])
    const { result } = renderHook(() => useSuggestTags())

    await act(async () => {
      void result.current.suggest('e1')
    })

    await waitFor(() => expect(result.current.state.kind).toBe('done'))
    if (result.current.state.kind === 'done') {
      expect(result.current.state.suggestions).toEqual(['work', 'focus'])
    }
  })

  it('surfaces error code from rejection', async () => {
    vi.mocked(tauri.suggestTags).mockRejectedValueOnce('AI_TAG_SUGGESTIONS_DISABLED')
    const { result } = renderHook(() => useSuggestTags())

    await act(async () => {
      void result.current.suggest('e1')
    })

    await waitFor(() => expect(result.current.state.kind).toBe('error'))
    if (result.current.state.kind === 'error') {
      expect(result.current.state.code).toBe('AI_TAG_SUGGESTIONS_DISABLED')
    }
  })

  it('unwraps a feature-disabled code carried inside AI_PROVIDER_ERROR', async () => {
    vi.mocked(tauri.suggestTags).mockRejectedValueOnce(
      'AI_PROVIDER_ERROR: AI_TAG_SUGGESTIONS_DISABLED',
    )
    const { result } = renderHook(() => useSuggestTags())

    await act(async () => {
      void result.current.suggest('e1')
    })

    await waitFor(() => expect(result.current.state.kind).toBe('error'))
    if (result.current.state.kind === 'error') {
      expect(result.current.state.code).toBe('AI_TAG_SUGGESTIONS_DISABLED')
    }
  })

  it('removeSuggestion drops a chip', async () => {
    vi.mocked(tauri.suggestTags).mockResolvedValueOnce(['a', 'b'])
    const { result } = renderHook(() => useSuggestTags())

    await act(async () => {
      void result.current.suggest('e1')
    })
    await waitFor(() => expect(result.current.state.kind).toBe('done'))

    act(() => {
      result.current.removeSuggestion('a')
    })

    if (result.current.state.kind === 'done') {
      expect(result.current.state.suggestions).toEqual(['b'])
    }
  })
})
