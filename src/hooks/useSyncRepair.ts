import { useCallback } from 'react'
import {
  syncRepairFromThisDevice,
  type RepairCounts,
  type SyncMaintenanceResult,
} from '../lib/tauri'
import { useSyncStore } from '../stores/syncStore'

/**
 * Recovery-wizard seam for "repair from this device".
 *
 * Components call `repair()` instead of the Tauri command. After the command
 * resolves — including a queued deferral — status is refreshed through the
 * same `useSyncStore.refresh` path `useSync` uses after maintenance. A
 * rejection leaves that snapshot untouched.
 */
export function useSyncRepair(): {
  repair: () => Promise<SyncMaintenanceResult<RepairCounts>>
} {
  const refresh = useSyncStore((s) => s.refresh)

  const repair = useCallback(async () => {
    const result = await syncRepairFromThisDevice()
    await refresh()
    return result
  }, [refresh])

  return { repair }
}
