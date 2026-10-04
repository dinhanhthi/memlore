/**
 * Sync scenario helpers — typed factory functions for Tauri sync event payloads.
 *
 * All types are matched against the real interfaces in `src/lib/tauri.ts`:
 *   - SyncStatusEvent  (event: SYNC_STATUS_EVENT = 'sync:status-changed')
 *   - SyncProgressEvent (event: SYNC_PROGRESS_EVENT = 'sync:progress')
 *   - SYNC_SCOPE_UPGRADE_EVENT = 'sync:scope-upgrade-required'
 *   - SyncRecoveryStatus (event: SYNC_RECOVERY_STATUS_EVENT = 'sync:recovery-status-changed')
 */
import {
  SYNC_STATUS_EVENT,
  SYNC_PROGRESS_EVENT,
  SYNC_SCOPE_UPGRADE_EVENT,
  SYNC_RECOVERY_STATUS_EVENT,
  type SyncStatusEvent,
  type SyncProgressEvent,
  type SyncProgressPhase,
  type SyncRecoveryStatus,
  type GDriveStatus,
  type LocalAuthoritativePreflightResult,
  type CloudAuthoritativeStagingResult,
} from '../../src/lib/tauri'
import type { Scenario } from './types'

// Re-export constants so callers don't need to import from src/lib/tauri directly.
export {
  SYNC_STATUS_EVENT,
  SYNC_PROGRESS_EVENT,
  SYNC_SCOPE_UPGRADE_EVENT,
  SYNC_RECOVERY_STATUS_EVENT,
}

// ── Payload factories ──────────────────────────────────────────────────────────

export function makeSyncStatusEvent(overrides: Partial<SyncStatusEvent>): SyncStatusEvent {
  return {
    state: 'idle',
    enabled: true,
    provider: 'gdrive',
    lastSync: null,
    entriesPending: 0,
    error: null,
    ...overrides,
  }
}

export function makeSyncProgressEvent(
  phase: SyncProgressPhase,
  current: number,
  total: number,
): SyncProgressEvent {
  return { phase, current, total }
}

// ── Google Drive connection mocks ─────────────────────────────────────────────

/** Default connected GDrive snapshot for sync scenarios. */
export function makeGDriveStatus(overrides: Partial<GDriveStatus> = {}): GDriveStatus {
  return {
    connected: true,
    email: 'preview.user@gmail.com',
    storageUsed: 1_073_741_824,
    storageTotal: 17_179_869_184,
    // ~128 MB of Memlore data in appDataFolder (entries + media).
    storageAppUsed: 134_217_728,
    lastSync: Math.floor(Date.now() / 1000) - 5 * 60,
    ...overrides,
  }
}

/**
 * Invoke overrides for `gdrive_get_status` and `gdrive_refresh_storage_quota`.
 * GoogleDriveSettings calls both on mount when connected; without these mocks
 * the router returns null and `status.connected` throws.
 */
export function connectedGDriveInvoke(
  overrides: Partial<GDriveStatus> = {},
): Pick<NonNullable<Scenario['invoke']>, 'gdrive_get_status' | 'gdrive_refresh_storage_quota'> {
  const make = () => makeGDriveStatus(overrides)
  return {
    gdrive_get_status: make,
    gdrive_refresh_storage_quota: make,
  }
}

// ── emitOnLoad sequence builders ──────────────────────────────────────────────

/** Shape of one entry in the Scenario.emitOnLoad array. */
interface EmitEntry {
  event: string
  payload: unknown
  delayMs?: number
}

/**
 * Returns an `emitOnLoad` array that emits a `sync:status-changed` event with
 * `state: 'syncing'` shortly after mount (so the store listener is attached),
 * then fires several `sync:progress` ticks at increasing delays so the footer
 * animates through a live sync sequence.
 */
