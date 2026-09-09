import { useEffect } from 'react'
import { useSyncStore } from '../stores/syncStore'

/**
 * Sync hook — a thin selector wrapper over the global `useSyncStore`.
 *
 * The store owns the single backend event listener and all derived state
 * (`phase`, `isSyncing`, `lastError`, etc.). Every component that calls
 * `useSync()` reads the same snapshot, and the snapshot survives component
 * remounts — fixing the previous bug where leaving and returning to
 * Settings → Sync wiped the active error and surfaced a stale "Up to date"
 * label until the next backend event arrived.
 *
 * The public surface (return shape and method names) is preserved so
 * existing call sites do not need to change.
 */
export function useSync() {
  const init = useSyncStore((s) => s.init)

  // Lazy init on first consumer mount. The store guards against concurrent
  // and repeated calls, so calling this from N components is safe.
  useEffect(() => {
    void init()
  }, [init])

  // Each selector subscribes to the slice it actually reads — Zustand
  // re-renders the component only when that slice changes.
  const deviceId = useSyncStore((s) => s.deviceId)
  const status = useSyncStore((s) => s.status)
  const isSyncing = useSyncStore((s) => s.isSyncing)
  const lastError = useSyncStore((s) => s.lastError)
  const lastErrorKey = useSyncStore((s) => s.lastErrorKey)
  const lastErrorAction = useSyncStore((s) => s.lastErrorAction)
  const lastSummary = useSyncStore((s) => s.lastSummary)
  const phase = useSyncStore((s) => s.phase)
  const settings = useSyncStore((s) => s.settings)
  const progress = useSyncStore((s) => s.progress)
  const recovery = useSyncStore((s) => s.recovery)
  const retryAt = useSyncStore((s) => s.retryAt)

  const refresh = useSyncStore((s) => s.refresh)
  const refreshSettings = useSyncStore((s) => s.refreshSettings)
  const refreshRecovery = useSyncStore((s) => s.refreshRecovery)
  const setEnabled = useSyncStore((s) => s.setEnabled)
  const syncNow = useSyncStore((s) => s.syncNow)
  const pushEntry = useSyncStore((s) => s.pushEntry)
  const updateSettings = useSyncStore((s) => s.updateSettings)
  const resumeRecovery = useSyncStore((s) => s.resumeRecovery)
  const cancelRecovery = useSyncStore((s) => s.cancelRecovery)
  const preflightLocalRecovery = useSyncStore((s) => s.preflightLocalRecovery)
  const beginCloudRecoveryStaging = useSyncStore((s) => s.beginCloudRecoveryStaging)

  const recoveryBlocksSync = recovery?.blocksNormalSync === true

  return {
    deviceId,
    status,
    isSyncing,
    lastError,
    lastErrorKey,
    lastErrorAction,
    lastSummary,
    phase,
    settings,
    progress,
    /** Active/interrupted recovery — always surface outside collapsed help. */
    recovery,
    /** Unix ms when the scheduler will next auto-retry after a failure. */
    retryAt,
    /** True while an authoritative recovery job blocks normal Sync Now. */
    recoveryBlocksSync,
    refresh,
    refreshSettings,
    refreshRecovery,
    setEnabled,
    syncNow,
    pushEntry,
    updateSettings,
    resumeRecovery,
    cancelRecovery,
    preflightLocalRecovery,
    beginCloudRecoveryStaging,
  }
}
