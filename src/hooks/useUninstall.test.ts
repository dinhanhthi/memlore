/**
 * Tests for `useUninstall`.
 *
 * Project rule: never call the real backend — the `../lib/tauri` wrappers are
 * mocked. `uninstallApp` is genuinely destructive, so the mock is the only
 * thing standing between this suite and the developer's own vault.
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as TauriModule from '../lib/tauri'
import type { UninstallPreview } from '../lib/tauri'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

vi.mock('../lib/tauri', async () => {
  const actual = await vi.importActual<typeof TauriModule>('../lib/tauri')
  return { ...actual, uninstallPreview: vi.fn(), uninstallApp: vi.fn() }
})

import * as tauri from '../lib/tauri'
import { useUninstall } from './useUninstall'

const PREVIEW: UninstallPreview = {
  paths: [
    '/Users/tester/Library/Application Support/app.memlore',
    '/Users/tester/Library/Caches/app.memlore',
  ],
  skipped: [],
  totalBytes: 1_234_567,
  appPath: '/Applications/Memlore.app',
  appRemovable: true,
  platform: 'macos',
}

describe('useUninstall', () => {
  beforeEach(() => {
    vi.mocked(tauri.uninstallPreview).mockReset()
    vi.mocked(tauri.uninstallApp).mockReset()
  })

  // Unconditional: an assertion that throws inside a fake-timer test would
  // otherwise leak fake timers into every later file in this worker.
  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not touch the backend until load() is called', () => {
    renderHook(() => useUninstall())
    expect(tauri.uninstallPreview).not.toHaveBeenCalled()
    expect(tauri.uninstallApp).not.toHaveBeenCalled()
  })

  it('exposes the preview after load()', async () => {
    vi.mocked(tauri.uninstallPreview).mockResolvedValue(PREVIEW)
    const { result } = renderHook(() => useUninstall())

    await act(async () => {
      await result.current.load()
    })

    expect(result.current.preview).toEqual(PREVIEW)
    expect(result.current.loading).toBe(false)
    expect(result.current.error).toBeNull()
  })

  it('surfaces a preview failure and leaves preview null', async () => {
    vi.mocked(tauri.uninstallPreview).mockRejectedValue('uninstall: failed to resolve home dir')
    const { result } = renderHook(() => useUninstall())

    await act(async () => {
      await result.current.load()
    })

    expect(result.current.preview).toBeNull()
    expect(result.current.error).toContain('failed to resolve home dir')
    expect(result.current.loading).toBe(false)
  })

  it('forwards the remove-bundle flag verbatim', async () => {
    vi.mocked(tauri.uninstallApp).mockResolvedValue(undefined)
    const { result } = renderHook(() => useUninstall())

    await act(async () => {
      await result.current.run(true)
    })
    expect(tauri.uninstallApp).toHaveBeenLastCalledWith(true)

    await act(async () => {
      await result.current.run(false)
    })
    expect(tauri.uninstallApp).toHaveBeenLastCalledWith(false)
  })

  it('stays in the running state while the app tears itself down', async () => {
    // Happy path never resolves — the backend exits the process mid-promise.
    vi.mocked(tauri.uninstallApp).mockReturnValue(new Promise<void>(() => {}))
    const { result } = renderHook(() => useUninstall())

    act(() => {
      void result.current.run(true)
    })

    await waitFor(() => expect(result.current.running).toBe(true))
    expect(result.current.error).toBeNull()
  })

  it('does not flag a stall while the app is quitting normally', async () => {
    vi.useFakeTimers()
    vi.mocked(tauri.uninstallApp).mockReturnValue(new Promise<void>(() => {}))
    const { result } = renderHook(() => useUninstall())

    act(() => {
      void result.current.run(true)
    })
    act(() => {
      vi.advanceTimersByTime(9_000)
    })

    expect(result.current.stalled).toBe(false)
  })

  it('flags a stall when the app fails to quit, so the modal can release the user', async () => {
    vi.useFakeTimers()
    vi.mocked(tauri.uninstallApp).mockReturnValue(new Promise<void>(() => {}))
    const { result } = renderHook(() => useUninstall())

    act(() => {
      void result.current.run(true)
    })
    act(() => {
      vi.advanceTimersByTime(10_000)
    })

    expect(result.current.stalled).toBe(true)
    expect(result.current.running).toBe(true)
  })

  it('cancels the stall watchdog when the backend refuses', async () => {
    vi.useFakeTimers()
    // The native OS confirmation being dismissed lands here.
    vi.mocked(tauri.uninstallApp).mockRejectedValue('uninstall: cancelled')
    const { result } = renderHook(() => useUninstall())

    await act(async () => {
      await result.current.run(true)
    })
    act(() => {
      vi.advanceTimersByTime(30_000)
    })

    expect(result.current.stalled).toBe(false)
    expect(result.current.running).toBe(false)
    expect(result.current.error).toContain('cancelled')
  })

  it('surfaces skipped paths so an incomplete wipe is visible', async () => {
    const partial: UninstallPreview = {
      ...PREVIEW,
      skipped: ['/data-volume/app.memlore'],
    }
    vi.mocked(tauri.uninstallPreview).mockResolvedValue(partial)
    const { result } = renderHook(() => useUninstall())

    await act(async () => {
      await result.current.load()
    })

    expect(result.current.preview?.skipped).toEqual(['/data-volume/app.memlore'])
  })

  it('clears running and reports the reason when the backend refuses', async () => {
    vi.mocked(tauri.uninstallApp).mockRejectedValue('uninstall: nothing to remove')
    const { result } = renderHook(() => useUninstall())

    await act(async () => {
      await result.current.run(true)
    })

    expect(result.current.running).toBe(false)
    expect(result.current.error).toContain('nothing to remove')
  })

  it('keeps a stale error from masking a later successful load', async () => {
    vi.mocked(tauri.uninstallPreview).mockRejectedValueOnce('boom').mockResolvedValue(PREVIEW)
    const { result } = renderHook(() => useUninstall())

    await act(async () => {
      await result.current.load()
    })
    expect(result.current.error).toContain('boom')

    await act(async () => {
      await result.current.load()
    })
    expect(result.current.error).toBeNull()
    expect(result.current.preview).toEqual(PREVIEW)
  })
})
