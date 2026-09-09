import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useTitleStreamController, useTitleStream } from './useTitleStreamController'
import { useTitleStreamStore } from '../stores/titleStreamStore'
import { useEntryStore } from '../stores/entryStore'
import type { Entry } from '../types/entry'

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
  updateEntry: vi.fn(),
}))

import * as tauri from '../lib/tauri'

function emit<T>(name: string, payload: T) {
  const handler = handlers[name] as Handler<T> | undefined
  if (handler) handler({ payload })
}

function fakeEntry(id: string, title: string): Entry {
  return {
    id,
    journal_id: 'j1',
    title,
    content_text: null,
    preview_text: null,
    entry_date: 1_700_000_000,
    created_at: 1_700_000_000,
    updated_at: 1_700_000_000,
    is_favorite: false,
  } as unknown as Entry
}

beforeEach(() => {
  vi.clearAllMocks()
  for (const k of Object.keys(handlers)) delete handlers[k]
  vi.mocked(tauri.suggestTitle).mockResolvedValue(undefined)
  vi.mocked(tauri.cancelSuggestion).mockResolvedValue(true)
  // Controller now mutates `useEntryStore` directly with the persisted
  // entry, so the mock must resolve to a usable Entry shape.
  vi.mocked(tauri.updateEntry).mockResolvedValue(fakeEntry('e1', 'Final Title'))
  useTitleStreamStore.setState({ state: { kind: 'idle' } })
  useEntryStore.setState({ entries: [], isLoading: false, error: null })
})

afterEach(() => {
  useTitleStreamStore.setState({ state: { kind: 'idle' } })
  useEntryStore.setState({ entries: [], isLoading: false, error: null })
  vi.useRealTimers()
})

