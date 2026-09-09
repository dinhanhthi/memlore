import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseSyncCatchupIncompleteError, useSyncCatchup } from './useSyncCatchup'

type CatchupProgressEvent = {
  pulled: number
  total: number
  peerDeviceId?: string
}

type Handler = (event: { payload: CatchupProgressEvent }) => void
const handlers: Record<string, Handler> = {}
const { invoke, listen, unlisten } = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  unlisten: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke }))

vi.mock('@tauri-apps/api/event', () => ({
  listen: (name: string, handler: Handler) => listen(name, handler),
}))

beforeEach(() => {
  listen.mockImplementation(async (name: string, handler: Handler) => {
    handlers[name] = handler
    return unlisten
  })
})

const fireProgress = (payload: CatchupProgressEvent) => {
  handlers['sync:catchup-progress']?.({ payload })
}

beforeEach(() => {
  vi.clearAllMocks()
  for (const name of Object.keys(handlers)) delete handlers[name]
  invoke.mockResolvedValue({ complete: false, pulled: 0, total: 0 })
})

describe('useSyncCatchup', () => {
  it('parses the exact export catch-up sentinel into progress counts', () => {
    expect(parseSyncCatchupIncompleteError('SYNC_CATCHUP_INCOMPLETE: pulled=3 total=10')).toEqual({
      pulled: 3,
      total: 10,
    })
  })

  it('rejects generic and malformed export errors', () => {
    expect(parseSyncCatchupIncompleteError('export failed')).toBeNull()
    expect(
      parseSyncCatchupIncompleteError('SYNC_CATCHUP_INCOMPLETE: pulled=3 total=10 extra'),
    ).toBeNull()
  })

  it('reads the initial catch-up status', async () => {
    invoke.mockResolvedValue({ complete: false, pulled: 3, total: 10 })

    const { result } = renderHook(() => useSyncCatchup())

    await waitFor(() => expect(result.current.pulled).toBe(3))
    expect(result.current).toMatchObject({ complete: false, pulled: 3, total: 10 })
    expect(invoke).toHaveBeenCalledWith('get_sync_catchup_status')
  })

  it('updates pulled and total from catch-up progress events', async () => {
    const { result } = renderHook(() => useSyncCatchup())
    await waitFor(() => expect(handlers['sync:catchup-progress']).toBeDefined())

    act(() => {
      fireProgress({ pulled: 4, total: 10, peerDeviceId: 'peer-1' })
    })

    expect(result.current).toMatchObject({ complete: false, pulled: 4, total: 10 })
  })

  it('marks catch-up complete only on the terminal progress event', async () => {
    const { result } = renderHook(() => useSyncCatchup())
    await waitFor(() => expect(handlers['sync:catchup-progress']).toBeDefined())

    act(() => {
      fireProgress({ pulled: 10, total: 10, peerDeviceId: 'peer-1' })
    })

    expect(result.current).toMatchObject({ complete: false, pulled: 10, total: 10 })

    act(() => {
      fireProgress({ pulled: 10, total: 10 })
    })

    expect(result.current).toMatchObject({ complete: true, pulled: 10, total: 10 })
  })

  it('subscribes before reading the snapshot so a delayed listener cannot miss terminal progress', async () => {
    let resolveListen: ((unlistenFn: () => void) => void) | undefined
    listen.mockImplementation(
      (name: string, handler: Handler) =>
        new Promise<() => void>((resolve) => {
          resolveListen = (unlistenFn) => {
            handlers[name] = handler
            resolve(unlistenFn)
          }
        }),
    )

    const { result } = renderHook(() => useSyncCatchup())

    expect(invoke).not.toHaveBeenCalled()

    act(() => {
      resolveListen?.(unlisten)
    })
    await waitFor(() => expect(handlers['sync:catchup-progress']).toBeDefined())

    act(() => {
      fireProgress({ pulled: 4, total: 4 })
    })

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('get_sync_catchup_status'))
    expect(result.current).toMatchObject({ complete: true, pulled: 4, total: 4 })
  })

  it('falls back to the snapshot when subscribing to progress events fails', async () => {
    listen.mockRejectedValueOnce(new Error('event bridge unavailable'))
    invoke.mockResolvedValue({ complete: true, pulled: 4, total: 4 })

    const { result } = renderHook(() => useSyncCatchup())

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('get_sync_catchup_status'))
    expect(result.current).toMatchObject({ complete: true, pulled: 4, total: 4 })
  })

  it('unsubscribes from progress events on unmount', async () => {
    const { unmount } = renderHook(() => useSyncCatchup())
    await waitFor(() => expect(handlers['sync:catchup-progress']).toBeDefined())

    unmount()

    expect(unlisten).toHaveBeenCalledOnce()
  })
})