export function syncingEmits(): EmitEntry[] {
  return [
    // 50 ms — after mount so listener attached; kick off syncing state
    {
      event: SYNC_STATUS_EVENT,
      payload: makeSyncStatusEvent({
        state: 'syncing',
        enabled: true,
        provider: 'gdrive',
        lastSync: null,
        entriesPending: 3,
        error: null,
      }),
      delayMs: 50,
    },
    // 500 ms — pushing journals
    {
      event: SYNC_PROGRESS_EVENT,
      payload: makeSyncProgressEvent('pushing-journals', 1, 3),
      delayMs: 500,
    },
    // 1000 ms — pushing entries
    {
      event: SYNC_PROGRESS_EVENT,
      payload: makeSyncProgressEvent('pushing-entries', 2, 3),
      delayMs: 1000,
    },
    // 1500 ms — pulling manifests
    {
      event: SYNC_PROGRESS_EVENT,
      payload: makeSyncProgressEvent('pulling-manifests', 3, 3),
      delayMs: 1500,
    },
    // 2000 ms — pulling entries
    {
      event: SYNC_PROGRESS_EVENT,
      payload: makeSyncProgressEvent('pulling-entries', 3, 3),
      delayMs: 2000,
    },
    // 2500 ms — synced
    {
      event: SYNC_STATUS_EVENT,
      payload: makeSyncStatusEvent({
        state: 'synced',
        enabled: true,
        provider: 'gdrive',
        lastSync: Math.floor(Date.now() / 1000),
        entriesPending: 0,
        error: null,
      }),
      delayMs: 2500,
    },
  ]
}

/**
 * Returns an `emitOnLoad` array that emits a `sync:status-changed` error event
 * shortly after mount so the store listener is attached when the scenario loads.
 */
export function syncErrorEmits(errorMessage: string): EmitEntry[] {
  return [
    {
      event: SYNC_STATUS_EVENT,
      payload: makeSyncStatusEvent({
        state: 'error',
        enabled: true,
        provider: 'gdrive',
        lastSync: null,
        entriesPending: 2,
        error: errorMessage,
      }),
      delayMs: 50,
    },
  ]
}

/**
 * Returns an `emitOnLoad` array that emits a `sync:scope-upgrade-required`
 * event so the scope-upgrade banner renders immediately when the scenario loads.
 * The event payload is empty (the frontend re-reads `getSyncScopeUpgradeRequired()`).
 */
export function scopeUpgradeEmits(): EmitEntry[] {
  return [
    {
      event: SYNC_SCOPE_UPGRADE_EVENT,
      payload: null,
      delayMs: 0,
    },
  ]
}

// ── Authoritative recovery mocks ──────────────────────────────────────────────

/** Default active recovery job snapshot for Settings recovery UI scenarios. */
export function makeSyncRecoveryStatus(
  overrides: Partial<SyncRecoveryStatus> = {},
): SyncRecoveryStatus {
  const now = Math.floor(Date.now() / 1000)
  return {
    jobId: 1,
    operation: 'local_to_cloud',
    phase: 'transfer',
    status: 'running',
    recoveryGeneration: 2,
    backupPath: '/tmp/memlore-recovery-backup',
    stagingPath: '/tmp/memlore-recovery-staging',
    verifiedCounts: {},
    lastError: null,
    isActive: true,
    blocksNormalSync: true,
    canResume: true,
    canCancelSafely: true,
    nextStep: 'local_rebuild',
    errorClass: null,
    createdAt: now - 120,
    updatedAt: now,
    ...overrides,
  }
}

export function makeLocalPreflightResult(
  overrides: Partial<LocalAuthoritativePreflightResult> = {},
): LocalAuthoritativePreflightResult {
  return {
    jobId: 1,
    backupPath: '/tmp/memlore-recovery-backup',
    stagingPath: '/tmp/memlore-recovery-staging',
    mediaTotal: 10,
    mediaLocal: 10,
    mediaDownloaded: 0,
    ...overrides,
  }
}

export function makeCloudStagingResult(
  overrides: Partial<CloudAuthoritativeStagingResult> = {},
): CloudAuthoritativeStagingResult {
  return {
    jobId: 1,
    backupPath: '/tmp/memlore-recovery-backup',
    stagingPath: '/tmp/memlore-recovery-staging',
    stagingDbPath: '/tmp/memlore-recovery-staging/db',
    stagingMediaPath: '/tmp/memlore-recovery-staging/media',
    preservedSettingsPath: '/tmp/memlore-recovery-preserved-settings',
    cloudRecoveryGeneration: 2,
    jobRecoveryGeneration: 2,
    ...overrides,
  }
}

