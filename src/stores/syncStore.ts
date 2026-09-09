import { create } from 'zustand'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import {
  getDeviceId,
  getSyncRecoveryStatus as tauriGetSyncRecoveryStatus,
  getSyncSettings as tauriGetSyncSettings,
  getSyncStatus,
  gdriveBeginCloudAuthoritativeStaging as tauriGdriveBeginCloudAuthoritativeStaging,
  gdriveCancelSyncRecovery as tauriGdriveCancelSyncRecovery,
  gdrivePreflightLocalAuthoritativeRecovery as tauriGdrivePreflightLocalAuthoritativeRecovery,
  gdriveResumeSyncRecovery as tauriGdriveResumeSyncRecovery,
  pushEntry as tauriPushEntry,
  setSyncEnabled as tauriSetSyncEnabled,
  setSyncSettings as tauriSetSyncSettings,
  syncNow as tauriSyncNow,
  SYNC_PROGRESS_EVENT,
  SYNC_RECOVERY_STATUS_EVENT,
  SYNC_RETRY_SCHEDULED_EVENT,
  SYNC_STATUS_EVENT,
  type CloudAuthoritativeStagingResult,
  type LocalAuthoritativePreflightResult,
  type SyncPhase,
  type SyncProgressEvent,
  type SyncProgressPhase,
  type SyncRecoveryStatus,
  type SyncRetryScheduledPayload,
  type SyncSettings,
  type SyncStatus,
  type SyncStatusEvent,
  type SyncSummary,
} from '../lib/tauri'
import { hydrateLayoutPreset } from '../hooks/useLayoutPreset'
import { hydrateDashboardCards } from '../hooks/useDashboardCards'
import { useAiSettingsStore } from './aiSettingsStore'

/**
 * Watchdog timeout in milliseconds. MUST be longer than the backend's own
 * `tokio::time::timeout` in `run_sync_now` (120s) so the backend always
 * speaks first: a hung sync ends with a clean backend-emitted error event
 * instead of the watchdog racing in and creating a 10–30s window where a
 * late `'synced'` event could overwrite the watchdog's "timed out" state.
 */
const WATCHDOG_MS = 130_000

/**
 * Global sync state — single source of truth shared by every sync UI surface
 * (footer indicator, Settings → Sync panel, scheduler row). A previous
 * iteration kept all of this inside `useSync`, but each component mount got
 * its own listener and its own copy of `phase` / `lastError`. Navigating
 * away from Settings and back wiped the active error and showed a stale
 * "Up to date" until the next backend event fired. Hoisting the state into a
 * Zustand store fixes both: one listener for the whole app, and the state
 * survives any component remount.
 */
interface SyncStoreState {
  // ── Snapshot ────────────────────────────────────────────────────────────
  deviceId: string | null
  status: SyncStatus | null
  settings: SyncSettings | null
  phase: SyncPhase
  isSyncing: boolean
  /** Raw, already-translated error string from the backend (or any non-i18n source). */
  lastError: string | null
  /**
   * i18n key for an error that should be translated at render time
   * (`nav:sync.timeout`, etc.). When set, the UI renders `t(lastErrorKey)`
   * instead of `lastError`. Set this — not `lastError` — for any error
   * surfaced from frontend code, so a language switch retranslates the
   * message and so a watchdog firing before i18n finishes initializing
   * doesn't surface a literal key string to the user.
   */
  lastErrorKey: string | null
  /**
   * Discriminator for an error that has an actionable UI follow-up.
   * Currently used to recognise cross-mode rejection from the sync engine
   * so the Cloud Sync surface can render a banner + CTA pointing the user
   * at Settings → Security instead of dumping the raw error blob.
   * Null when the last error has no specific action.
   */
  lastErrorAction:
    | { kind: 'cross_mode_needs_password' }
    | { kind: 'cross_mode_needs_no_password' }
    | { kind: 'gdrive_token_revoked' }
    | { kind: 'force_re_pair_required'; reason: 'inconclusive' | 'rotated' }
    | null
  lastSummary: SyncSummary | null
  /** Granular per-phase progress, null when not syncing. */
  progress: SyncProgressEvent | null
  /**
   * Active/interrupted authoritative recovery job. Non-null while a
   * non-completed job exists — keep visible even when Sync help is collapsed.
   */
  recovery: SyncRecoveryStatus | null
  /**
   * Unix ms at which the scheduler will next attempt a sync after a failure.
   * Null when no backoff is active (success / manual Sync now / first run).
   */
  retryAt: number | null

