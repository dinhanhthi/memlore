import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useStaleForceRePairRecheck } from './useStaleForceRePairRecheck'

vi.mock('../lib/tauri', () => ({
  recheckForceRePair: vi.fn().mockResolvedValue(false),
}))

import * as tauri from '../lib/tauri'

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(tauri.recheckForceRePair).mockResolvedValue(false)
})

describe('useStaleForceRePairRecheck', () => {
  it('dismisses the screen when the backend clears a stale flag', async () => {
    vi.mocked(tauri.recheckForceRePair).mockResolvedValue(true)
    const onCleared = vi.fn()

    renderHook(() => useStaleForceRePairRecheck(onCleared))

    await waitFor(() => expect(onCleared).toHaveBeenCalledTimes(1))
  })

  it('keeps the screen up when the flag stands', async () => {
    const onCleared = vi.fn()

    renderHook(() => useStaleForceRePairRecheck(onCleared))

    await waitFor(() => expect(tauri.recheckForceRePair).toHaveBeenCalled())
    expect(onCleared).not.toHaveBeenCalled()
  })

  it('fails closed and keeps the screen up when the recheck throws', async () => {
    vi.mocked(tauri.recheckForceRePair).mockRejectedValue('drive unreachable')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const onCleared = vi.fn()

    renderHook(() => useStaleForceRePairRecheck(onCleared))

    await waitFor(() => expect(tauri.recheckForceRePair).toHaveBeenCalled())
    expect(onCleared).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  // The callback identity changes on every render of a screen that defines it
  // inline. If it were an effect dep, the recheck would re-fire in a loop.
  it('rechecks once even when the callback identity changes', async () => {
    const { rerender } = renderHook(({ cb }) => useStaleForceRePairRecheck(cb), {
      initialProps: { cb: vi.fn() },
    })

    await waitFor(() => expect(tauri.recheckForceRePair).toHaveBeenCalledTimes(1))
    rerender({ cb: vi.fn() })
    rerender({ cb: vi.fn() })

    expect(tauri.recheckForceRePair).toHaveBeenCalledTimes(1)
  })

  it('does not dismiss after unmount', async () => {
    let resolve!: (v: boolean) => void
    vi.mocked(tauri.recheckForceRePair).mockReturnValue(
      new Promise<boolean>((r) => {
        resolve = r
      }),
    )
    const onCleared = vi.fn()

    const { unmount } = renderHook(() => useStaleForceRePairRecheck(onCleared))
    unmount()
    resolve(true)

    await new Promise((r) => setTimeout(r, 0))
    expect(onCleared).not.toHaveBeenCalled()
  })
})
