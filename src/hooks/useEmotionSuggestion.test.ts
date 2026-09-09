import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useEmotionSuggestion } from './useEmotionSuggestion'
import type { EmotionScore } from '../types/entry'

vi.mock('../lib/tauri', () => ({
  suggestEmotion: vi.fn(),
}))

import * as tauri from '../lib/tauri'

const makeScore = (overrides: Partial<EmotionScore> = {}): EmotionScore => ({
  emotion: 'good',
  score: 0.7,
  ...overrides,
})

beforeEach(() => {
  vi.resetAllMocks()
})

describe('useEmotionSuggestion', () => {
  it('does not call backend when active is false', async () => {
    const { result } = renderHook(() => useEmotionSuggestion('e1', false))
    await new Promise((r) => setTimeout(r, 30))
    expect(tauri.suggestEmotion).not.toHaveBeenCalled()
    expect(result.current.suggestion).toBeNull()
    expect(result.current.isLoading).toBe(false)
  })

  it('does not call backend when entryId is null', async () => {
    renderHook(() => useEmotionSuggestion(null, true))
    await new Promise((r) => setTimeout(r, 30))
    expect(tauri.suggestEmotion).not.toHaveBeenCalled()
  })

  it('returns suggestion on successful fetch', async () => {
    vi.mocked(tauri.suggestEmotion).mockResolvedValue(makeScore({ emotion: 'neutral' }))
    const { result } = renderHook(() => useEmotionSuggestion('e1', true))
    await waitFor(() =>
      expect(result.current.suggestion).toEqual(expect.objectContaining({ emotion: 'neutral' })),
    )
    expect(tauri.suggestEmotion).toHaveBeenCalledWith('e1')
  })

  it('returns null when backend declines (below threshold)', async () => {
    vi.mocked(tauri.suggestEmotion).mockResolvedValue(null)
    const { result } = renderHook(() => useEmotionSuggestion('e1', true))
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.suggestion).toBeNull()
  })

  it('swallows errors into null suggestion', async () => {
    vi.mocked(tauri.suggestEmotion).mockRejectedValue(new Error('boom'))
    const { result } = renderHook(() => useEmotionSuggestion('e1', true))
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.suggestion).toBeNull()
  })

  it('refetches when entryId changes', async () => {
    vi.mocked(tauri.suggestEmotion).mockImplementation(async (id: string) =>
      makeScore({ emotion: id === 'e1' ? 'good' : 'bad' }),
    )
    const { result, rerender } = renderHook(
      ({ id, on }: { id: string; on: boolean }) => useEmotionSuggestion(id, on),
      { initialProps: { id: 'e1', on: true } },
    )
    await waitFor(() => expect(result.current.suggestion?.emotion).toBe('good'))

    rerender({ id: 'e2', on: true })
    await waitFor(() => expect(result.current.suggestion?.emotion).toBe('bad'))
  })

  it('clears suggestion when active flips to false', async () => {
    vi.mocked(tauri.suggestEmotion).mockResolvedValue(makeScore())
    const { result, rerender } = renderHook(
      ({ on }: { on: boolean }) => useEmotionSuggestion('e1', on),
      { initialProps: { on: true } },
    )
    await waitFor(() => expect(result.current.suggestion).not.toBeNull())

    rerender({ on: false })
    expect(result.current.suggestion).toBeNull()
    expect(result.current.isLoading).toBe(false)
  })
})