  // ── Internal ────────────────────────────────────────────────────────────
  /** True once `init()` has wired the listener and kicked off initial fetches. */
  initialized: boolean
  /** Pending `init()` promise; concurrent callers await the same one. */
  initPromise: Promise<void> | null
  unlisten: UnlistenFn | null
  unlistenProgress: UnlistenFn | null
  unlistenRecovery: UnlistenFn | null
  unlistenRetry: UnlistenFn | null
  /** Guards `syncNow` against rapid re-entry — same role as the old hook ref. */
  inflightSync: boolean
  /** Watchdog timer handle. Cleared when sync ends or on each new event. */
  watchdogTimer: ReturnType<typeof setTimeout> | null

  // ── Actions ─────────────────────────────────────────────────────────────
  init: () => Promise<void>
  refresh: () => Promise<void>
  refreshSettings: () => Promise<void>
  refreshRecovery: () => Promise<void>
  setEnabled: (enabled: boolean) => Promise<void>
  syncNow: () => Promise<SyncSummary>
  pushEntry: (entryId: string) => Promise<void>
  updateSettings: (next: SyncSettings) => Promise<void>
  resumeRecovery: () => Promise<SyncRecoveryStatus>
  cancelRecovery: () => Promise<SyncRecoveryStatus>
  /** Start local→cloud recovery preflight (creates/resumes job + backup). */
  preflightLocalRecovery: () => Promise<LocalAuthoritativePreflightResult>
  /** Start cloud→local recovery staging (creates/resumes job + backup). */
  beginCloudRecoveryStaging: () => Promise<CloudAuthoritativeStagingResult>
}

const emptySummary: SyncSummary = { pushed: 0, pulled: 0, merged: 0, errors: [] }

/**
 * Stable marker the backend returns when another sync cycle already holds the
 * single-flight guard (SYNC_IN_PROGRESS_ERR in src-tauri/src/commands/sync.rs).
 * Means "skip, a sync is already running" — never a real failure.
 */
const SYNC_IN_PROGRESS_ERR = 'sync_in_progress'

/**
 * Recognise an error class that has an actionable user-facing follow-up.
 * The substrings are anchored to backend error strings — change them in
 * sync if the backend strings change.
 *
 * Priority order (first match wins):
 *   1. `GDRIVE_TOKEN_REVOKED` — Google refresh token expired or revoked
 *      (e.g. user revoked access on myaccount.google.com, or the token
 *      hit Google's 6-month inactivity TTL). Surface a reconnect banner.
 *      Higher priority than cross-mode because if auth fails, no
 *      envelope was ever decrypted, so cross-mode signatures cannot
 *      legitimately appear in the same error set.
 *   2. Cross-mode signatures (collapsed by `engine.rs::collapse_cross_mode_errors`).
 *
 * Returns the action kind, or `null` if no known signature matches.
 */
function detectActionableError(
  errors: string[],
):
  | { kind: 'gdrive_token_revoked' }
  | { kind: 'cross_mode_needs_password' }
  | { kind: 'cross_mode_needs_no_password' }
  | { kind: 'force_re_pair_required'; reason: 'inconclusive' | 'rotated' }
  | null {
  const joined = errors.join(' ')
  if (joined.includes('FORCE_RE_PAIR_REQUIRED')) {
    const reason: 'inconclusive' | 'rotated' = joined.includes('reason=inconclusive')
      ? 'inconclusive'
      : 'rotated'
    return { kind: 'force_re_pair_required', reason }
  }
  if (joined.includes('GDRIVE_TOKEN_REVOKED')) {
    return { kind: 'gdrive_token_revoked' }
  }
  if (joined.includes('this device is in no-password mode')) {
    return { kind: 'cross_mode_needs_password' }
  }
  if (joined.includes('this device is in password mode')) {
    return { kind: 'cross_mode_needs_no_password' }
  }
  return null
}