describe('useTitleStreamController', () => {
  it('flips store to streaming when start() is called', async () => {
    const { result } = renderHook(() => ({
      ctrl: useTitleStreamController(),
      api: useTitleStream(),
    }))
    await act(async () => {
      await result.current.api.start('e1')
    })
    expect(useTitleStreamStore.getState().state).toEqual({
      kind: 'streaming',
      entryId: 'e1',
      partial: '',
    })
    expect(tauri.suggestTitle).toHaveBeenCalledWith('e1')
  })

  it('accumulates token events into the store', async () => {
    const { result } = renderHook(() => ({
      ctrl: useTitleStreamController(),
      api: useTitleStream(),
    }))
    await act(async () => {
      await result.current.api.start('e1')
    })
    await act(async () => {
      emit('ai:suggest-title-token', { entry_id: 'e1', delta: 'My ' })
      emit('ai:suggest-title-token', { entry_id: 'e1', delta: 'Title' })
    })
    const s = useTitleStreamStore.getState().state
    expect(s.kind).toBe('streaming')
    expect(s.kind === 'streaming' && s.partial).toBe('My Title')
  })

  it('persists the final title via updateEntry on completion', async () => {
    const { result } = renderHook(() => ({
      ctrl: useTitleStreamController(),
      api: useTitleStream(),
    }))
    await act(async () => {
      await result.current.api.start('e1')
    })
    await act(async () => {
      emit('ai:suggest-title-complete', { entry_id: 'e1', title: 'Final Title' })
    })
    expect(useTitleStreamStore.getState().state).toEqual({
      kind: 'done',
      entryId: 'e1',
      title: 'Final Title',
    })
    await waitFor(() => {
      expect(tauri.updateEntry).toHaveBeenCalledWith('e1', 'Final Title')
    })
  })

  it('ignores token events for a different entry id', async () => {
    const { result } = renderHook(() => ({
      ctrl: useTitleStreamController(),
      api: useTitleStream(),
    }))
    await act(async () => {
      await result.current.api.start('e1')
    })
    await act(async () => {
      emit('ai:suggest-title-token', { entry_id: 'e2', delta: 'leak' })
    })
    const s = useTitleStreamStore.getState().state
    expect(s.kind === 'streaming' && s.partial).toBe('')
  })

  it('flips to error and falls back to legacy `error` field', async () => {
    const { result } = renderHook(() => ({
      ctrl: useTitleStreamController(),
      api: useTitleStream(),
    }))
    await act(async () => {
      await result.current.api.start('e1')
    })
    await act(async () => {
      emit('ai:suggest-title-error', { entry_id: 'e1', error: 'AI_AUTH_FAILED' })
    })
    expect(useTitleStreamStore.getState().state).toEqual({
      kind: 'error',
      entryId: 'e1',
      code: 'AI_AUTH_FAILED',
    })
  })

  it('cancels the prior in-flight stream when starting a new one', async () => {
    const { result } = renderHook(() => ({
      ctrl: useTitleStreamController(),
      api: useTitleStream(),
    }))
    await act(async () => {
      await result.current.api.start('e1')
    })
    await act(async () => {
      await result.current.api.start('e2')
    })
    expect(tauri.cancelSuggestion).toHaveBeenCalledWith('e1')
    expect(tauri.suggestTitle).toHaveBeenLastCalledWith('e2')
  })

  it('mutates the entry store with the persisted entry on completion', async () => {
    useEntryStore.setState({
      entries: [fakeEntry('e1', 'old')],
      isLoading: false,
      error: null,
    })
    vi.mocked(tauri.updateEntry).mockResolvedValue(fakeEntry('e1', 'Final'))
    const { result } = renderHook(() => ({
      ctrl: useTitleStreamController(),
      api: useTitleStream(),
    }))
    await act(async () => {
      await result.current.api.start('e1')
    })
    await act(async () => {
      emit('ai:suggest-title-complete', { entry_id: 'e1', title: 'Final' })
    })
    await waitFor(() => {
      expect(tauri.updateEntry).toHaveBeenCalledWith('e1', 'Final')
    })
    await waitFor(() => {
      const e = useEntryStore.getState().entries.find((x) => x.id === 'e1')
      expect(e?.title).toBe('Final')
    })
  })

  it('resets the store to idle 600 ms after completion', async () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => ({
      ctrl: useTitleStreamController(),
      api: useTitleStream(),
    }))
    await act(async () => {
      await result.current.api.start('e1')
    })
    await act(async () => {
      emit('ai:suggest-title-complete', { entry_id: 'e1', title: 'Final' })
    })
    expect(useTitleStreamStore.getState().state.kind).toBe('done')
    await act(async () => {
      vi.advanceTimersByTime(600)
    })
    expect(useTitleStreamStore.getState().state).toEqual({ kind: 'idle' })
  })

  it('resets to idle on the cancelled event', async () => {
    const { result } = renderHook(() => ({
      ctrl: useTitleStreamController(),
      api: useTitleStream(),
    }))
    await act(async () => {
      await result.current.api.start('e1')
    })
    await act(async () => {
      emit('ai:suggest-title-cancelled', { entry_id: 'e1' })
    })
    expect(useTitleStreamStore.getState().state).toEqual({ kind: 'idle' })
  })

  it('cancels in-flight stream and clears handle on unmount', async () => {
    const { result, unmount } = renderHook(() => ({
      ctrl: useTitleStreamController(),
      api: useTitleStream(),
    }))
    await act(async () => {
      await result.current.api.start('e1')
    })
    expect(Object.keys(handlers).length).toBeGreaterThan(0)
    unmount()
    expect(tauri.cancelSuggestion).toHaveBeenCalledWith('e1')
    // Listeners were torn down — emitting now must not throw or mutate state.
    useTitleStreamStore.setState({ state: { kind: 'idle' } })
    emit('ai:suggest-title-token', { entry_id: 'e1', delta: 'leak' })
    expect(useTitleStreamStore.getState().state).toEqual({ kind: 'idle' })
  })
})

describe('useTitleStream without controller mounted', () => {
  it('no-ops with a console warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { result } = renderHook(() => useTitleStream())
    await act(async () => {
      await result.current.start('e1')
    })
    expect(warn).toHaveBeenCalled()
    expect(tauri.suggestTitle).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})
