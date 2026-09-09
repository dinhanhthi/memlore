import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { useEffect } from 'react'
import { create } from 'zustand'
import { getForceRePairStatus, recheckForceRePair } from '../lib/tauri'

interface ForceRePairPayload {
  reason: string
}

// Module-level Zustand store so the event listener and any component
// (e.g. GoogleDriveSettings after `needs_force_re_pair` outcome) can both
// set the flag and share the same state across all hook consumers.
interface ForceRePairStore {
  forceRePairRequired: boolean
  reason: string | null
  setForceRePair: (reason: string) => void
  clearForceRePair: () => void
}

export const useForceRePairStore = create<ForceRePairStore>((set) => ({
  forceRePairRequired: false,
  reason: null,
  setForceRePair: (reason) => set({ forceRePairRequired: true, reason }),
  clearForceRePair: () => set({ forceRePairRequired: false, reason: null }),
}))

export interface UseForceRePairReturn {
  forceRePairRequired: boolean
  reason: string | null
  /** Clears the force-re-pair state after the user has successfully re-paired. */
  clearForceRePair: () => void
}

/**
 * Subscribes to the `xj://force-re-pair` Tauri event, which is emitted
 * during `pull_remote` or `startup_reconcile` when the cloud vault's
 * epoch/fingerprint no longer matches this device's slot.
 *
 * State is backed by a Zustand store so callers can also trigger
 * force-re-pair imperatively (e.g. from `GdriveConnectOutcome.needs_force_re_pair`)
 * via `useForceRePairStore.getState().setForceRePair(reason)`.
 *
 * `dbReady` MUST flip to `true` once the real SQLCipher connection is mounted
 * (post-unlock in password mode). In password mode the pre-unlock DB is an
 * empty `:memory:` placeholder, so the mount-time hydrate always reads `null`
 * — without a re-hydrate after unlock, a flag persisted before a cold restart
 * would silently block push forever while the screen never mounts.
 */
export function useForceRePair(dbReady: boolean): UseForceRePairReturn {
  const forceRePairRequired = useForceRePairStore((s) => s.forceRePairRequired)
  const reason = useForceRePairStore((s) => s.reason)
  // Zustand action references are stable across the store's lifetime, so
  // reading them via getState() outside the effect is intentional — they
  // appear in the effect deps only to satisfy exhaustive-deps and never
  // actually re-trigger it.
  const { setForceRePair, clearForceRePair } = useForceRePairStore.getState()

  // Event listener lives in a MOUNT-ONLY effect, separate from hydration:
  // if it shared the `dbReady`-keyed effect below, every dbReady flip would
  // tear the listener down and re-register it asynchronously — a deferred
  // reconcile emitting `xj://force-re-pair` inside that gap would be lost.
  useEffect(() => {
    const unlisteners: UnlistenFn[] = []
    let cancelled = false

    async function subscribe() {
      // Since the startup keyring reconcile was made fire-and-forget (deferred
      // off the unlock path), the `force_re_pair_required` DB flag is written
      // AFTER unlock resolves — so hydration almost always runs before it.
      // This listener is therefore the PRIMARY in-session signal, not a fallback.
      // Keep `subscribe()` un-awaited/early so the listener is registered within
      // milliseconds, well before the reconcile network round-trip can emit.
      // No silent recheck here: an event is a FRESH detection, not a stale flag.
      const unlisten = await listen<ForceRePairPayload>('xj://force-re-pair', (event) => {
        setForceRePair(event.payload.reason)
      })
      if (cancelled) {
        unlisten()
        return
      }
      unlisteners.push(unlisten)
    }

    void subscribe()

    return () => {
      cancelled = true
      for (const u of unlisteners) u()
    }
  }, [setForceRePair])

  useEffect(() => {
    let cancelled = false

    // Hydrate from the persisted backend flag on mount AND again when the
    // real DB connection is swapped in (`dbReady` flips true). A persisted
    // flag may be stale — written fail-closed by a transient Drive error
    // before a restart — so when one is found, run a silent recheck FIRST
    // and only surface the re-pair screen when the backend confirms the
    // flag stands. This keeps cold-start recovery robust without the
    // re-pair screen flashing up after unlock for a flag that was about
    // to self-dismiss.
    async function hydrate() {
      try {
        const persistedReason = await getForceRePairStatus()
        if (cancelled || !persistedReason) return
        try {
          const cleared = await recheckForceRePair()
          if (cancelled || cleared) return
        } catch (err) {
          // Fail-closed: the flag could not be verified either way — show the
          // screen; it offers manual re-pair and a Drive reconnect.
          console.warn('useForceRePair: silent recheck failed, flag stands', err)
        }
        if (!cancelled) setForceRePair(persistedReason)
      } catch (err) {
        // Non-fatal: the worst case is the same as before this fix — the
        // ForceRePairScreen still shows up the next time the sync engine
        // re-detects the mismatch and emits the event.
        console.warn('useForceRePair: failed to hydrate from backend', err)
      }
    }

    void hydrate()

    return () => {
      cancelled = true
    }
  }, [setForceRePair, dbReady])

  return {
    forceRePairRequired,
    reason,
    clearForceRePair,
  }
}