/**
 * Transient transport failures surface from reqwest as
 * `error sending request for url (...)` — meaning the cloud was unreachable,
 * not that sync data is broken. Instead of showing the raw
 * `pull: templates: network: error sending request for url (...)` string,
 * return an i18n key whose copy says the scheduler retries automatically
 * (exponential backoff + focus kick — see `sync/scheduler.rs`) and that
 * Sync Now retries immediately.
 * Returns `null` for any non-transport error so the raw message still shows.
 */
const NETWORK_TRANSIENT_KEY = 'nav:sync.network_error'
function networkErrorKey(errors: string[]): string | null {
  return errors.join(' ').includes('error sending request for url') ? NETWORK_TRANSIENT_KEY : null
}

const initialSnapshot = {
  deviceId: null,
  status: null,
  settings: null,
  phase: 'idle' as SyncPhase,
  isSyncing: false,
  lastError: null,
  lastErrorKey: null,
  lastErrorAction: null,
  lastSummary: null,
  progress: null,
  recovery: null as SyncRecoveryStatus | null,
  retryAt: null,
  initialized: false,
  initPromise: null,
  unlisten: null,
  unlistenProgress: null,
  unlistenRecovery: null,
  unlistenRetry: null,
  inflightSync: false,
  watchdogTimer: null,
}

/** Start (or restart) the watchdog timer.  Fires after WATCHDOG_MS if not cleared. */
function armWatchdog(get: () => SyncStoreState, set: (s: Partial<SyncStoreState>) => void): void {
  const existing = get().watchdogTimer
  if (existing !== null) clearTimeout(existing)

  const timer = setTimeout(() => {
    // Only act if still syncing when the timer fires.
    if (!get().isSyncing) return
    // Store the i18n KEY rather than a translated string. The renderer
    // calls `t(lastErrorKey)` so the message localizes correctly even if
    // the watchdog fires before i18n finishes initializing, and so a
    // language switch retranslates it without re-firing the watchdog.
    set({
      phase: 'error',
      isSyncing: false,
      inflightSync: false,
      progress: null,
      watchdogTimer: null,
      lastError: null,
      lastErrorKey: 'nav:sync.timeout',
      lastErrorAction: null,
    })
  }, WATCHDOG_MS)

  set({ watchdogTimer: timer })
}

/** Clear the watchdog timer if one is set. */
function clearWatchdog(get: () => SyncStoreState, set: (s: Partial<SyncStoreState>) => void): void {
  const timer = get().watchdogTimer
  if (timer !== null) {
    clearTimeout(timer)
    set({ watchdogTimer: null })
  }
}

/**
 * Content-change events fanned out to every list hook. The `enteredSynced`
 * transition below also fires `memlore:devices-changed`, which is
 * deliberately NOT in this set — it hits the cloud, so re-firing it on every
 * progress tick would hammer Drive.
 */
const CONTENT_CHANGED_EVENTS = [
  'memlore:journals-changed',
  'memlore:entries-changed',
  'memlore:tags-changed',
  'memlore:media-changed',
  // Chat sessions live in chats.bin and are pulled like other surfaces;
  // without this event `useDailyChatSessions` stays stale until remount.
  'memlore:chats-changed',
  // Memory items ride memory.bin; without this event `useUserMemory` (the
  // settings Memories list + count) stays stale until remount.
  'memlore:memories-changed',
] as const

function dispatchContentChanged(): void {
  for (const name of CONTENT_CHANGED_EVENTS) {
    window.dispatchEvent(new CustomEvent(name))
  }
}

/**
 * Trailing-debounce window for the mid-sync fan-out below. A pull writes rows
 * continuously, so invalidating on every progress tick would refetch dozens of
 * times per second; one trailing dispatch per quiet second is enough for the
 * list to visibly fill in as the sync runs.
 */
