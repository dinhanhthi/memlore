import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useSmartSummary } from './useSmartSummary'

// Phase 6 v2 R6: streaming title suggestion via Tauri events. The hook
// listens to four event names; each test simulates the backend by
// invoking the registered handler directly through this stub.
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
  suggestTitle: vi.fn(),
  cancelSuggestion: vi.fn(),
}))

import * as tauri from '../lib/tauri'

function emit<T>(name: string, payload: T) {
  const handler = handlers[name] as Handler<T> | undefined
  if (handler) handler({ payload })
}

beforeEach(() => {
  vi.clearAllMocks()
  for (const k of Object.keys(handlers)) delete handlers[k]
  vi.mocked(tauri.suggestTitle).mockResolvedValue(undefined)
  vi.mocked(tauri.cancelSuggestion).mockResolvedValue(true)
})

describe('useSmartSummary', () => {
  it('starts in idle state', () => {
    const { result } = renderHook(() => useSmartSummary())
    expect(result.current.state).toEqual({ kind: 'idle' })
  })

  it('flips to streaming and accumulates partial tokens', async () => {
    const { result } = renderHook(() => useSmartSummary())

    await act(async () => {
      await result.current.suggest('e1')
    })
    expect(result.current.state).toEqual({ kind: 'streaming', entryId: 'e1', partial: '' })

    await act(async () => {
      emit('ai:suggest-title-token', { entry_id: 'e1', delta: 'Morning' })
      emit('ai:suggest-title-token', { entry_id: 'e1', delta: ' walk' })
    })
    expect(result.current.state).toEqual({
      kind: 'streaming',
      entryId: 'e1',
      partial: 'Morning walk',
    })
  })

  it('finalises on ai:suggest-title-complete', async () => {
    const { result } = renderHook(() => useSmartSummary())
    await act(async () => {
      await result.current.suggest('e1')
    })
    await act(async () => {
      emit('ai:suggest-title-token', { entry_id: 'e1', delta: 'Morning walk' })
      emit('ai:suggest-title-complete', { entry_id: 'e1', title: 'Morning walk' })
    })
    expect(result.current.state).toEqual({
      kind: 'done',
      entryId: 'e1',
      title: 'Morning walk',
    })
  })

  it('ignores token events for a different entry id', async () => {
    const { result } = renderHook(() => useSmartSummary())
    await act(async () => {
      await result.current.suggest('e1')
    })
    await act(async () => {
      // Stale event from a previous entry; must NOT pollute partial.
      emit('ai:suggest-title-token', { entry_id: 'e2', delta: 'leak' })
    })
    expect(result.current.state).toEqual({ kind: 'streaming', entryId: 'e1', partial: '' })
  })

  it('flips to error on ai:suggest-title-error (legacy `error` field)', async () => {
    const { result } = renderHook(() => useSmartSummary())
    await act(async () => {
      await result.current.suggest('e1')
    })
    await act(async () => {
      emit('ai:suggest-title-error', { entry_id: 'e1', error: 'AI_AUTH_FAILED' })
    })
    expect(result.current.state).toEqual({
      kind: 'error',
      entryId: 'e1',
      code: 'AI_AUTH_FAILED',
    })
  })

  it('prefers stable `code` field over legacy `error` body', async () => {
    const { result } = renderHook(() => useSmartSummary())
    await act(async () => {
      await result.current.suggest('e1')
    })
    await act(async () => {
      emit('ai:suggest-title-error', {
        entry_id: 'e1',
        code: 'AI_AUTH_FAILED',
        message: 'bearer rejected',
      })
    })
    expect(result.current.state).toEqual({
      kind: 'error',
      entryId: 'e1',
      code: 'AI_AUTH_FAILED',
    })
  })

  it('cancel() optimistically flips to cancelled state', async () => {
    const { result } = renderHook(() => useSmartSummary())
    await act(async () => {
      await result.current.suggest('e1')
    })
    expect(result.current.state.kind).toBe('streaming')
    await act(async () => {
      await result.current.cancel()
    })
    // Optimistic flip — UI is responsive even if backend ack is slow.
    expect(result.current.state).toEqual({ kind: 'cancelled', entryId: 'e1' })
  })

  it('late-arriving complete after cancel does not resurrect done state', async () => {
    const { result } = renderHook(() => useSmartSummary())
    await act(async () => {
      await result.current.suggest('e1')
    })
    await act(async () => {
      await result.current.cancel()
    })
    // Backend ACKs cancel late; user already moved on.
    await act(async () => {
      emit('ai:suggest-title-complete', { entry_id: 'e1', title: 'Late' })
    })
    expect(result.current.state).toEqual({ kind: 'cancelled', entryId: 'e1' })
  })

  it('flips to cancelled on ai:suggest-title-cancelled', async () => {
    const { result } = renderHook(() => useSmartSummary())
    await act(async () => {
      await result.current.suggest('e1')
    })
    await act(async () => {
      emit('ai:suggest-title-cancelled', { entry_id: 'e1' })
    })
    expect(result.current.state).toEqual({ kind: 'cancelled', entryId: 'e1' })
  })

  it('cancel() invokes cancelSuggestion', async () => {
    const { result } = renderHook(() => useSmartSummary())
    await act(async () => {
      await result.current.suggest('e1')
    })
    await act(async () => {
      await result.current.cancel()
    })
    expect(tauri.cancelSuggestion).toHaveBeenCalledWith('e1')
  })

  it('reset() returns to idle', async () => {
    const { result } = renderHook(() => useSmartSummary())
    await act(async () => {
      await result.current.suggest('e1')
      emit('ai:suggest-title-complete', { entry_id: 'e1', title: 'Done' })
    })
    expect(result.current.state.kind).toBe('done')
    act(() => {
      result.current.reset()
    })
    expect(result.current.state).toEqual({ kind: 'idle' })
  })

  it('rejected suggestTitle promise lands in error state', async () => {
    vi.mocked(tauri.suggestTitle).mockRejectedValueOnce('AI_NOT_CONFIGURED')
    const { result } = renderHook(() => useSmartSummary())
    await act(async () => {
      await result.current.suggest('e1')
    })
    await waitFor(() => {
      expect(result.current.state).toEqual({
        kind: 'error',
        entryId: 'e1',
        code: 'AI_NOT_CONFIGURED',
      })
    })
  })
})
