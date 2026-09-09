/**
 * DB-ready signal — fires once the SQLCipher unlock swap has completed and
 * the backend `AppState` connection is pointing at the real on-disk DB
 * (instead of the empty `:memory:` placeholder used while locked).
 *
 * Hooks that run *before* unlock (mounted unconditionally in `App.tsx`) and
 * hydrate state from `getSetting` must subscribe so they can re-read once
 * the real DB is reachable. Without this, persisted values look like they
 * "reset to defaults" on every launch because the placeholder always
 * returns `null`.
 *
 * For password-disabled flows (encryption never enabled), there is no
 * placeholder, so the signal is a no-op — subscribers' initial load runs
 * against the real DB and the post-unlock re-read just re-applies the
 * same value.
 *
 * Subscribers are invoked synchronously when `emitDbReady` fires; they
 * should kick off async work but never block. `onDbReady` returns an
 * unsubscribe function — currently only used by test setup, but the API
 * is symmetric for future React-lifecycle subscribers.
 */

type DbReadyListener = () => void

const listeners = new Set<DbReadyListener>()

/** Subscribe a callback to run when the real DB connection becomes
 *  available. Returns an unsubscribe function. */
export function onDbReady(listener: DbReadyListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Fire the DB-ready signal. Safe to call multiple times — listeners
 *  should be idempotent. Called from `App.tsx` once `hasReconciled &&
 *  (encryptionMode !== 'password' || !isLocked)`.
 *
 *  Implementation notes:
 *  - Iterates a snapshot so a listener that calls `onDbReady` synchronously
 *    during dispatch does NOT get invoked on the current cycle.
 *  - A throwing listener is logged but does not abort the loop, so a buggy
 *    subscriber can't silently break unrelated post-unlock hydration. */
export function emitDbReady(): void {
  const snapshot = Array.from(listeners)
  for (const l of snapshot) {
    try {
      l()
    } catch (err) {
      console.error('[dbReady] listener threw:', err)
    }
  }
}

/**
 * Test-only: clear all registered listeners. Module-level subscriptions
 * (e.g. `useThemeCustomization.ts`, `useLanguage.ts` register at import
 * time) persist across Vitest test cases within the same worker; without
 * this reset, `emitDbReady()` in one test would fire listeners registered
 * by previously-loaded test files.
 */
export function __resetDbReadyListenersForTests(): void {
  listeners.clear()
}