const MID_SYNC_REFRESH_DEBOUNCE_MS = 1000
let midSyncRefreshTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Refresh the visible lists WHILE a sync is still running.
 *
 * Without this, a first sync on a freshly-joined device writes hundreds of
 * entries into the local DB but nothing on screen changes until the terminal
 * `'synced'` status event fires — the user sits on an empty Entries page and
 * has to switch tabs to see rows that already landed.
 *
 * Only `pulling-*` phases qualify: pushes upload local rows and never change
 * what this device can display.
 */
function scheduleMidSyncRefresh(phase: SyncProgressPhase): void {
  if (!phase.startsWith('pulling-')) return
  if (midSyncRefreshTimer !== null) clearTimeout(midSyncRefreshTimer)
  midSyncRefreshTimer = setTimeout(() => {
    midSyncRefreshTimer = null
    dispatchContentChanged()
    // Settings (including AI provider/model rows) land mid-pull on a
    // newly-joined device. Refresh so the adopt-setup prompt can open
    // before the terminal 'synced' event.
    void useAiSettingsStore
      .getState()
      .refreshProviders()
      .catch(() => {
        // Footer backoff retries independently.
      })
  }, MID_SYNC_REFRESH_DEBOUNCE_MS)
}

/**
 * Cancel a pending mid-sync refresh and report whether one was armed.
 *
 * Called when a sync ends. The caller MUST still fan out when this returns
 * true and the terminal `enteredSynced` fan-out does not run: a pull commits
 * each chunk in its own transaction (see `sync/engine.rs`), so a sync that
 * fails or times out mid-pull leaves real rows in the local DB. Silently
 * dropping the pending refresh there would reproduce the exact empty-list bug
 * this debounce exists to fix.
 */
function takeMidSyncRefresh(): boolean {
  if (midSyncRefreshTimer === null) return false
  clearTimeout(midSyncRefreshTimer)
  midSyncRefreshTimer = null
  return true
}

/** Drop a pending mid-sync refresh outright, without fanning out. Only for
 *  test teardown, where a leftover timer would leak into the next test. */
function cancelMidSyncRefresh(): void {
  takeMidSyncRefresh()
}

