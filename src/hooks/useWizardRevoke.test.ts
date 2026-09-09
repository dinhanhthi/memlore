import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as tauri from '../lib/tauri'
import { useUiStore } from '../stores/uiStore'
import { useWizardRevoke } from './useWizardRevoke'

const { refreshSync } = vi.hoisted(() => ({
  refreshSync: vi.fn<() => Promise<void>>(),
}))

vi.mock('../lib/tauri', () => ({
  revokeDevice: vi.fn(),
  refreshDevicesFromCloud: vi.fn(),
}))

vi.mock('../stores/syncStore', () => ({
  useSyncStore: {
    getState: () => ({ refresh: refreshSync }),
  },
}))

const args = {
  deviceId: 'lost-device',
  password: '12345678',
  phrase: Array.from({ length: 24 }, (_, index) => `word-${index + 1}`).join(' '),
}

describe('useWizardRevoke', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    useUiStore.setState({ rotationBusy: false })
    vi.mocked(tauri.revokeDevice).mockResolvedValue(undefined)
    vi.mocked(tauri.refreshDevicesFromCloud).mockResolvedValue([])
    refreshSync.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('awaits revoke before refreshing and clears rotationBusy after success', async () => {
    const dispatchEvent = vi.spyOn(window, 'dispatchEvent')
    let finishRevoke!: () => void
    vi.mocked(tauri.revokeDevice).mockReturnValue(
      new Promise<void>((resolve) => {
        finishRevoke = resolve
      }),
    )
    const { result } = renderHook(() => useWizardRevoke())

    let runPromise!: Promise<void>
    act(() => {
      runPromise = result.current.run(args)
    })

    expect(useUiStore.getState().rotationBusy).toBe(true)
    expect(refreshSync).not.toHaveBeenCalled()
    expect(tauri.refreshDevicesFromCloud).not.toHaveBeenCalled()

    finishRevoke()
    await act(async () => {
      await runPromise
    })

    expect(result.current.status).toBe('done')
    expect(result.current.errorKey).toBeNull()
    expect(refreshSync).toHaveBeenCalledOnce()
    expect(tauri.refreshDevicesFromCloud).toHaveBeenCalledOnce()
    expect(dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'memlore:devices-changed' }),
    )
    expect(useUiStore.getState().rotationBusy).toBe(false)
  })

  it('clears rotationBusy and exposes an error when revoke rejects', async () => {
    const dispatchEvent = vi.spyOn(window, 'dispatchEvent')
    vi.mocked(tauri.revokeDevice).mockRejectedValue(new Error('rotation failed'))
    const { result } = renderHook(() => useWizardRevoke())

    await act(async () => {
      await result.current.run(args)
    })

    expect(result.current.status).toBe('error')
    expect(result.current.errorKey).toBe('settings:security.secure_wizard.errors.generic')
    expect(useUiStore.getState().rotationBusy).toBe(false)
    expect(refreshSync).not.toHaveBeenCalled()
    expect(tauri.refreshDevicesFromCloud).not.toHaveBeenCalled()
    expect(dispatchEvent).not.toHaveBeenCalled()
  })

  it('maps the exact sync_in_progress rejection to the dedicated error key', async () => {
    vi.mocked(tauri.revokeDevice).mockRejectedValue(new Error('sync_in_progress'))
    const { result } = renderHook(() => useWizardRevoke())

    await act(async () => {
      await result.current.run(args)
    })

    expect(result.current.status).toBe('error')
    expect(result.current.errorKey).toBe('settings:security.secure_wizard.errors.sync_in_progress')
    expect(useUiStore.getState().rotationBusy).toBe(false)
    expect(refreshSync).not.toHaveBeenCalled()
  })

  it('maps a bare-string sync_in_progress IPC reject to the dedicated error key', async () => {
    vi.mocked(tauri.revokeDevice).mockRejectedValue('sync_in_progress')
    const { result } = renderHook(() => useWizardRevoke())

    await act(async () => {
      await result.current.run(args)
    })

    expect(result.current.status).toBe('error')
    expect(result.current.errorKey).toBe('settings:security.secure_wizard.errors.sync_in_progress')
    expect(useUiStore.getState().rotationBusy).toBe(false)
    expect(refreshSync).not.toHaveBeenCalled()
  })

  it('keeps revoke successful and attempts every best-effort refresh when refreshes reject', async () => {
    const dispatchEvent = vi.spyOn(window, 'dispatchEvent')
    refreshSync.mockRejectedValue(new Error('Sync status unavailable'))
    vi.mocked(tauri.refreshDevicesFromCloud).mockRejectedValue(new Error('Drive unavailable'))
    const { result } = renderHook(() => useWizardRevoke())

    await act(async () => {
      await result.current.run(args)
    })

    expect(tauri.revokeDevice).toHaveBeenCalledOnce()
    expect(refreshSync).toHaveBeenCalledOnce()
    expect(tauri.refreshDevicesFromCloud).toHaveBeenCalledOnce()
    expect(result.current.status).toBe('done')
    expect(result.current.errorKey).toBeNull()
    expect(useUiStore.getState().rotationBusy).toBe(false)
    expect(dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'memlore:devices-changed' }),
    )
  })

  it('ignores a concurrent run while the first revoke is still running', async () => {
    let finishRevoke!: () => void
    vi.mocked(tauri.revokeDevice).mockReturnValue(
      new Promise<void>((resolve) => {
        finishRevoke = resolve
      }),
    )
    const { result } = renderHook(() => useWizardRevoke())

    let firstRun!: Promise<void>
    await act(async () => {
      firstRun = result.current.run(args)
      await result.current.run({ ...args, deviceId: 'second-device' })
    })

    expect(tauri.revokeDevice).toHaveBeenCalledOnce()
    expect(tauri.revokeDevice).toHaveBeenCalledWith(args.deviceId, args.password, args.phrase)

    finishRevoke()
    await act(async () => {
      await firstRun
    })

    await waitFor(() => expect(result.current.status).toBe('done'))
  })

  it('allows only the owning hook instance to run and release the global lock', async () => {
    let finishRevoke!: () => void
    vi.mocked(tauri.revokeDevice).mockReturnValue(
      new Promise<void>((resolve) => {
        finishRevoke = resolve
      }),
    )
    const first = renderHook(() => useWizardRevoke())
    const second = renderHook(() => useWizardRevoke())

    let firstRun!: Promise<void>
    let secondRun!: Promise<void>
    act(() => {
      firstRun = first.result.current.run(args)
      secondRun = second.result.current.run({ ...args, deviceId: 'second-device' })
    })

    await secondRun
    expect(tauri.revokeDevice).toHaveBeenCalledOnce()
    expect(second.result.current.status).toBe('idle')
    expect(useUiStore.getState().rotationBusy).toBe(true)

    finishRevoke()
    await act(async () => {
      await firstRun
    })

    expect(first.result.current.status).toBe('done')
    expect(useUiStore.getState().rotationBusy).toBe(false)
  })
})
