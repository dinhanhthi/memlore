import { useCallback, useEffect, useRef, useState } from 'react'
import * as tauri from '../lib/tauri'
import type { DeviceInfo } from '../lib/tauri'
import { useUiStore } from '../stores/uiStore'

export type { DeviceInfo }

interface UseDeviceListReturn {
  devices: DeviceInfo[]
  loading: boolean
  error: string | null
  /** Fetch device slots from Drive and merge into local list. */
  refresh: () => Promise<void>
  /**
   * Rename a device in the background. Optimistically updates local state,
   * sets `deviceRenameBusy`, then awaits the Tauri command (which may re-upload
   * the current device's Drive slot). Callers should not block UI on this
   * Promise — close the rename modal immediately after kicking it off.
   */
  rename: (deviceId: string, newName: string) => Promise<void>
}

interface UseDeviceListOptions {
  /**
   * When true (default), silently refresh from Drive after the local paint
   * and whenever this flips false → true (e.g. user opens the Devices tab
   * without remounting SyncSettings). When false, only the local table is
   * painted — no Drive traffic until the list becomes active.
   */
  active?: boolean
}

/**
 * `useDeviceList` — manages the connected-device list.
 *
 * On mount, paints the local `devices` table immediately via `listDevices`
 * (cheap, no Drive traffic). When `active` is true, kicks off a silent cloud
 * `refresh()` so peers that onboarded elsewhere show up as soon as the
 * Devices tab is shown — including when `active` flips false → true after
 * the hook was already mounted (Sync tab switches use `display:none`).
 *
 * It also re-fetches from cloud whenever a sync completes (the syncStore fires
 * `memlore:devices-changed` on phase → 'synced'), keeping "Last synced … ago"
 * and the peer list in step without a manual refresh.
 *
 * Explicit `refresh()` calls `refreshDevicesFromCloud`, which hits Drive and
 * merges device slots into the local table.
 */
export function useDeviceList(options?: UseDeviceListOptions): UseDeviceListReturn {
  const active = options?.active ?? true
  const [devices, setDevices] = useState<DeviceInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Mirror for rename's optimistic revert — Strict Mode double-invokes
  // setState updaters, so capturing previousName inside the updater is unsafe.
  const devicesRef = useRef(devices)
  devicesRef.current = devices
  const activeRef = useRef(active)
  activeRef.current = active

  // Fetch from Drive, merge into local table, return merged list.
  //
  // `silent` is for background fetches (mount auto-load, sync-completion
  // auto-refresh): it skips the loading spinner AND swallows errors. The cloud
  // fetch only enriches the already-painted local list, and it fails by design
  // whenever Drive isn't the active provider (local/iCloud sync, or Drive not
  // connected) — surfacing that as an error banner would be a false alarm.
  // A user-initiated refresh (`silent === false`, the refresh button) still
  // shows the spinner and reports errors as legitimate feedback.
  const refresh = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    if (!silent) setError(null)
    try {
      const rows = await tauri.refreshDevicesFromCloud()
      setDevices(rows ?? [])
    } catch (err) {
      if (!silent) setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (!silent) setLoading(false)
    }
  }, [])

  // Mount: paint local rows instantly, then silent-refresh from cloud only
  // if the list is already active (default / Devices tab already showing).
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const rows = await tauri.listDevices()
        if (!cancelled) setDevices(rows ?? [])
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
      // Silent: errors (e.g. non-GDrive provider) must not clobber the local
      // list or banner. Read `active` via ref so this stays mount-only.
      if (!cancelled && activeRef.current) await refresh(true)
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [refresh])

  // When `active` flips false → true after mount (user clicked Devices while
  // already on Settings/Sync), silent-refresh so new peers appear without
  // requiring the Refresh button. Skip while a rename is in flight — same
  // guard as the devices-changed handler.
  const prevActiveRef = useRef(active)
  useEffect(() => {
    const becameActive = active && !prevActiveRef.current
    prevActiveRef.current = active
    if (!becameActive) return
    if (useUiStore.getState().deviceRenameBusy) return
    void refresh(true)
  }, [active, refresh])

  // Auto-refresh from cloud when a sync completes. The syncStore dispatches
  // `memlore:devices-changed` on every transition into 'synced'.
  // Skip while a rename is in flight — a full-replace would clobber the
  // optimistic local name before the Drive slot upload finishes.
  useEffect(() => {
    const handler = () => {
      if (useUiStore.getState().deviceRenameBusy) return
      void refresh(true)
    }
    window.addEventListener('memlore:devices-changed', handler)
    return () => window.removeEventListener('memlore:devices-changed', handler)
  }, [refresh])

  // Rename a device in the background: optimistic local update + busy flag,
  // then await the Tauri path (which may do Drive I/O for the current device).
  const rename = useCallback(async (deviceId: string, newName: string) => {
    const uiStore = useUiStore.getState()
    // Callers (RenameDeviceModal) must check these flags before closing the
    // modal — a silent return here would look like success with no name change.
    if (uiStore.deviceRenameBusy || uiStore.rotationBusy) return

    const previousName = devicesRef.current.find((d) => d.device_id === deviceId)?.name
    setDevices((prev) => prev.map((d) => (d.device_id === deviceId ? { ...d, name: newName } : d)))
    setError(null)
    uiStore.setDeviceRenameBusy(true)

    try {
      await tauri.renameDevice(deviceId, newName)
    } catch (err) {
      if (previousName !== undefined) {
        setDevices((prev) =>
          prev.map((d) => (d.device_id === deviceId ? { ...d, name: previousName } : d)),
        )
      }
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      useUiStore.getState().setDeviceRenameBusy(false)
    }
  }, [])

  return { devices, loading, error, refresh, rename }
}
