import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useEntryHighlights } from './useEntryHighlights'
import type { EntryHighlights } from '../lib/tauri'

type Handler<T> = (event: { payload: T }) => void
const handlers: Record<string, Handler<unknown>> = {}

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, handler: Handler<unknown>) => {
    handlers[name] = handler
    return () => {
      delete handlers[name]
    }
  }),
}))

vi.mock('../lib/tauri', () => ({
  getEntryHighlights: vi.fn(),
  generateEntryHighlights: vi.fn(),
  clearEntryHighlights: vi.fn(),
  cancelSuggestion: vi.fn(),
}))

import * as tauri from '../lib/tauri'

function emit<T>(name: string, payload: T) {
  const handler = handlers[name] as Handler<T> | undefined
  if (handler) handler({ payload })
}

const NO_CACHE: EntryHighlights = {
  entryId: 'e1',
  markdown: null,
  generatedAt: null,
  modelId: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  for (const k of Object.keys(handlers)) delete handlers[k]
  vi.mocked(tauri.getEntryHighlights).mockResolvedValue(NO_CACHE)
  vi.mocked(tauri.generateEntryHighlights).mockResolvedValue(undefined)
  vi.mocked(tauri.clearEntryHighlights).mockResolvedValue(undefined)
  vi.mocked(tauri.cancelSuggestion).mockResolvedValue(true)
})

describe('useEntryHighlights', () => {
  it('starts in idle and loads the cached row on mount', async () => {
    const { result } = renderHook(() => useEntryHighlights('e1'))
    await waitFor(() => {
      expect(result.current.state.kind).toBe('idle')
    })
    // Invisible session is locked by default, so the by-id read is gated.
    expect(tauri.getEntryHighlights).toHaveBeenCalledWith('e1', null)
  })

  it('renders cached markdown when present', async () => {
    vi.mocked(tauri.getEntryHighlights).mockResolvedValueOnce({
      entryId: 'e1',
      markdown: '- key theme',
      generatedAt: 1700000000,
      modelId: 'openai:gpt-4o-mini',
    })
    const { result } = renderHook(() => useEntryHighlights('e1'))
    await waitFor(() => {
      const s = result.current.state
      if (s.kind !== 'idle') throw new Error('expected idle')
      expect(s.cached?.markdown).toBe('- key theme')
    })
  })

  it('generate() flips to streaming and accumulates partial', async () => {
    const { result } = renderHook(() => useEntryHighlights('e1'))
    await waitFor(() => expect(result.current.state.kind).toBe('idle'))
    await act(async () => {
      await result.current.generate()
    })
    expect(result.current.state.kind).toBe('streaming')
    await act(async () => {
      emit('ai:highlights-token', { key: 'e1', delta: '- theme' })
      emit('ai:highlights-token', { key: 'e1', delta: ' one' })
    })
    const s = result.current.state
    if (s.kind !== 'streaming') throw new Error('expected streaming')
    expect(s.partial).toBe('- theme one')
  })

  it('completes with from_cache=false on a fresh stream', async () => {
    const { result } = renderHook(() => useEntryHighlights('e1'))
    await waitFor(() => expect(result.current.state.kind).toBe('idle'))
    await act(async () => {
      await result.current.generate()
    })
    await act(async () => {
      emit('ai:highlights-complete', {
        key: 'e1',
        markdown: '- final',
        generated_at: 1700000000,
        model_id: 'mock:v1',
        from_cache: false,
      })
    })
    const s = result.current.state
    if (s.kind !== 'done') throw new Error('expected done')
    expect(s.markdown).toBe('- final')
    expect(s.fromCache).toBe(false)
  })

  it('completes with from_cache=true when backend short-circuits', async () => {
    const { result } = renderHook(() => useEntryHighlights('e1'))
    await waitFor(() => expect(result.current.state.kind).toBe('idle'))
    await act(async () => {
      await result.current.generate()
    })
    // Cache-hit path: backend emits complete WITHOUT any token events.
    await act(async () => {
      emit('ai:highlights-complete', {
        key: 'e1',
        markdown: '- cached',
        generated_at: 1,
        model_id: 'mock:v1',
        from_cache: true,
      })
    })
    const s = result.current.state
    if (s.kind !== 'done') throw new Error('expected done')
    expect(s.fromCache).toBe(true)
  })

  it('ignores events for a different entry id', async () => {
    const { result } = renderHook(() => useEntryHighlights('e1'))
    await waitFor(() => expect(result.current.state.kind).toBe('idle'))
    await act(async () => {
      await result.current.generate()
    })
    await act(async () => {
      // Stale event from a different entry — must NOT pollute state.
      emit('ai:highlights-token', { key: 'e2', delta: 'leak' })
    })
    const s = result.current.state
    if (s.kind !== 'streaming') throw new Error('expected streaming')
    expect(s.partial).toBe('')
  })

  it('flips to error on ai:highlights-error', async () => {
    const { result } = renderHook(() => useEntryHighlights('e1'))
    await waitFor(() => expect(result.current.state.kind).toBe('idle'))
    await act(async () => {
      await result.current.generate()
    })
    await act(async () => {
      emit('ai:highlights-error', { key: 'e1', code: 'AI_AUTH_FAILED', message: 'bad key' })
    })
    const s = result.current.state
    if (s.kind !== 'error') throw new Error('expected error')
    expect(s.code).toBe('AI_AUTH_FAILED')
  })

  it('cancel() optimistically flips to cancelled and calls backend', async () => {
    const { result } = renderHook(() => useEntryHighlights('e1'))
    await waitFor(() => expect(result.current.state.kind).toBe('idle'))
    await act(async () => {
      await result.current.generate()
    })
    await act(async () => {
      await result.current.cancel()
    })
    const s = result.current.state
    if (s.kind !== 'cancelled') throw new Error('expected cancelled')
    expect(tauri.cancelSuggestion).toHaveBeenCalledWith('highlights:e1')
  })

  it('clear() wipes cache + returns to idle', async () => {
    vi.mocked(tauri.getEntryHighlights).mockResolvedValueOnce({
      entryId: 'e1',
      markdown: '- old',
      generatedAt: 1,
      modelId: 'm',
    })
    const { result } = renderHook(() => useEntryHighlights('e1'))
    await waitFor(() => {
      const s = result.current.state
      if (s.kind !== 'idle') throw new Error('expected idle')
      expect(s.cached?.markdown).toBe('- old')
    })
    await act(async () => {
      await result.current.clear()
    })
    expect(tauri.clearEntryHighlights).toHaveBeenCalledWith('e1')
    const s = result.current.state
    if (s.kind !== 'idle') throw new Error('expected idle')
    expect(s.cached).toBeNull()
  })
})
