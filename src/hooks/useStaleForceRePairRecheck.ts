import { useEffect, useRef } from 'react'
import { recheckForceRePair } from '../lib/tauri'

/**
 * Ask the backend once, on mount, whether a force-re-pair flag is stale — and
 * dismiss the screen if it is.
 *
 * A transient Drive I/O error makes the backend fail closed and persist
 * `force_re_pair_required`, and nothing else clears it: the re-pair screens
 * render ahead of LockScreen, so the user never unlocks and the unlock-time
 * reconcile that would re-evaluate never runs. The backend clears the flag only
 * when the fingerprint positively verifies, so a genuine rotation keeps the
 * screen up.
 *
 * `useForceRePair`'s hydrate path already rechecks before showing a screen, but
 * the `xj://force-re-pair` event and the imperative `needs_force_re_pair`
 * connect outcome do not — this covers those.
 *
 * No spinner: callers stay usable throughout and simply disappear if the vault
 * turns out to be healthy.
 */
export function useStaleForceRePairRecheck(onCleared: () => void) {
  // Callers define the callback inline, so its identity changes every render.
  // A ref keeps the effect mount-only — as a dep it would re-fire the recheck
  // (a Drive round-trip) on every keystroke.
  const onClearedRef = useRef(onCleared)
  onClearedRef.current = onCleared

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const cleared = await recheckForceRePair()
        if (cleared && !cancelled) onClearedRef.current()
      } catch (err) {
        // Fail-closed: leave the screen up so the user can still recover by hand.
        console.warn('force-re-pair recheck failed, flag stands', err)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])
}
