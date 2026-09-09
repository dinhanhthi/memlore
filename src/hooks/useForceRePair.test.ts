import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useForceRePair, useForceRePairStore } from './useForceRePair'

type Handler = (event: { payload: unknown }) => void
const handlers: Record<string, Handler> = {}

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, handler: Handler) => {
    handlers[name] = handler
    return () => {
      delete handlers[name]
    }
  }),
}))

vi.mock('../lib/tauri', () => ({
  getForceRePairStatus: vi.fn().mockResolvedValue(null),
  recheckForceRePair: vi.fn().mockResolvedValue(false),
}))

import * as tauri from '../lib/tauri'

const fireForceRePair = (reason: string) => {
  handlers['xj://force-re-pair']?.({ payload: { reason } })
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(tauri.getForceRePairStatus).mockResolvedValue(null)
  vi.mocked(tauri.recheckForceRePair).mockResolvedValue(false)
  for (const k of Object.keys(handlers)) delete handlers[k]
  // Reset Zustand store between tests
  useForceRePairStore.setState({ forceRePairRequired: false, reason: null })
})

describe('useForceRePair', () => {
  it('starts with forceRePairRequired false and reason null', () => {
    const { result } = renderHook(() => useForceRePair(true))
    expect(result.current.forceRePairRequired).toBe(false)
    expect(result.current.reason).toBeNull()
  })

  it('sets forceRePairRequired and reason when event fires', async () => {
    const { result } = renderHook(() => useForceRePair(true))
    await waitFor(() => expect(handlers['xj://force-re-pair']).toBeDefined())

    act(() => {
      fireForceRePair('epoch_mismatch')
    })

    expect(result.current.forceRePairRequired).toBe(true)
    expect(result.current.reason).toBe('epoch_mismatch')
  })

  it('does NOT run the silent recheck for event-driven triggers (fresh detections)', async () => {
    const { result } = renderHook(() => useForceRePair(true))
    await waitFor(() => expect(handlers['xj://force-re-pair']).toBeDefined())

    act(() => {
      fireForceRePair('vault_rotated')
    })

    expect(result.current.forceRePairRequired).toBe(true)
    expect(tauri.recheckForceRePair).not.toHaveBeenCalled()
  })

  it('captures the reason string from the event payload', async () => {
    const { result } = renderHook(() => useForceRePair(true))
    await waitFor(() => expect(handlers['xj://force-re-pair']).toBeDefined())

    act(() => {
      fireForceRePair('key_fingerprint_mismatch')
    })

    expect(result.current.reason).toBe('key_fingerprint_mismatch')
  })

  it('clears state after clearForceRePair() is called', async () => {
    const { result } = renderHook(() => useForceRePair(true))
    await waitFor(() => expect(handlers['xj://force-re-pair']).toBeDefined())

    act(() => {
      fireForceRePair('epoch_mismatch')
    })
    expect(result.current.forceRePairRequired).toBe(true)

    act(() => {
      result.current.clearForceRePair()
    })

    expect(result.current.forceRePairRequired).toBe(false)
    expect(result.current.reason).toBeNull()
  })

  it('removes event listener on unmount', async () => {
    const { unmount } = renderHook(() => useForceRePair(true))
    await waitFor(() => expect(handlers['xj://force-re-pair']).toBeDefined())

    unmount()

    expect(handlers['xj://force-re-pair']).toBeUndefined()
  })

  it('hydrates a persisted flag that survives the silent recheck', async () => {
    // Simulate the post-restart case: the backend persisted
    // force_re_pair_required=1 in the previous session AND the recheck
    // confirms the flag stands (genuine rotation).
    vi.mocked(tauri.getForceRePairStatus).mockResolvedValueOnce('vault_rotated_on_peer')
    vi.mocked(tauri.recheckForceRePair).mockResolvedValueOnce(false)

    const { result } = renderHook(() => useForceRePair(true))

    await waitFor(() => {
      expect(result.current.forceRePairRequired).toBe(true)
    })
    expect(result.current.reason).toBe('vault_rotated_on_peer')
    expect(tauri.getForceRePairStatus).toHaveBeenCalledOnce()
    expect(tauri.recheckForceRePair).toHaveBeenCalledOnce()
  })

  it('suppresses the screen when the silent recheck clears a stale flag', async () => {
    vi.mocked(tauri.getForceRePairStatus).mockResolvedValueOnce('keyring_check_inconclusive')
    vi.mocked(tauri.recheckForceRePair).mockResolvedValueOnce(true)

    const { result } = renderHook(() => useForceRePair(true))

    await waitFor(() => expect(tauri.recheckForceRePair).toHaveBeenCalledOnce())

    // The flag was stale and the backend cleared it — the screen never mounts.
    expect(result.current.forceRePairRequired).toBe(false)
    expect(result.current.reason).toBeNull()
  })

  it('fails closed (shows the screen) when the silent recheck rejects', async () => {
    vi.mocked(tauri.getForceRePairStatus).mockResolvedValueOnce('keyring_check_inconclusive')
    vi.mocked(tauri.recheckForceRePair).mockRejectedValueOnce('network down')

    const { result } = renderHook(() => useForceRePair(true))

    await waitFor(() => {
      expect(result.current.forceRePairRequired).toBe(true)
    })
    expect(result.current.reason).toBe('keyring_check_inconclusive')
  })

  it('re-hydrates when dbReady flips true (post-unlock connection swap)', async () => {
    // First mount: pre-unlock placeholder DB — flag reads as unset.
    vi.mocked(tauri.getForceRePairStatus).mockResolvedValueOnce(null)

    const { result, rerender } = renderHook(({ dbReady }) => useForceRePair(dbReady), {
      initialProps: { dbReady: false },
    })
    await waitFor(() => expect(tauri.getForceRePairStatus).toHaveBeenCalledOnce())
    expect(result.current.forceRePairRequired).toBe(false)

    // Unlock: real DB is swapped in and the persisted flag becomes visible.
    vi.mocked(tauri.getForceRePairStatus).mockResolvedValueOnce('vault_rotated')
    vi.mocked(tauri.recheckForceRePair).mockResolvedValueOnce(false)
    rerender({ dbReady: true })

    await waitFor(() => {
      expect(result.current.forceRePairRequired).toBe(true)
    })
    expect(result.current.reason).toBe('vault_rotated')
    expect(tauri.getForceRePairStatus).toHaveBeenCalledTimes(2)
  })

  it('keeps the event listener registered across dbReady flips (no missed-event gap)', async () => {
    const { result, rerender } = renderHook(({ dbReady }) => useForceRePair(dbReady), {
      initialProps: { dbReady: false },
    })
    await waitFor(() => expect(handlers['xj://force-re-pair']).toBeDefined())

    rerender({ dbReady: true })

    // The listener lives in a mount-only effect: it must still be registered
    // SYNCHRONOUSLY after the flip — a re-registering effect would leave an
    // async gap where a deferred reconcile's event is lost.
    expect(handlers['xj://force-re-pair']).toBeDefined()
    act(() => {
      fireForceRePair('vault_rotated')
    })
    expect(result.current.forceRePairRequired).toBe(true)
  })

  it('does not flip the flag on mount when the backend reports null', async () => {
    vi.mocked(tauri.getForceRePairStatus).mockResolvedValueOnce(null)

    const { result } = renderHook(() => useForceRePair(true))

    // Give the microtask a chance to settle.
    await waitFor(() => expect(tauri.getForceRePairStatus).toHaveBeenCalledOnce())

    expect(result.current.forceRePairRequired).toBe(false)
    expect(result.current.reason).toBeNull()
    expect(tauri.recheckForceRePair).not.toHaveBeenCalled()
  })

  it('store.setForceRePair() can be called imperatively', () => {
    const { result } = renderHook(() => useForceRePair(true))
    expect(result.current.forceRePairRequired).toBe(false)

    act(() => {
      useForceRePairStore.getState().setForceRePair('needs_re_pair_from_connect')
    })

    expect(result.current.forceRePairRequired).toBe(true)
    expect(result.current.reason).toBe('needs_re_pair_from_connect')
  })
})