export const useSyncStore = create<SyncStoreState>()((set, get) => ({
  ...initialSnapshot,

  init: async () => {
    const s = get()
    if (s.initialized) return
    if (s.initPromise) return s.initPromise

    const promise = (async () => {
      // Subscribe FIRST so an event fired between the initial fetches and
      // the listener wiring isn't lost. `listen` resolves once registered.
      try {
        const unlisten = await listen<SyncStatusEvent>(SYNC_STATUS_EVENT, (event) => {
          const payload = event.payload
          const nowSyncing = payload.state === 'syncing'
          const enteredSynced = payload.state === 'synced' && get().phase !== 'synced'

          if (nowSyncing) {
            // Re-arm watchdog each time a status-changed event comes in while
            // syncing (covers background-scheduler-triggered syncs, not just
            // user-invoked syncNow).
            armWatchdog(get, (partial) => set(partial))
          }

          // Sync ended — take ownership of any pending mid-sync refresh. On a
          // clean finish the `enteredSynced` fan-out below covers it; on
          // error/timeout nothing else will, so we fan out ourselves.
          let pendingRefresh = false
          if (!nowSyncing) {
            clearWatchdog(get, (partial) => set(partial))
            pendingRefresh = takeMidSyncRefresh()
            set({ progress: null })
          }

          // Sync just finished successfully → fan out change events so
          // every list hook (journals, entries, tags, media, chats)
          // refetches from the DB. Without this the user sees stale lists
          // until they reload the app, even though pull_remote already
          // wrote the new rows. We only fire on a fresh transition INTO
          // 'synced' so we don't re-emit on idle/error events.
          // IMPORTANT: this guard reads `phase` BEFORE the `set({phase:…})`
          // below — do NOT reorder, or the guard always sees the new value
          // and never fires on a real transition.
          if (enteredSynced) {
            dispatchContentChanged()
            // A peer's layout_preset / dashboard_cards change applies after a pull.
            void hydrateLayoutPreset()
            void hydrateDashboardCards()
            // Devices' last_seen_at is refreshed by a successful sync (current)
            // device locally, peers via slot republish). Let the connected-
            // devices list re-fetch from cloud so it stays in step.
            window.dispatchEvent(new CustomEvent('memlore:devices-changed'))
            void useAiSettingsStore
              .getState()
              .refreshProviders()
              .catch(() => {
                // The AI settings store invalidates the stale snapshot and
                // the footer's backoff loop retries independently.
              })
          } else if (pendingRefresh) {
            // Sync ended WITHOUT reaching 'synced' (error, timeout, cancel)
            // while a mid-sync refresh was still queued. The pull already
            // committed whatever chunks it got through, so those rows must
            // still reach the lists — otherwise a failed first sync leaves
            // the user staring at an empty Entries page.
            dispatchContentChanged()
          }

          // Any backend status event carrying an error (or transitioning to
          // 'synced') replaces the prior error state. Crucially that also
          // clears `lastErrorKey` so a stale watchdog-fired key doesn't keep
          // showing through a later backend message — and so a late 'synced'
          // event after a watchdog fire correctly resets the UI to clean.
          //
          // Special case: when the backend error carries FORCE_RE_PAIR_REQUIRED
          // we adopt it as a force_re_pair_required action so the panel can show
          // a Repair button. All other backend errors keep lastErrorAction null
          // (they come from a different channel than the SyncSummary aggregator).
          let nextErrorAction = get().lastErrorAction
          let nextErrorKey: string | null
          if (payload.state === 'synced') {
            nextErrorAction = null
            nextErrorKey = null
          } else if (payload.error !== null) {
            nextErrorAction = payload.error.includes('FORCE_RE_PAIR_REQUIRED')
              ? detectActionableError([payload.error])
              : null
            // Transient transport failures get a friendly localized message
            // instead of the raw `network: error sending request for url (...)`.
            nextErrorKey = networkErrorKey([payload.error])
          } else {
            nextErrorKey = get().lastErrorKey
          }
          set({
            phase: payload.state,
            status: {
              enabled: payload.enabled,
              configured: payload.configured ?? get().status?.configured ?? false,
              provider: payload.provider,
              lastSync: payload.lastSync,
              entriesPending: payload.entriesPending,
            },
            isSyncing: nowSyncing,
            lastError: payload.error ?? (payload.state === 'synced' ? null : get().lastError),
            lastErrorKey: nextErrorKey,
            lastErrorAction: nextErrorAction,
            // Clear the retry timer when a new sync starts or completes —
            // the backend emits its own clear too, but this covers the
            // UI-driven syncNow path instantly.
            ...(nowSyncing || payload.state === 'synced' ? { retryAt: null } : {}),
          })
        })
        set({ unlisten })
      } catch (err) {
        console.warn('syncStore: listen SYNC_STATUS_EVENT failed', err)
      }

      // Progress listener.
      try {
        const unlistenProgress = await listen<SyncProgressEvent>(SYNC_PROGRESS_EVENT, (event) => {
          // Re-arm watchdog: each progress event proves the engine is alive.
          armWatchdog(get, (partial) => set(partial))
          // Let the lists fill in as the pull lands rows, instead of staying
          // empty until the terminal 'synced' event.
          scheduleMidSyncRefresh(event.payload.phase)
          set({ progress: event.payload })
        })
        set({ unlistenProgress })
      } catch (err) {
        console.warn('syncStore: listen SYNC_PROGRESS_EVENT failed', err)
      }

      // Authoritative recovery status — survives app restart so Settings can
      // surface resume/cancel and keep Sync Now disabled while a job is active.
      try {
        const unlistenRecovery = await listen<SyncRecoveryStatus | null>(
          SYNC_RECOVERY_STATUS_EVENT,
          (event) => {
            set({ recovery: event.payload ?? null })
          },
        )
        set({ unlistenRecovery })
      } catch (err) {
        console.warn('syncStore: listen SYNC_RECOVERY_STATUS_EVENT failed', err)
      }

      // Retry-scheduled — scheduler signals when the next auto-retry fires.
      try {
        const unlistenRetry = await listen<SyncRetryScheduledPayload>(
          SYNC_RETRY_SCHEDULED_EVENT,
          (event) => {
            set({ retryAt: event.payload.retry_at_ms })
          },
        )
        set({ unlistenRetry })
      } catch (err) {
        console.warn('syncStore: listen SYNC_RETRY_SCHEDULED_EVENT failed', err)
      }

      // Initial snapshot fetches. Failures are warned, not thrown — the
      // listener will fill state in once the next event arrives.
      const [deviceRes, statusRes, settingsRes, recoveryRes] = await Promise.allSettled([
        getDeviceId(),
        getSyncStatus(),
        tauriGetSyncSettings(),
        tauriGetSyncRecoveryStatus(),
      ])
      if (deviceRes.status === 'fulfilled') {
        set({ deviceId: deviceRes.value })
      } else {
        console.warn('syncStore: getDeviceId failed', deviceRes.reason)
      }
      if (statusRes.status === 'fulfilled') {
        // Don't clobber a fresher status that arrived via lifecycle event
        // during the await window. The event already wrote
        // `entriesPending` / `lastSync` and may carry an error we'd lose.
        if (!get().status) set({ status: statusRes.value })
      } else {
        console.warn('syncStore: getSyncStatus failed', statusRes.reason)
      }
      if (settingsRes.status === 'fulfilled') {
        set({ settings: settingsRes.value })
      } else {
        console.warn('syncStore: getSyncSettings failed', settingsRes.reason)
      }
      if (recoveryRes.status === 'fulfilled') {
        set({ recovery: recoveryRes.value })
      } else {
        console.warn('syncStore: getSyncRecoveryStatus failed', recoveryRes.reason)
      }

      set({ initialized: true, initPromise: null })
    })()

    set({ initPromise: promise })
    return promise
  },

  refresh: async () => {
    try {
      const next = await getSyncStatus()
      set({ status: next })
    } catch (err) {
      console.warn('syncStore: refresh failed', err)
    }
  },

  refreshSettings: async () => {
    try {
      const next = await tauriGetSyncSettings()
      set({ settings: next })
    } catch (err) {
      console.warn('syncStore: refreshSettings failed', err)
    }
  },

  refreshRecovery: async () => {
    try {
      const next = await tauriGetSyncRecoveryStatus()
      set({ recovery: next })
    } catch (err) {
      console.warn('syncStore: refreshRecovery failed', err)
    }
  },

  setEnabled: async (enabled) => {
    set({ lastError: null, lastErrorKey: null, lastErrorAction: null })
    try {
      await tauriSetSyncEnabled(enabled)
      await get().refresh()
    } catch (err) {
      set({
        lastError: err instanceof Error ? err.message : String(err),
        lastErrorKey: null,
        lastErrorAction: null,
      })
      throw err
    }
  },

  syncNow: async () => {
    if (get().inflightSync) {
      return get().lastSummary ?? emptySummary
    }
    // Backend also rejects with authoritative_recovery_in_progress; block
    // early so the UI does not enter a fake syncing state.
    if (get().recovery?.blocksNormalSync) {
      const msg = 'authoritative_recovery_in_progress'
      set({
        lastError: msg,
        lastErrorKey: null,
        lastErrorAction: null,
      })
      throw new Error(msg)
    }
    set({
      inflightSync: true,
      isSyncing: true,
      lastError: null,
      lastErrorKey: null,
      lastErrorAction: null,
      retryAt: null,
    })
    // Arm the watchdog when syncNow starts (the status-changed 'syncing' event
    // will re-arm it shortly, but arm early to cover the window before the
    // first backend event arrives).
    armWatchdog(get, (partial) => set(partial))
    // Set when the backend's single-flight guard rejected us because another
    // cycle is already running — that cycle now owns the syncing presentation,
    // so the finally block must not tear it down.
    let handedOffToInflightCycle = false
    try {
      const summary = await tauriSyncNow()
      set({ lastSummary: summary })
      if (summary.errors.length > 0) {
        set({
          lastError: summary.errors.join('; '),
          lastErrorKey: networkErrorKey(summary.errors),
          lastErrorAction: detectActionableError(summary.errors),
        })
      }
      await get().refresh()
      return summary
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg === SYNC_IN_PROGRESS_ERR) {
        // Another guard-holder already owns the backend single-flight guard —
        // a "skip, no harm done" marker, not an error. Mirror the frontend
        // inflightSync guard above and resolve with the last summary instead
        // of surfacing an error.
        //
        // Keep the syncing presentation ONLY when a backend 'syncing' event
        // confirmed a real sync cycle is running (phase is event-driven) —
        // that cycle's terminal event clears `isSyncing` and the watchdog.
        // Guard-holders that never emit lifecycle events (gdrive OAuth
        // connect, cloud wipe, authoritative restore, re-pair recheck) must
        // not pin the UI at "syncing", so anything else falls through to the
        // normal finally teardown and the UI returns to its previous state.
        set({ inflightSync: false })
        if (get().isSyncing && get().phase === 'syncing') {
          handedOffToInflightCycle = true
        }
        return get().lastSummary ?? emptySummary
      }
      set({
        lastError: msg,
        lastErrorKey: null,
        lastErrorAction: detectActionableError([msg]),
      })
      throw err
    } finally {
      if (!handedOffToInflightCycle) {
        clearWatchdog(get, (partial) => set(partial))
        set({ inflightSync: false, isSyncing: false, progress: null })
      }
    }
  },

  pushEntry: async (entryId) => {
    await tauriPushEntry(entryId)
  },

  updateSettings: async (next) => {
    await tauriSetSyncSettings(next)
    set({ settings: next })
  },

  resumeRecovery: async () => {
    const next = await tauriGdriveResumeSyncRecovery()
    // After a completing step the command returns a completed snapshot but
    // emits null for the event; keep store in sync with the active-only rule.
    set({ recovery: next.isActive ? next : null })
    await get().refresh()
    return next
  },

  cancelRecovery: async () => {
    const next = await tauriGdriveCancelSyncRecovery()
    set({ recovery: null })
    await get().refresh()
    return next
  },

  preflightLocalRecovery: async () => {
    try {
      const result = await tauriGdrivePreflightLocalAuthoritativeRecovery()
      await get().refreshRecovery()
      return result
    } catch (err) {
      // Job may have been marked failed / preflight_blocker — hydrate chrome.
      await get()
        .refreshRecovery()
        .catch(() => {})
      throw err
    }
  },

  beginCloudRecoveryStaging: async () => {
    try {
      const result = await tauriGdriveBeginCloudAuthoritativeStaging()
      await get().refreshRecovery()
      return result
    } catch (err) {
      await get()
        .refreshRecovery()
        .catch(() => {})
      throw err
    }
  },
}))

/**
 * Test-only reset. Detaches any active listeners and zeroes state so each
 * test starts with a clean slate. Not exported from a public barrel — only
 * tests should reach for it.
 */
export function __resetSyncStoreForTests() {
  const { unlisten, unlistenProgress, unlistenRecovery, unlistenRetry, watchdogTimer } =
    useSyncStore.getState()
  if (watchdogTimer !== null) clearTimeout(watchdogTimer)
  // Module-level, so it survives the state reset unless cancelled explicitly —
  // a leftover timer would fan out change events into the next test.
  cancelMidSyncRefresh()
  if (unlisten) {
    try {
      unlisten()
    } catch {
      /* ignore */
    }
  }
  if (unlistenProgress) {
    try {
      unlistenProgress()
    } catch {
      /* ignore */
    }
  }
  if (unlistenRecovery) {
    try {
      unlistenRecovery()
    } catch {
      /* ignore */
    }
  }
  if (unlistenRetry) {
    try {
      unlistenRetry()
    } catch {
      /* ignore */
    }
  }
  // Merge-only reset (replace=false): wipes data fields but preserves the
  // action methods Zustand attached at create time.
  useSyncStore.setState({ ...initialSnapshot })
}
