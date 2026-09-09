import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { useDeviceList } from './useDeviceList'
import * as tauri from '../lib/tauri'
import type { DeviceInfo } from '../lib/tauri'
import { useUiStore } from '../stores/uiStore'

vi.mock('../lib/tauri', () => ({
  listDevices: vi.fn(),
  renameDevice: vi.fn(),
  refreshDevicesFromCloud: vi.fn(),
}))

const makeDevice = (overrides: Partial<DeviceInfo> = {}): DeviceInfo => ({
  device_id: 'dev-1',
  name: 'MacBook Pro',
  created_at: 1_700_000_000,
  last_seen_at: 1_700_000_100,
  is_current: true,
  is_revoked: false,
  ...overrides,
})

describe('useDeviceList', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    useUiStore.setState({ rotationBusy: false, deviceRenameBusy: false })
    // Default: mount's one-time cloud fetch is a harmless no-op unless a test
    // overrides it. Mirrors listDevices returning the same rows.
    vi.mocked(tauri.refreshDevicesFromCloud).mockResolvedValue([])
    vi.mocked(tauri.listDevices).mockResolvedValue([])
  })

  // ─── Mount ──────────────────────────────────────────────────────────────────

  it('loads devices from local DB on mount', async () => {
    const device = makeDevice()
    vi.mocked(tauri.listDevices).mockResolvedValue([device])
    vi.mocked(tauri.refreshDevicesFromCloud).mockResolvedValue([device])

    const { result } = renderHook(() => useDeviceList())

    // Initial loading state.
    expect(result.current.loading).toBe(true)

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.devices).toEqual([device])
    expect(result.current.error).toBeNull()
    expect(tauri.listDevices).toHaveBeenCalledOnce()
  })

  it('fetches from cloud once on mount (so new peers appear on tab open)', async () => {
    const local = makeDevice({ name: 'Local' })
    const cloudPeer = makeDevice({ device_id: 'dev-2', name: 'iPhone', is_current: false })
    vi.mocked(tauri.listDevices).mockResolvedValue([local])
    vi.mocked(tauri.refreshDevicesFromCloud).mockResolvedValue([local, cloudPeer])

    const { result } = renderHook(() => useDeviceList())

    await waitFor(() => expect(tauri.refreshDevicesFromCloud).toHaveBeenCalledOnce())
    await waitFor(() => expect(result.current.devices).toEqual([local, cloudPeer]))
  })

  it('auto-refreshes from cloud when a sync completes (devices-changed event)', async () => {
    const local = makeDevice({ name: 'Local', last_seen_at: 1_700_000_100 })
    const synced = makeDevice({ name: 'Local', last_seen_at: 1_700_009_999 })
    vi.mocked(tauri.listDevices).mockResolvedValue([local])
    // First call (mount) returns local; later calls return the freshly-synced row.
    vi.mocked(tauri.refreshDevicesFromCloud)
      .mockResolvedValueOnce([local])
      .mockResolvedValue([synced])

    const { result } = renderHook(() => useDeviceList())
    await waitFor(() => expect(tauri.refreshDevicesFromCloud).toHaveBeenCalledOnce())

    act(() => {
      window.dispatchEvent(new CustomEvent('memlore:devices-changed'))
    })

    await waitFor(() => expect(tauri.refreshDevicesFromCloud).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(result.current.devices).toEqual([synced]))
  })

  it('treats null API responses as an empty device list', async () => {
    vi.mocked(tauri.listDevices).mockResolvedValue(null as unknown as DeviceInfo[])
    vi.mocked(tauri.refreshDevicesFromCloud).mockResolvedValue(null as unknown as DeviceInfo[])

    const { result } = renderHook(() => useDeviceList())
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.devices).toEqual([])
    expect(result.current.error).toBeNull()
  })

  it('sets error when listDevices throws', async () => {
    vi.mocked(tauri.listDevices).mockRejectedValue(new Error('DB locked'))
    // Mount's follow-up cloud fetch also fails (no Drive in this scenario);
    // the local error is what the user sees first.
    vi.mocked(tauri.refreshDevicesFromCloud).mockRejectedValue(new Error('DB locked'))

    const { result } = renderHook(() => useDeviceList())
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.error).toBe('DB locked')
    expect(result.current.devices).toEqual([])
  })

  it('mount cloud fetch is silent — a non-GDrive failure does not set an error', async () => {
    const local = makeDevice()
    vi.mocked(tauri.listDevices).mockResolvedValue([local])
    // Drive not the active provider — cloud fetch rejects, but it's silent.
    vi.mocked(tauri.refreshDevicesFromCloud).mockRejectedValue(
      new Error('Google Drive is not connected on this device'),
    )

    const { result } = renderHook(() => useDeviceList())
    await waitFor(() => expect(result.current.loading).toBe(false))
    await waitFor(() => expect(tauri.refreshDevicesFromCloud).toHaveBeenCalledOnce())

    // Local rows still painted; no spurious error banner.
    expect(result.current.devices).toEqual([local])
    expect(result.current.error).toBeNull()
  })

  // ─── Refresh ─────────────────────────────────────────────────────────────────

  it('refresh calls refreshDevicesFromCloud and updates devices', async () => {
    const localDevice = makeDevice({ name: 'Old Name' })
    const cloudDevice = makeDevice({ name: 'New Name' })
    const secondDevice = makeDevice({ device_id: 'dev-2', name: 'iPhone', is_current: false })

    vi.mocked(tauri.listDevices).mockResolvedValue([localDevice])
    vi.mocked(tauri.refreshDevicesFromCloud).mockResolvedValue([cloudDevice, secondDevice])

    const { result } = renderHook(() => useDeviceList())
    await waitFor(() => expect(result.current.loading).toBe(false))
    // Wait for the mount-time cloud fetch to settle (1st call) before the
    // explicit refresh below (2nd call).
    await waitFor(() => expect(tauri.refreshDevicesFromCloud).toHaveBeenCalledOnce())

    await act(async () => {
      await result.current.refresh()
    })

    expect(tauri.refreshDevicesFromCloud).toHaveBeenCalledTimes(2)
    expect(result.current.devices).toEqual([cloudDevice, secondDevice])
    expect(result.current.loading).toBe(false)
    expect(result.current.error).toBeNull()
  })

  it('refresh sets error when refreshDevicesFromCloud throws', async () => {
    vi.mocked(tauri.listDevices).mockResolvedValue([makeDevice()])
    vi.mocked(tauri.refreshDevicesFromCloud).mockRejectedValue(
      new Error('Google Drive session not active'),
    )

    const { result } = renderHook(() => useDeviceList())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.refresh()
    })

    expect(result.current.error).toBe('Google Drive session not active')
    expect(result.current.loading).toBe(false)
  })

  // ─── Rename ──────────────────────────────────────────────────────────────────

  it('rename calls renameDevice and updates local state optimistically', async () => {
    const device = makeDevice({ device_id: 'dev-1', name: 'Old Name' })
    vi.mocked(tauri.listDevices).mockResolvedValue([device])
    vi.mocked(tauri.refreshDevicesFromCloud).mockResolvedValue([device])
    vi.mocked(tauri.renameDevice).mockResolvedValue(undefined)

    const { result } = renderHook(() => useDeviceList())
    await waitFor(() => expect(result.current.loading).toBe(false))
    await waitFor(() => expect(result.current.devices).toEqual([device]))

    await act(async () => {
      await result.current.rename('dev-1', 'New Name')
    })

    expect(tauri.renameDevice).toHaveBeenCalledWith('dev-1', 'New Name')
    expect(result.current.devices[0].name).toBe('New Name')
  })

  it('rename updates the local name before renameDevice resolves', async () => {
    const device = makeDevice({ device_id: 'dev-1', name: 'Old Name' })
    vi.mocked(tauri.listDevices).mockResolvedValue([device])
    vi.mocked(tauri.refreshDevicesFromCloud).mockResolvedValue([device])

    let resolveRename!: () => void
    vi.mocked(tauri.renameDevice).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveRename = resolve
        }),
    )

    const { result } = renderHook(() => useDeviceList())
    await waitFor(() => expect(result.current.loading).toBe(false))
    await waitFor(() => expect(result.current.devices).toEqual([device]))

    let renameDone = false
    act(() => {
      void result.current.rename('dev-1', 'New Name').then(() => {
        renameDone = true
      })
    })

    await waitFor(() => expect(result.current.devices[0].name).toBe('New Name'))
    expect(useUiStore.getState().deviceRenameBusy).toBe(true)
    expect(renameDone).toBe(false)

    await act(async () => {
      resolveRename()
    })
    await waitFor(() => expect(renameDone).toBe(true))
    expect(useUiStore.getState().deviceRenameBusy).toBe(false)
  })

  it('rename sets deviceRenameBusy true while in flight and clears it when done', async () => {
    const device = makeDevice({ device_id: 'dev-1', name: 'Old Name' })
    vi.mocked(tauri.listDevices).mockResolvedValue([device])
    vi.mocked(tauri.refreshDevicesFromCloud).mockResolvedValue([device])

    let resolveRename!: () => void
    vi.mocked(tauri.renameDevice).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveRename = resolve
        }),
    )

    const { result } = renderHook(() => useDeviceList())
    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() => {
      void result.current.rename('dev-1', 'New Name')
    })

    await waitFor(() => expect(useUiStore.getState().deviceRenameBusy).toBe(true))

    await act(async () => {
      resolveRename()
    })
    await waitFor(() => expect(useUiStore.getState().deviceRenameBusy).toBe(false))
  })

  it('rename reverts the optimistic name and sets error when renameDevice throws', async () => {
    const device = makeDevice({ device_id: 'dev-1', name: 'Old Name' })
    vi.mocked(tauri.listDevices).mockResolvedValue([device])
    vi.mocked(tauri.refreshDevicesFromCloud).mockResolvedValue([device])
    vi.mocked(tauri.renameDevice).mockRejectedValue(new Error('DB write failed'))

    const { result } = renderHook(() => useDeviceList())
    await waitFor(() => expect(result.current.loading).toBe(false))
    await waitFor(() => expect(result.current.devices).toEqual([device]))

    await act(async () => {
      await result.current.rename('dev-1', 'New Name')
    })

    expect(result.current.devices[0].name).toBe('Old Name')
    expect(result.current.error).toBe('DB write failed')
    expect(useUiStore.getState().deviceRenameBusy).toBe(false)
  })

  it('rename is a no-op when deviceRenameBusy is already true', async () => {
    const device = makeDevice({ device_id: 'dev-1', name: 'Old Name' })
    vi.mocked(tauri.listDevices).mockResolvedValue([device])
    vi.mocked(tauri.refreshDevicesFromCloud).mockResolvedValue([device])

    useUiStore.setState({ deviceRenameBusy: true })

    const { result } = renderHook(() => useDeviceList())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.rename('dev-1', 'New Name')
    })

    expect(tauri.renameDevice).not.toHaveBeenCalled()
    expect(result.current.devices[0].name).toBe('Old Name')
  })

  it('rename is a no-op when rotationBusy is true', async () => {
    const device = makeDevice({ device_id: 'dev-1', name: 'Old Name' })
    vi.mocked(tauri.listDevices).mockResolvedValue([device])
    vi.mocked(tauri.refreshDevicesFromCloud).mockResolvedValue([device])

    useUiStore.setState({ rotationBusy: true })

    const { result } = renderHook(() => useDeviceList())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.rename('dev-1', 'New Name')
    })

    expect(tauri.renameDevice).not.toHaveBeenCalled()
    expect(result.current.devices[0].name).toBe('Old Name')
  })

  it('rename is a no-op for a second device while another rename is in flight', async () => {
    const devices = [
      makeDevice({ device_id: 'dev-1', name: 'One' }),
      makeDevice({ device_id: 'dev-2', name: 'Two', is_current: false }),
    ]
    vi.mocked(tauri.listDevices).mockResolvedValue(devices)
    vi.mocked(tauri.refreshDevicesFromCloud).mockResolvedValue(devices)

    let resolveFirst!: () => void
    vi.mocked(tauri.renameDevice).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveFirst = resolve
        }),
    )

    const { result } = renderHook(() => useDeviceList())
    await waitFor(() => expect(result.current.loading).toBe(false))
    await waitFor(() => expect(result.current.devices).toHaveLength(2))

    act(() => {
      void result.current.rename('dev-1', 'One Renamed')
    })
    await waitFor(() => expect(useUiStore.getState().deviceRenameBusy).toBe(true))

    await act(async () => {
      await result.current.rename('dev-2', 'Two Renamed')
    })

    expect(tauri.renameDevice).toHaveBeenCalledTimes(1)
    expect(tauri.renameDevice).toHaveBeenCalledWith('dev-1', 'One Renamed')
    expect(result.current.devices.find((d) => d.device_id === 'dev-2')?.name).toBe('Two')

    await act(async () => {
      resolveFirst()
    })
    await waitFor(() => expect(useUiStore.getState().deviceRenameBusy).toBe(false))
  })

  it('rename clears a previous error when a new rename starts', async () => {
    const device = makeDevice({ device_id: 'dev-1', name: 'Old Name' })
    vi.mocked(tauri.listDevices).mockResolvedValue([device])
    vi.mocked(tauri.refreshDevicesFromCloud).mockResolvedValue([device])
    vi.mocked(tauri.renameDevice)
      .mockRejectedValueOnce(new Error('first fail'))
      .mockResolvedValueOnce(undefined)

    const { result } = renderHook(() => useDeviceList())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.rename('dev-1', 'Bad Name')
    })
    expect(result.current.error).toBe('first fail')

    await act(async () => {
      await result.current.rename('dev-1', 'Good Name')
    })
    expect(result.current.error).toBeNull()
    expect(result.current.devices[0].name).toBe('Good Name')
  })

  // ─── Active flag (Devices tab visibility) ──────────────────────────────────

  it('paints local devices when inactive and does not fetch from cloud', async () => {
    const local = makeDevice({ name: 'Local' })
    const cloudPeer = makeDevice({ device_id: 'dev-2', name: 'iPhone', is_current: false })
    vi.mocked(tauri.listDevices).mockResolvedValue([local])
    vi.mocked(tauri.refreshDevicesFromCloud).mockResolvedValue([local, cloudPeer])

    const { result } = renderHook(() => useDeviceList({ active: false }))

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.devices).toEqual([local])
    expect(tauri.listDevices).toHaveBeenCalledOnce()
    expect(tauri.refreshDevicesFromCloud).not.toHaveBeenCalled()
  })

  it('silent-refreshes from cloud when active flips false → true', async () => {
    const local = makeDevice({ name: 'Local' })
    const cloudPeer = makeDevice({ device_id: 'dev-2', name: 'iPhone', is_current: false })
    vi.mocked(tauri.listDevices).mockResolvedValue([local])
    vi.mocked(tauri.refreshDevicesFromCloud).mockResolvedValue([local, cloudPeer])

    const { result, rerender } = renderHook(
      ({ active }: { active: boolean }) => useDeviceList({ active }),
      { initialProps: { active: false } },
    )

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.devices).toEqual([local])
    expect(tauri.refreshDevicesFromCloud).not.toHaveBeenCalled()

    rerender({ active: true })

    await waitFor(() => expect(tauri.refreshDevicesFromCloud).toHaveBeenCalledOnce())
    await waitFor(() => expect(result.current.devices).toEqual([local, cloudPeer]))
    expect(result.current.error).toBeNull()
  })

  it('skips the active-flip refresh while deviceRenameBusy is true', async () => {
    const device = makeDevice({ device_id: 'dev-1', name: 'Optimistic Name' })
    vi.mocked(tauri.listDevices).mockResolvedValue([device])
    vi.mocked(tauri.refreshDevicesFromCloud).mockResolvedValue([
      makeDevice({ device_id: 'dev-1', name: 'Stale Cloud Name' }),
    ])

    const { result, rerender } = renderHook(
      ({ active }: { active: boolean }) => useDeviceList({ active }),
      { initialProps: { active: false } },
    )

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.devices).toEqual([device])
    expect(tauri.refreshDevicesFromCloud).not.toHaveBeenCalled()

    useUiStore.setState({ deviceRenameBusy: true })
    rerender({ active: true })

    // Give any accidental async refresh a tick to fire.
    await act(async () => {
      await Promise.resolve()
    })

    expect(tauri.refreshDevicesFromCloud).not.toHaveBeenCalled()
    expect(result.current.devices[0].name).toBe('Optimistic Name')
  })

  it('does not apply a silent cloud refresh while deviceRenameBusy is true', async () => {
    const device = makeDevice({ device_id: 'dev-1', name: 'Old Name' })
    vi.mocked(tauri.listDevices).mockResolvedValue([device])
    vi.mocked(tauri.refreshDevicesFromCloud).mockResolvedValue([device])

    let resolveRename!: () => void
    vi.mocked(tauri.renameDevice).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveRename = resolve
        }),
    )

    const { result } = renderHook(() => useDeviceList())
    await waitFor(() => expect(result.current.loading).toBe(false))
    await waitFor(() => expect(result.current.devices).toEqual([device]))

    // Mount already called refreshDevicesFromCloud once; reset so we can
    // assert the devices-changed handler skips while rename is busy.
    vi.mocked(tauri.refreshDevicesFromCloud).mockClear()
    vi.mocked(tauri.refreshDevicesFromCloud).mockResolvedValue([
      makeDevice({ device_id: 'dev-1', name: 'Stale Cloud Name' }),
    ])

    act(() => {
      void result.current.rename('dev-1', 'Optimistic Name')
    })
    await waitFor(() => expect(result.current.devices[0].name).toBe('Optimistic Name'))
    expect(useUiStore.getState().deviceRenameBusy).toBe(true)

    await act(async () => {
      window.dispatchEvent(new CustomEvent('memlore:devices-changed'))
    })

    expect(tauri.refreshDevicesFromCloud).not.toHaveBeenCalled()
    expect(result.current.devices[0].name).toBe('Optimistic Name')

    await act(async () => {
      resolveRename()
    })
    await waitFor(() => expect(useUiStore.getState().deviceRenameBusy).toBe(false))
  })
})
