import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { useEffect, useRef, useState } from 'react'
import { getSyncCatchupStatus, type SyncCatchupStatus } from '../lib/tauri'

interface CatchupProgressEvent {
  pulled: number
  total: number
  peerDeviceId?: string
}

export interface SyncCatchupProgress {
  pulled: number
  total: number
}

const SYNC_CATCHUP_INCOMPLETE_ERROR = /^SYNC_CATCHUP_INCOMPLETE: pulled=(\d+) total=(\d+)$/

/** Returns catch-up counts only for the backend's exact export-block sentinel. */
export function parseSyncCatchupIncompleteError(error: unknown): SyncCatchupProgress | null {
  const message = error instanceof Error ? error.message : String(error)
  const match = SYNC_CATCHUP_INCOMPLETE_ERROR.exec(message)
  if (!match) return null

  const pulled = Number(match[1])
  const total = Number(match[2])
  if (!Number.isSafeInteger(pulled) || !Number.isSafeInteger(total)) return null

  return { pulled, total }
}

const INITIAL_STATUS: SyncCatchupStatus = {
  complete: false,
  pulled: 0,
  total: 0,
}

/**
 * Hydrates the persisted catch-up completion state, then follows the live
 * pull progress stream. This is the sole frontend access path for sync
 * catch-up state so components never invoke the Tauri command directly.
 */
export function useSyncCatchup(): SyncCatchupStatus {
  const [status, setStatus] = useState<SyncCatchupStatus>(INITIAL_STATUS)
  const receivedProgress = useRef(false)

  useEffect(() => {
    let cancelled = false
    const unlisteners: UnlistenFn[] = []
    async function subscribe() {
      try {
        const unlisten = await listen<CatchupProgressEvent>('sync:catchup-progress', (event) => {
          receivedProgress.current = true
          const { pulled, total, peerDeviceId } = event.payload
          setStatus({ complete: peerDeviceId === undefined, pulled, total })
        })

        if (cancelled) {
          unlisten()
          return
        }
        unlisteners.push(unlisten)
      } catch {
        // Snapshot hydration remains useful when the event bridge is unavailable.
      }

      if (cancelled) return

      try {
        const initialStatus = await getSyncCatchupStatus()
        if (!cancelled && !receivedProgress.current) {
          setStatus(initialStatus)
        }
      } catch {
        // Keep the safe initial incomplete status if the snapshot is unavailable.
      }
    }

    void subscribe()

    return () => {
      cancelled = true
      for (const unlisten of unlisteners) unlisten()
    }
  }, [])

  return status
}