/**
 * Emit recovery status after mount so the store listener is already attached.
 * Prefer `get_sync_recovery_status` invoke for reload/hydrate; use this for
 * mid-session transitions.
 */
export function recoveryStatusEmits(status: SyncRecoveryStatus | null, delayMs = 50): EmitEntry[] {
  return [
    {
      event: SYNC_RECOVERY_STATUS_EVENT,
      payload: status,
      delayMs,
    },
  ]
}

/**
 * Successful preflight/staging mocks used by recovery confirmation modals.
 * Override individual keys when a scenario needs a blocked preflight.
 */
export function recoveryCommandInvoke(
  overrides: Partial<{
    get_sync_recovery_status: SyncRecoveryStatus | null | (() => SyncRecoveryStatus | null)
    gdrive_preflight_local_authoritative_recovery:
      | LocalAuthoritativePreflightResult
      | (() => LocalAuthoritativePreflightResult)
    gdrive_begin_cloud_authoritative_staging:
      | CloudAuthoritativeStagingResult
      | (() => CloudAuthoritativeStagingResult)
    gdrive_resume_sync_recovery: SyncRecoveryStatus | (() => SyncRecoveryStatus)
    gdrive_cancel_sync_recovery: SyncRecoveryStatus | (() => SyncRecoveryStatus)
    sync_reset_local_state: unknown
    gdrive_disconnect: unknown
    gdrive_wipe_cloud: unknown
  }> = {},
): NonNullable<Scenario['invoke']> {
  // Mutable active job: preflight/staging success hydrates a cancel-safe job
  // so Settings can test confirm-modal vs recovery-banner interaction.
  let activeJob: SyncRecoveryStatus | null = null

  const defaultGetStatus = () => activeJob
  const defaultPreflight = () => {
    activeJob = makeSyncRecoveryStatus({
      operation: 'local_to_cloud',
      phase: 'backup',
      status: 'running',
      isActive: true,
      blocksNormalSync: true,
      canResume: true,
      canCancelSafely: true,
      nextStep: 'local_rebuild',
      lastError: null,
      errorClass: null,
    })
    return makeLocalPreflightResult()
  }
  const defaultBeginStaging = () => {
    activeJob = makeSyncRecoveryStatus({
      operation: 'cloud_to_local',
      phase: 'backup',
      status: 'running',
      isActive: true,
      blocksNormalSync: true,
      canResume: true,
      canCancelSafely: true,
      nextStep: 'cloud_materialize',
      lastError: null,
      errorClass: null,
    })
    return makeCloudStagingResult()
  }
  const defaultCancel = () => {
    const cancelled = makeSyncRecoveryStatus({
      isActive: false,
      status: 'completed',
      blocksNormalSync: false,
      canResume: false,
      canCancelSafely: false,
      nextStep: null,
      lastError: 'cancelled',
      errorClass: null,
    })
    activeJob = null
    return cancelled
  }
  const defaultResume = () => {
    const completed = makeSyncRecoveryStatus({
      isActive: false,
      status: 'completed',
      blocksNormalSync: false,
      canResume: false,
      canCancelSafely: false,
      nextStep: null,
      phase: 'finalize',
      lastError: null,
      errorClass: null,
    })
    activeJob = null
    return completed
  }

  return {
    get_sync_recovery_status: defaultGetStatus,
    gdrive_preflight_local_authoritative_recovery: defaultPreflight,
    gdrive_begin_cloud_authoritative_staging: defaultBeginStaging,
    gdrive_resume_sync_recovery: defaultResume,
    gdrive_cancel_sync_recovery: defaultCancel,
    sync_reset_local_state: {
      queued: false,
      result: { entries: 3, media: 1, journals: 1 },
    },
    gdrive_disconnect: null,
    gdrive_wipe_cloud: null,
    ...overrides,
  }
}

// ── Convenience: pre-built emitOnLoad arrays ──────────────────────────────────
//
// These are exported as functions so they are evaluated lazily (the
// `Date.now()` call in `syncingEmits` picks up the current time at scenario
// load, not at module parse time).

export type SyncScenarioHelper = Pick<Scenario, 'emitOnLoad'>
