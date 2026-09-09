import { useCallback } from 'react'
import { lockApp } from '../lib/lock'
import { useSettingsStore } from '../stores/settingsStore'
import { useTabStore } from '../stores/tabStore'

/**
 * Lightweight hook for the "Lock app" action — no reconcile, no
 * `beforeunload` listener, no biometric probe.
 *
 * `useAuth` owns the full lifecycle and is already mounted by `App.tsx`.
 * Components that only need to *trigger* a lock (footer button, future
 * menu items, keyboard shortcut handlers) should use this hook instead
 * of `useAuth` to avoid duplicate reconciles and stacked `beforeunload`
 * listeners.
 *
 * Returns:
 * - `lock()` — zeroizes the backend key then flips the UI to locked.
 *   Keep in sync with `useAuth.lock` — both mirror the policy "user
 *   intent wins": if the backend call fails we still flip the UI,
 *   because the user's explicit intent is "get me to a locked state."
 * - `canLock` — `true` only when encryption mode is 'password' (i.e. a
 *   password has been set). In 'unset' mode there is no password
 *   to unlock with, so locking would strand the user.
 * - `lockBlockedReason` — `null` when locking is permitted, otherwise a
 *   stable enum identifying *why* (used by the footer to pick a tooltip
 *   and by the keyboard shortcut to gate the chord). Centralizing the
 *   policy here keeps the footer button and global shortcut in sync.
 */
export type LockBlockedReason = 'no-password' | 'saving'

export function useLockAction() {
  const encryptionMode = useSettingsStore((s) => s.encryptionMode)
  const activeTabDirty = useTabStore((s) => {
    const tab = s.tabs.find((t) => t.id === s.activeTabId)
    return tab?.dirty === true
  })

  const canLock = encryptionMode === 'password'

  // Delegates to lib/lock.ts — same policy as the pure module, but
  // expressed reactively so React re-renders consumers when state changes.
  const lock = useCallback(async () => {
    await lockApp()
  }, [])

  const lockBlockedReason: LockBlockedReason | null = !canLock
    ? 'no-password'
    : activeTabDirty
      ? 'saving'
      : null

  return {
    lock,
    canLock,
    lockBlockedReason,
  }
}
