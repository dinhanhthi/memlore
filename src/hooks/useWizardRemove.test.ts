import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as tauri from '../lib/tauri'
import { useUiStore } from '../stores/uiStore'
import { useWizardRemove } from './useWizardRemove'

vi.mock('../lib/tauri', () => ({
  removeDevice: vi.fn(),
  refreshDevicesFromCloud: vi.fn(),
}))

describe('useWizardRemove', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(tauri.removeDevice).mockResolvedValue(undefined)
    vi.mocked(tauri.refreshDevicesFromCloud).mockResolvedValue([])
    useUiStore.getState().setDeviceRemovalBusy(false)
    useUiStore.getState().setDeviceRemovalOutcome(null)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('awaits removal before refreshing and reports done', async () => {
    const dispatchEvent = vi.spyOn(window, 'dispatchEvent')
    let finishRemove!: () => void
    vi.mocked(tauri.removeDevice).mockReturnValue(
      new Promise<void>((resolve) => {
        finishRemove = resolve
      }),
    )
    const { result } = renderHook(() => useWizardRemove())

    let runPromise!: Promise<void>
    act(() => {
      runPromise = result.current.run('old-phone')
    })

    expect(tauri.refreshDevicesFromCloud).not.toHaveBeenCalled()

    finishRemove()
    await act(async () => {
      await runPromise
    })

    expect(tauri.removeDevice).toHaveBeenCalledWith('old-phone')
    expect(result.current.status).toBe('done')
    expect(result.current.errorKey).toBeNull()
    expect(tauri.refreshDevicesFromCloud).toHaveBeenCalledOnce()
    expect(dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'memlore:devices-changed' }),
    )
  })

  it('exposes an error and skips refreshes when removal rejects', async () => {
    const dispatchEvent = vi.spyOn(window, 'dispatchEvent')
    vi.mocked(tauri.removeDevice).mockRejectedValue(new Error('slot delete failed'))
    const { result } = renderHook(() => useWizardRemove())

    await act(async () => {
      await result.current.run('old-phone')
    })

    expect(result.current.status).toBe('error')
    expect(result.current.errorKey).toBe('settings:security.secure_wizard.errors.generic')
    expect(tauri.refreshDevicesFromCloud).not.toHaveBeenCalled()
    expect(dispatchEvent).not.toHaveBeenCalled()
  })

  it('keeps the removal successful when the best-effort refresh rejects', async () => {
    const dispatchEvent = vi.spyOn(window, 'dispatchEvent')
    vi.mocked(tauri.refreshDevicesFromCloud).mockRejectedValue(new Error('Drive unavailable'))
    const { result } = renderHook(() => useWizardRemove())

    await act(async () => {
      await result.current.run('old-phone')
    })

    expect(result.current.status).toBe('done')
    expect(result.current.errorKey).toBeNull()
    expect(dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'memlore:devices-changed' }),
    )
  })

  it('keeps the footer busy flag on across unmount and clears it when the call settles', async () => {
    let finishRemove!: () => void
    vi.mocked(tauri.removeDevice).mockReturnValue(
      new Promise<void>((resolve) => {
        finishRemove = resolve
      }),
    )
    const { result, unmount } = renderHook(() => useWizardRemove())

    let runPromise!: Promise<void>
    act(() => {
      runPromise = result.current.run('old-phone')
    })
    expect(useUiStore.getState().deviceRemovalBusy).toBe(true)

    // The wizard may close while the removal is still queued behind a sync —
    // the footer flag must survive the unmount and clear on settle.
    unmount()
    expect(useUiStore.getState().deviceRemovalBusy).toBe(true)

    finishRemove()
    await act(async () => {
      await runPromise
    })
    expect(useUiStore.getState().deviceRemovalBusy).toBe(false)
  })

  it('records an ok outcome when removal succeeds', async () => {
    const { result } = renderHook(() => useWizardRemove())

    await act(async () => {
      await result.current.run('old-phone')
    })

    expect(useUiStore.getState().deviceRemovalOutcome).toBe('ok')
  })

  it('records an error outcome when removal rejects', async () => {
    vi.mocked(tauri.removeDevice).mockRejectedValue(new Error('acquire_waiting timed out'))
    const { result } = renderHook(() => useWizardRemove())

    await act(async () => {
      await result.current.run('old-phone')
    })

    expect(useUiStore.getState().deviceRemovalOutcome).toBe('error')
  })

  it('records the outcome after unmount when the removal settles', async () => {
    let finishRemove!: () => void
    vi.mocked(tauri.removeDevice).mockReturnValue(
      new Promise<void>((resolve) => {
        finishRemove = resolve
      }),
    )
    const { result, unmount } = renderHook(() => useWizardRemove())

    let runPromise!: Promise<void>
    act(() => {
      runPromise = result.current.run('old-phone')
    })
    unmount()

    finishRemove()
    await act(async () => {
      await runPromise
    })

    expect(useUiStore.getState().deviceRemovalBusy).toBe(false)
    expect(useUiStore.getState().deviceRemovalOutcome).toBe('ok')
  })

  it('clears a previous outcome when a new removal starts', async () => {
    useUiStore.getState().setDeviceRemovalOutcome('error')
    let finishRemove!: () => void
    vi.mocked(tauri.removeDevice).mockReturnValue(
      new Promise<void>((resolve) => {
        finishRemove = resolve
      }),
    )
    const { result } = renderHook(() => useWizardRemove())

    let runPromise!: Promise<void>
    act(() => {
      runPromise = result.current.run('old-phone')
    })

    expect(useUiStore.getState().deviceRemovalOutcome).toBeNull()

    finishRemove()
    await act(async () => {
      await runPromise
    })
  })

  it('clears the footer busy flag when the removal rejects', async () => {
    vi.mocked(tauri.removeDevice).mockRejectedValue(new Error('slot delete failed'))
    const { result } = renderHook(() => useWizardRemove())

    await act(async () => {
      await result.current.run('old-phone')
    })

    expect(result.current.status).toBe('error')
    expect(useUiStore.getState().deviceRemovalBusy).toBe(false)
  })

  it('ignores a concurrent run while the first removal is still running', async () => {
    let finishRemove!: () => void
    vi.mocked(tauri.removeDevice).mockReturnValue(
      new Promise<void>((resolve) => {
        finishRemove = resolve
      }),
    )
    const { result } = renderHook(() => useWizardRemove())

    let firstRun!: Promise<void>
    await act(async () => {
      firstRun = result.current.run('old-phone')
      await result.current.run('second-device')
    })

    expect(tauri.removeDevice).toHaveBeenCalledOnce()
    expect(tauri.removeDevice).toHaveBeenCalledWith('old-phone')

    finishRemove()
    await act(async () => {
      await firstRun
    })

    await waitFor(() => expect(result.current.status).toBe('done'))
  })
})
