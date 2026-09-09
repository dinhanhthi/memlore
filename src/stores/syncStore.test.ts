import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { useSyncStore, __resetSyncStoreForTests } from './syncStore'
import { useAiSettingsStore } from './aiSettingsStore'
import type {
  SyncProgressEvent,
  SyncRecoveryStatus,
  SyncStatus,
  SyncStatusEvent,
  SyncSummary,
} from '../lib/tauri'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

// Capture event listeners keyed by event name so tests can fire synthetic payloads.
type AnyHandler = (event: { payload: unknown }) => void
const listenersByName: Record<string, AnyHandler[]> = {}

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((name: string, handler: AnyHandler) => {
    if (!listenersByName[name]) listenersByName[name] = []
    listenersByName[name].push(handler)
    return Promise.resolve(() => {
      const arr = listenersByName[name]
      if (arr) {
        const idx = arr.indexOf(handler)
        if (idx >= 0) arr.splice(idx, 1)
      }
    })
  }),
}))

vi.mock('../lib/tauri', async () => {
  const actual = await vi.importActual<typeof import('../lib/tauri')>('../lib/tauri')
  return {
    ...actual,
    getDeviceId: vi.fn(),
    getSyncStatus: vi.fn(),
    getSyncSettings: vi.fn(),
    getSyncRecoveryStatus: vi.fn(),
    getAiProviders: vi.fn(),
    gdriveResumeSyncRecovery: vi.fn(),
    gdriveCancelSyncRecovery: vi.fn(),
    gdrivePreflightLocalAuthoritativeRecovery: vi.fn(),
    gdriveBeginCloudAuthoritativeStaging: vi.fn(),
    setSyncSettings: vi.fn(),
    setSyncEnabled: vi.fn(),
    syncNow: vi.fn(),
    pushEntry: vi.fn(),
  }
})

import * as tauri from '../lib/tauri'

const STATUS_EVENT = 'sync:status-changed'
const PROGRESS_EVENT = 'sync:progress'
const RECOVERY_EVENT = 'sync:recovery-status-changed'

/** Fire a status-changed event to all registered listeners. */
function fireStatus(payload: SyncStatusEvent) {
  ;(listenersByName[STATUS_EVENT] ?? []).forEach((h) => h({ payload }))
}

/** Fire a progress event to all registered listeners. */
function fireProgress(payload: SyncProgressEvent) {
  ;(listenersByName[PROGRESS_EVENT] ?? []).forEach((h) => h({ payload }))
}

/** Fire a recovery status event to all registered listeners. */
function fireRecovery(payload: SyncRecoveryStatus | null) {
  ;(listenersByName[RECOVERY_EVENT] ?? []).forEach((h) => h({ payload }))
}

const defaultStatus: SyncStatus = {
  enabled: true,
  configured: true,
  provider: 'gdrive',
  lastSync: null,
  entriesPending: 0,
}

const defaultSummary: SyncSummary = {
  pushed: 0,
  pulled: 0,
  merged: 0,
  errors: [],
}

const activeRecovery: SyncRecoveryStatus = {
  jobId: 9,
  operation: 'local_to_cloud',
  phase: 'transfer',
  status: 'failed',
  recoveryGeneration: 4,
  backupPath: '/tmp/b.zip',
  stagingPath: '/tmp/s',
  verifiedCounts: {},
  lastError: 'upload failed',
  isActive: true,
  blocksNormalSync: true,
  canResume: true,
  canCancelSafely: false,
  nextStep: 'local_finalize',
  errorClass: 'retryable',
  createdAt: 1,
  updatedAt: 2,
}

beforeEach(() => {
  vi.resetAllMocks()
  // Clear captured listeners between tests.
  Object.keys(listenersByName).forEach((k) => delete listenersByName[k])
  vi.mocked(tauri.getDeviceId).mockResolvedValue('device-uuid')
  vi.mocked(tauri.getSyncStatus).mockResolvedValue(defaultStatus)
  vi.mocked(tauri.getSyncSettings).mockResolvedValue({
    intervalMinutes: 5,
    onSave: true,
    onLaunch: true,
  })
  vi.mocked(tauri.getSyncRecoveryStatus).mockResolvedValue(null)
  vi.mocked(tauri.getAiProviders).mockResolvedValue({
    generation: null,
    image: null,
    embedding: null,
  })
  vi.mocked(tauri.syncNow).mockResolvedValue(defaultSummary)
  vi.mocked(tauri.setSyncEnabled).mockResolvedValue()
  vi.mocked(tauri.setSyncSettings).mockResolvedValue()
  vi.mocked(tauri.pushEntry).mockResolvedValue()
  __resetSyncStoreForTests()
})

afterEach(() => {
  __resetSyncStoreForTests()
})

describe('syncStore', () => {
  it('initializes lazily on first init() call and fetches device + status + settings', async () => {
    await useSyncStore.getState().init()
    expect(tauri.getDeviceId).toHaveBeenCalledTimes(1)
    expect(tauri.getSyncStatus).toHaveBeenCalledTimes(1)
    expect(tauri.getSyncSettings).toHaveBeenCalledTimes(1)
    expect(tauri.getSyncRecoveryStatus).toHaveBeenCalledTimes(1)
    expect(useSyncStore.getState().deviceId).toBe('device-uuid')
    expect(useSyncStore.getState().status).toEqual(defaultStatus)
    expect(useSyncStore.getState().recovery).toBeNull()
  })

  it('hydrates interrupted recovery after restart so Sync Now can stay disabled', async () => {
    vi.mocked(tauri.getSyncRecoveryStatus).mockResolvedValue(activeRecovery)
    await useSyncStore.getState().init()
    expect(useSyncStore.getState().recovery).toEqual(activeRecovery)
    expect(useSyncStore.getState().recovery?.blocksNormalSync).toBe(true)
  })

  it('init() is idempotent: a second call does not re-subscribe or re-fetch', async () => {
    await useSyncStore.getState().init()
    await useSyncStore.getState().init()
    expect(tauri.getDeviceId).toHaveBeenCalledTimes(1)
    expect(tauri.getSyncStatus).toHaveBeenCalledTimes(1)
    // One status + one progress + one recovery listener.
    expect((listenersByName[STATUS_EVENT] ?? []).length).toBe(1)
    expect((listenersByName[PROGRESS_EVENT] ?? []).length).toBe(1)
    expect((listenersByName[RECOVERY_EVENT] ?? []).length).toBe(1)
  })

  it('recovery status events update store without touching sync phase', async () => {
    await useSyncStore.getState().init()
    fireRecovery(activeRecovery)
    expect(useSyncStore.getState().recovery?.jobId).toBe(9)
    expect(useSyncStore.getState().phase).toBe('idle')
    fireRecovery(null)
    expect(useSyncStore.getState().recovery).toBeNull()
  })

  it('syncNow rejects while recovery blocks normal sync', async () => {
    await useSyncStore.getState().init()
    useSyncStore.setState({ recovery: activeRecovery })
    await expect(useSyncStore.getState().syncNow()).rejects.toThrow(
      'authoritative_recovery_in_progress',
    )
    expect(tauri.syncNow).not.toHaveBeenCalled()
  })

  it('resumeRecovery refreshes recovery snapshot and clears when completed', async () => {
    await useSyncStore.getState().init()
    useSyncStore.setState({ recovery: activeRecovery })
    const completed: SyncRecoveryStatus = {
      ...activeRecovery,
      status: 'completed',
      isActive: false,
      blocksNormalSync: false,
      canResume: false,
      nextStep: null,
      lastError: null,
      errorClass: null,
    }
    vi.mocked(tauri.gdriveResumeSyncRecovery).mockResolvedValue(completed)
    const result = await useSyncStore.getState().resumeRecovery()
    expect(result.status).toBe('completed')
    expect(useSyncStore.getState().recovery).toBeNull()
    expect(tauri.getSyncStatus).toHaveBeenCalled()
  })

  it('cancelRecovery clears active recovery after cancel-safe abandon', async () => {
    await useSyncStore.getState().init()
    useSyncStore.setState({ recovery: { ...activeRecovery, canCancelSafely: true } })
    vi.mocked(tauri.gdriveCancelSyncRecovery).mockResolvedValue({
      ...activeRecovery,
      status: 'completed',
      isActive: false,
      lastError: 'cancelled',
    })
    await useSyncStore.getState().cancelRecovery()
    expect(useSyncStore.getState().recovery).toBeNull()
    expect(tauri.gdriveCancelSyncRecovery).toHaveBeenCalledTimes(1)
  })

  it('preflightLocalRecovery invokes backend and hydrates recovery', async () => {
    await useSyncStore.getState().init()
    const preflight = {
      jobId: 3,
      backupPath: '/b.zip',
      stagingPath: '/s',
      mediaTotal: 1,
      mediaLocal: 1,
      mediaDownloaded: 0,
    }
    vi.mocked(tauri.gdrivePreflightLocalAuthoritativeRecovery).mockResolvedValue(preflight)
    vi.mocked(tauri.getSyncRecoveryStatus).mockResolvedValue({
      ...activeRecovery,
      phase: 'backup',
      status: 'running',
      canCancelSafely: true,
      canResume: true,
      nextStep: 'local_rebuild',
      lastError: null,
      errorClass: null,
    })
    const result = await useSyncStore.getState().preflightLocalRecovery()
    expect(result).toEqual(preflight)
    expect(tauri.gdrivePreflightLocalAuthoritativeRecovery).toHaveBeenCalledTimes(1)
    expect(useSyncStore.getState().recovery?.phase).toBe('backup')
  })

  it('beginCloudRecoveryStaging hydrates recovery after staging', async () => {
    await useSyncStore.getState().init()
    const staging = {
      jobId: 4,
      backupPath: '/b.zip',
      stagingPath: '/s',
      stagingDbPath: '/s/db',
      stagingMediaPath: '/s/media',
      preservedSettingsPath: '/p',
      cloudRecoveryGeneration: 2,
      jobRecoveryGeneration: 2,
    }
    vi.mocked(tauri.gdriveBeginCloudAuthoritativeStaging).mockResolvedValue(staging)
    vi.mocked(tauri.getSyncRecoveryStatus).mockResolvedValue({
      ...activeRecovery,
      operation: 'cloud_to_local',
      phase: 'backup',
      canCancelSafely: true,
      nextStep: 'cloud_materialize',
      lastError: null,
      errorClass: null,
    })
    await useSyncStore.getState().beginCloudRecoveryStaging()
    expect(tauri.gdriveBeginCloudAuthoritativeStaging).toHaveBeenCalledTimes(1)
    expect(useSyncStore.getState().recovery?.operation).toBe('cloud_to_local')
  })

  it('preflightLocalRecovery still refreshes recovery after failure', async () => {
    await useSyncStore.getState().init()
    vi.mocked(tauri.gdrivePreflightLocalAuthoritativeRecovery).mockRejectedValue(
      new Error('Local media incomplete'),
    )
    vi.mocked(tauri.getSyncRecoveryStatus).mockResolvedValue({
      ...activeRecovery,
      phase: 'preflight',
      status: 'failed',
      canResume: false,
      canCancelSafely: true,
      errorClass: 'preflight_blocker',
      lastError: 'Local media incomplete',
    })
    await expect(useSyncStore.getState().preflightLocalRecovery()).rejects.toThrow(
      'Local media incomplete',
    )
    expect(useSyncStore.getState().recovery?.errorClass).toBe('preflight_blocker')
  })

  it('preserves lastError and phase across simulated remount (no re-init)', async () => {
    await useSyncStore.getState().init()
    fireStatus({
      state: 'error',
      enabled: true,
      provider: 'gdrive',
      lastSync: null,
      entriesPending: 13,
      error: 'fingerprint mismatch',
    })
    expect(useSyncStore.getState().phase).toBe('error')
    expect(useSyncStore.getState().lastError).toBe('fingerprint mismatch')

    // Simulate consumer remount: just call init again. State must survive.
    await useSyncStore.getState().init()
    expect(useSyncStore.getState().phase).toBe('error')
    expect(useSyncStore.getState().lastError).toBe('fingerprint mismatch')
    expect(useSyncStore.getState().status?.entriesPending).toBe(13)
  })

  it('lifecycle syncing event flips isSyncing and entriesPending in real time', async () => {
    await useSyncStore.getState().init()
    fireStatus({
      state: 'syncing',
      enabled: true,
      provider: 'gdrive',
      lastSync: null,
      entriesPending: 7,
      error: null,
    })
    expect(useSyncStore.getState().phase).toBe('syncing')
    expect(useSyncStore.getState().isSyncing).toBe(true)
    expect(useSyncStore.getState().status?.entriesPending).toBe(7)
  })

  it('synced event clears lastError', async () => {
    await useSyncStore.getState().init()
    fireStatus({
      state: 'error',
      enabled: true,
      provider: 'gdrive',
      lastSync: null,
      entriesPending: 1,
      error: 'boom',
    })
    expect(useSyncStore.getState().lastError).toBe('boom')

    fireStatus({
      state: 'synced',
      enabled: true,
      provider: 'gdrive',
      lastSync: 1_700_000_000,
      entriesPending: 0,
      error: null,
    })
    expect(useSyncStore.getState().lastError).toBeNull()
    expect(useSyncStore.getState().phase).toBe('synced')
  })

  it('refreshes AI providers once on a fresh transition into synced', async () => {
    const refreshProviders = vi
      .spyOn(useAiSettingsStore.getState(), 'refreshProviders')
      .mockResolvedValue({ generation: null, image: null, embedding: null })
    await useSyncStore.getState().init()

    fireStatus({
      state: 'synced',
      enabled: true,
      provider: 'gdrive',
      lastSync: 1_700_000_000,
      entriesPending: 0,
      error: null,
    })
    fireStatus({
      state: 'synced',
      enabled: true,
      provider: 'gdrive',
      lastSync: 1_700_000_000,
      entriesPending: 0,
      error: null,
    })

    expect(refreshProviders).toHaveBeenCalledTimes(1)
    refreshProviders.mockRestore()
  })

  it('keeps synced state when the non-blocking AI provider refresh fails', async () => {
    const refreshProviders = vi
      .spyOn(useAiSettingsStore.getState(), 'refreshProviders')
      .mockRejectedValue(new Error('provider refresh failed'))
    await useSyncStore.getState().init()

    fireStatus({
      state: 'synced',
      enabled: true,
      provider: 'gdrive',
      lastSync: 1_700_000_000,
      entriesPending: 0,
      error: null,
    })
    await Promise.resolve()

    expect(refreshProviders).toHaveBeenCalledTimes(1)
    expect(useSyncStore.getState().phase).toBe('synced')
    expect(useSyncStore.getState().lastError).toBeNull()
    refreshProviders.mockRestore()
  })

  it('syncNow is guarded against concurrent re-entry', async () => {
    let resolve!: (s: SyncSummary) => void
    vi.mocked(tauri.syncNow).mockReturnValueOnce(
      new Promise<SyncSummary>((r) => {
        resolve = r
      }),
    )
    await useSyncStore.getState().init()
    const p1 = useSyncStore.getState().syncNow()
    const p2 = useSyncStore.getState().syncNow()
    resolve({ pushed: 1, pulled: 0, merged: 0, errors: [] })
    await Promise.all([p1, p2])
    expect(tauri.syncNow).toHaveBeenCalledTimes(1)
  })

  it('syncNow sync_in_progress rejection keeps syncing state instead of surfacing an error', async () => {
    vi.mocked(tauri.syncNow).mockRejectedValueOnce(new Error('sync_in_progress'))
    await useSyncStore.getState().init()

    // A background cycle (scheduler tick) is running — backend confirmed it.
    fireStatus({
      state: 'syncing',
      enabled: true,
      provider: 'gdrive',
      lastSync: null,
      entriesPending: 3,
      error: null,
    })

    // Resolves (like the inflightSync guard) instead of throwing.
    const summary = await useSyncStore.getState().syncNow()
    expect(summary).toEqual({ pushed: 0, pulled: 0, merged: 0, errors: [] })

    const s = useSyncStore.getState()
    expect(s.lastError).toBeNull()
    expect(s.lastErrorKey).toBeNull()
    expect(s.lastErrorAction).toBeNull()
    expect(s.phase).toBe('syncing')
    expect(s.isSyncing).toBe(true)
    expect(s.inflightSync).toBe(false)
    // Handoff keeps the watchdog armed — the in-flight cycle's terminal
    // event is now responsible for clearing it.
    expect(s.watchdogTimer).not.toBeNull()

    // The in-flight cycle's completion event finishes the presentation.
    fireStatus({
      state: 'synced',
      enabled: true,
      provider: 'gdrive',
      lastSync: 1_700_000_000,
      entriesPending: 0,
      error: null,
    })
    expect(useSyncStore.getState().isSyncing).toBe(false)
    expect(useSyncStore.getState().phase).toBe('synced')
    expect(useSyncStore.getState().watchdogTimer).toBeNull()
  })

  it('syncNow sync_in_progress rejection returns the previous summary when one exists', async () => {
    const prior: SyncSummary = { pushed: 4, pulled: 2, merged: 1, errors: [] }
    vi.mocked(tauri.syncNow).mockRejectedValueOnce(new Error('sync_in_progress'))
    await useSyncStore.getState().init()
    useSyncStore.setState({ lastSummary: prior })

    const summary = await useSyncStore.getState().syncNow()
    expect(summary).toEqual(prior)
  })

  it('syncNow sync_in_progress rejection without a confirmed cycle restores the previous state', async () => {
    // Guard held by a non-sync flow (OAuth connect, cloud wipe, …) that never
    // emits lifecycle events: no 'syncing' event arrives, so the UI must NOT
    // pin at "syncing" — it returns to its previous state, still error-free.
    vi.mocked(tauri.syncNow).mockRejectedValueOnce(new Error('sync_in_progress'))
    await useSyncStore.getState().init()

    await useSyncStore.getState().syncNow()

    const s = useSyncStore.getState()
    expect(s.lastError).toBeNull()
    expect(s.phase).toBe('idle')
    expect(s.isSyncing).toBe(false)
    expect(s.inflightSync).toBe(false)
    expect(s.watchdogTimer).toBeNull()
  })

  it('syncNow sync_in_progress rejection keeps an error completion that beat it', async () => {
    let reject!: (e: Error) => void
    vi.mocked(tauri.syncNow).mockReturnValueOnce(
      new Promise<SyncSummary>((_, r) => {
        reject = r
      }),
    )
    await useSyncStore.getState().init()
    const p = useSyncStore.getState().syncNow()

    // The guard-holding cycle fails before the rejection is processed — its
    // real error must survive, not be replaced by a fake syncing state.
    fireStatus({
      state: 'error',
      enabled: true,
      provider: 'gdrive',
      lastSync: null,
      entriesPending: 2,
      error: 'boom',
    })
    reject(new Error('sync_in_progress'))
    await p

    const s = useSyncStore.getState()
    expect(s.phase).toBe('error')
    expect(s.isSyncing).toBe(false)
    expect(s.lastError).toBe('boom')
  })

  it('syncNow sync_in_progress rejection does not re-enter syncing when the cycle already completed', async () => {
    let reject!: (e: Error) => void
    vi.mocked(tauri.syncNow).mockReturnValueOnce(
      new Promise<SyncSummary>((_, r) => {
        reject = r
      }),
    )
    await useSyncStore.getState().init()
    const p = useSyncStore.getState().syncNow()

    // The guard-holding cycle finishes before the rejection is processed.
    fireStatus({
      state: 'synced',
      enabled: true,
      provider: 'gdrive',
      lastSync: 1_700_000_000,
      entriesPending: 0,
      error: null,
    })
    reject(new Error('sync_in_progress'))
    await p

    const s = useSyncStore.getState()
    expect(s.phase).toBe('synced')
    expect(s.isSyncing).toBe(false)
    expect(s.lastError).toBeNull()
  })

  // ── Progress tracking ────────────────────────────────────────────────────

  it('progress event updates store.progress', async () => {
    await useSyncStore.getState().init()

    expect(useSyncStore.getState().progress).toBeNull()

    // Simulate backend emitting a progress event.
    fireProgress({
      phase: 'pushing-entries',
      current: 3,
      total: 10,
    })

    expect(useSyncStore.getState().progress).toEqual({
      phase: 'pushing-entries',
      current: 3,
      total: 10,
    })
  })

  // ── Mid-sync list refresh ────────────────────────────────────────────────
  // A first sync on a freshly-joined device writes rows continuously; without
  // these dispatches the Entries page stays empty until the terminal 'synced'
  // event, even though the rows already landed locally.

  it('fans out content-changed events (debounced) while pulling', async () => {
    vi.useFakeTimers()
    try {
      await useSyncStore.getState().init()
      const onEntries = vi.fn()
      const onChats = vi.fn()
      window.addEventListener('memlore:entries-changed', onEntries)
      window.addEventListener('memlore:chats-changed', onChats)

      fireProgress({ phase: 'pulling-entries', current: 10, total: 400 })
      fireProgress({ phase: 'pulling-entries', current: 20, total: 400 })
      // Trailing debounce: nothing yet, and the burst collapses into one.
      expect(onEntries).not.toHaveBeenCalled()
      expect(onChats).not.toHaveBeenCalled()

      vi.advanceTimersByTime(1000)
      expect(onEntries).toHaveBeenCalledTimes(1)
      expect(onChats).toHaveBeenCalledTimes(1)

      window.removeEventListener('memlore:entries-changed', onEntries)
      window.removeEventListener('memlore:chats-changed', onChats)
    } finally {
      vi.useRealTimers()
    }
  })

  it('refreshes AI providers (debounced) while pulling', async () => {
    vi.useFakeTimers()
    const refreshProviders = vi
      .spyOn(useAiSettingsStore.getState(), 'refreshProviders')
      .mockResolvedValue({ generation: null, image: null, embedding: null })
    try {
      await useSyncStore.getState().init()
      fireProgress({ phase: 'pulling-entries', current: 10, total: 400 })
      fireProgress({ phase: 'pulling-entries', current: 20, total: 400 })
      expect(refreshProviders).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1000)
      expect(refreshProviders).toHaveBeenCalledTimes(1)
    } finally {
      refreshProviders.mockRestore()
      vi.useRealTimers()
    }
  })

  it('does not fan out on pushing phases', async () => {
    vi.useFakeTimers()
    try {
      await useSyncStore.getState().init()
      const onEntries = vi.fn()
      window.addEventListener('memlore:entries-changed', onEntries)

      // Pushes upload local rows — nothing this device displays changes.
      fireProgress({ phase: 'pushing-entries', current: 3, total: 10 })
      vi.advanceTimersByTime(5000)
      expect(onEntries).not.toHaveBeenCalled()

      window.removeEventListener('memlore:entries-changed', onEntries)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not double-fire when a sync reaches synced with a refresh queued', async () => {
    vi.useFakeTimers()
    try {
      await useSyncStore.getState().init()
      const onEntries = vi.fn()

      fireStatus({
        state: 'syncing',
        enabled: true,
        provider: 'gdrive',
        lastSync: null,
        entriesPending: 3,
        error: null,
      })
      fireProgress({ phase: 'pulling-entries', current: 10, total: 400 })

      window.addEventListener('memlore:entries-changed', onEntries)
      fireStatus({
        state: 'synced',
        enabled: true,
        provider: 'gdrive',
        lastSync: 1_700_000_000,
        entriesPending: 0,
        error: null,
      })
      // The terminal fan-out fires once; the queued debounce is absorbed by
      // it rather than firing a second time a beat later.
      expect(onEntries).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(5000)
      expect(onEntries).toHaveBeenCalledTimes(1)

      window.removeEventListener('memlore:entries-changed', onEntries)
    } finally {
      vi.useRealTimers()
    }
  })

  it('still fans out when a sync FAILS mid-pull with a refresh queued', async () => {
    // A pull commits each chunk in its own transaction, so a mid-pull failure
    // leaves real rows on disk. Dropping the queued refresh here would leave
    // the freshly-joined device staring at an empty Entries page.
    vi.useFakeTimers()
    try {
      await useSyncStore.getState().init()
      const onEntries = vi.fn()

      fireStatus({
        state: 'syncing',
        enabled: true,
        provider: 'gdrive',
        lastSync: null,
        entriesPending: 3,
        error: null,
      })
      fireProgress({ phase: 'pulling-entries', current: 10, total: 400 })

      window.addEventListener('memlore:entries-changed', onEntries)
      fireStatus({
        state: 'error',
        enabled: true,
        provider: 'gdrive',
        lastSync: null,
        entriesPending: 3,
        error: 'network: connection reset',
      })
      expect(onEntries).toHaveBeenCalledTimes(1)

      window.removeEventListener('memlore:entries-changed', onEntries)
    } finally {
      vi.useRealTimers()
    }
  })

  it('never fires the cloud-hitting devices-changed event mid-sync', async () => {
    // `memlore:devices-changed` re-fetches the device list FROM Drive. It
    // belongs to the terminal fan-out only — on a progress tick it would
    // hammer the cloud once per second for the whole sync.
    vi.useFakeTimers()
    try {
      await useSyncStore.getState().init()
      const onDevices = vi.fn()
      window.addEventListener('memlore:devices-changed', onDevices)

      fireProgress({ phase: 'pulling-entries', current: 10, total: 400 })
      vi.advanceTimersByTime(5000)
      expect(onDevices).not.toHaveBeenCalled()

      window.removeEventListener('memlore:devices-changed', onDevices)
    } finally {
      vi.useRealTimers()
    }
  })

  it('progress is reset to null when status transitions away from syncing', async () => {
    await useSyncStore.getState().init()

    fireProgress({ phase: 'pushing-entries', current: 5, total: 12 })
    expect(useSyncStore.getState().progress).not.toBeNull()

    // Syncing → synced: progress should be cleared.
    fireStatus({
      state: 'synced',
      enabled: true,
      provider: 'gdrive',
      lastSync: 1_700_000_000,
      entriesPending: 0,
      error: null,
    })

    expect(useSyncStore.getState().progress).toBeNull()
  })

  it('progress is reset to null on error state transition', async () => {
    await useSyncStore.getState().init()

    fireProgress({ phase: 'pulling-entries', current: 2, total: 5 })
    expect(useSyncStore.getState().progress).not.toBeNull()

    fireStatus({
      state: 'error',
      enabled: true,
      provider: 'gdrive',
      lastSync: null,
      entriesPending: 0,
      error: 'network failure',
    })

    expect(useSyncStore.getState().progress).toBeNull()
  })

  // ── Watchdog ─────────────────────────────────────────────────────────────

  it('watchdog fires after 130s of silence and force-resets to error with i18n key', async () => {
    vi.useFakeTimers()
    try {
      // syncNow that never resolves — simulates a hanging backend.
      vi.mocked(tauri.syncNow).mockReturnValueOnce(new Promise(() => {}))
      await useSyncStore.getState().init()

      // Start a syncNow (will hang).
      void useSyncStore.getState().syncNow()
      // Flush microtasks so store state updates (inflightSync, isSyncing = true).
      await Promise.resolve()

      expect(useSyncStore.getState().isSyncing).toBe(true)

      // Advance past the watchdog interval (130s) — watchdog should fire.
      // The interval is intentionally longer than the backend's own 120s
      // timeout so the backend always speaks first when both are running.
      await vi.advanceTimersByTimeAsync(131_000)

      expect(useSyncStore.getState().phase).toBe('error')
      expect(useSyncStore.getState().isSyncing).toBe(false)
      expect(useSyncStore.getState().inflightSync).toBe(false)
      expect(useSyncStore.getState().progress).toBeNull()
      // The watchdog stores the i18n KEY, not a translated string, so the
      // renderer can localize it at render time. This decoupling also
      // protects against the watchdog firing before i18n initialization
      // completes (which used to surface the literal key to the user).
      expect(useSyncStore.getState().lastErrorKey).toBe('nav:sync.timeout')
      expect(useSyncStore.getState().lastError).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('watchdog is re-armed by progress events (does not fire if events keep arriving)', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(tauri.syncNow).mockReturnValueOnce(new Promise(() => {}))
      await useSyncStore.getState().init()

      void useSyncStore.getState().syncNow()
      await Promise.resolve()

      // Keep sending progress events every 60s — watchdog (130s interval)
      // must not fire because each event re-arms the timer.
      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersByTimeAsync(60_000)
        fireProgress({ phase: 'pushing-entries', current: i, total: 10 })
      }
      // Total elapsed: 300s, but each progress event re-armed the watchdog.
      // isSyncing should still be true.
      expect(useSyncStore.getState().isSyncing).toBe(true)
      expect(useSyncStore.getState().phase).not.toBe('error')
    } finally {
      vi.useRealTimers()
    }
  })

  it('watchdog timer is cleared when syncNow resolves normally', async () => {
    vi.useFakeTimers()
    try {
      await useSyncStore.getState().init()
      await useSyncStore.getState().syncNow()

      // After sync completes, the watchdog should be cleared.
      expect(useSyncStore.getState().watchdogTimer).toBeNull()
      // Advancing past the watchdog interval should not change phase to error.
      await vi.advanceTimersByTimeAsync(131_000)
      expect(useSyncStore.getState().phase).not.toBe('error')
    } finally {
      vi.useRealTimers()
    }
  })

  it('late backend success after watchdog fires resets lastErrorKey', async () => {
    // Regression for the ghost-recovery race the review flagged. Even though
    // WATCHDOG_MS > backend timeout makes this race unreachable in practice,
    // the listener should still clear `lastErrorKey` when a real backend
    // event arrives, so a stale key never leaks into a later sync's UI.
    vi.useFakeTimers()
    try {
      vi.mocked(tauri.syncNow).mockReturnValueOnce(new Promise(() => {}))
      await useSyncStore.getState().init()

      void useSyncStore.getState().syncNow()
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(131_000)
      expect(useSyncStore.getState().lastErrorKey).toBe('nav:sync.timeout')

      // Late backend success event arrives.
      fireStatus({
        state: 'synced',
        enabled: true,
        provider: 'gdrive',
        lastSync: 1_700_000_000,
        entriesPending: 0,
        error: null,
      })

      expect(useSyncStore.getState().phase).toBe('synced')
      expect(useSyncStore.getState().lastError).toBeNull()
      expect(useSyncStore.getState().lastErrorKey).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  // ── force_re_pair_required action detection ──────────────────────────────

  it('syncNow catch path sets force_re_pair_required action with reason=inconclusive', async () => {
    const backendMsg =
      'FORCE_RE_PAIR_REQUIRED reason=inconclusive: The cloud keyring could not be verified. Re-pair before syncing.'
    vi.mocked(tauri.syncNow).mockRejectedValueOnce(new Error(backendMsg))
    await useSyncStore.getState().init()
    await useSyncStore
      .getState()
      .syncNow()
      .catch(() => {})
    const action = useSyncStore.getState().lastErrorAction
    expect(action).toEqual({ kind: 'force_re_pair_required', reason: 'inconclusive' })
  })

  it('syncNow catch path sets force_re_pair_required action with reason=rotated', async () => {
    const backendMsg =
      'FORCE_RE_PAIR_REQUIRED reason=rotated: The vault was rotated on another device. Re-pair before syncing.'
    vi.mocked(tauri.syncNow).mockRejectedValueOnce(new Error(backendMsg))
    await useSyncStore.getState().init()
    await useSyncStore
      .getState()
      .syncNow()
      .catch(() => {})
    const action = useSyncStore.getState().lastErrorAction
    expect(action).toEqual({ kind: 'force_re_pair_required', reason: 'rotated' })
  })

  it('status event with FORCE_RE_PAIR_REQUIRED error sets force_re_pair_required action', async () => {
    await useSyncStore.getState().init()
    fireStatus({
      state: 'error',
      enabled: true,
      provider: 'gdrive',
      lastSync: null,
      entriesPending: 0,
      error:
        'FORCE_RE_PAIR_REQUIRED reason=inconclusive: The cloud keyring could not be verified. Re-pair before syncing.',
    })
    const action = useSyncStore.getState().lastErrorAction
    expect(action).toEqual({ kind: 'force_re_pair_required', reason: 'inconclusive' })
  })

  it('status event with non-force-re-pair backend error keeps lastErrorAction null', async () => {
    await useSyncStore.getState().init()
    fireStatus({
      state: 'error',
      enabled: true,
      provider: 'gdrive',
      lastSync: null,
      entriesPending: 0,
      error: 'network timeout',
    })
    expect(useSyncStore.getState().lastErrorAction).toBeNull()
  })

  // ── transient network transport errors ──────────────────────────────────

  it('syncNow summary with transport error sets friendly network_error lastErrorKey', async () => {
    vi.mocked(tauri.syncNow).mockResolvedValueOnce({
      pushed: 0,
      pulled: 0,
      merged: 0,
      errors: [
        'pull: templates: network: error sending request for url (https://www.googleapis.com/drive/v3/files?q=...&spaces=appDataFolder)',
      ],
    })
    await useSyncStore.getState().init()
    await useSyncStore.getState().syncNow()
    expect(useSyncStore.getState().lastErrorKey).toBe('nav:sync.network_error')
    // Raw backend string is preserved for debugging even though the UI
    // renders the friendly localized message.
    expect(useSyncStore.getState().lastError).toContain('error sending request for url')
    expect(useSyncStore.getState().lastErrorAction).toBeNull()
  })

  it('status event with transport error sets friendly network_error lastErrorKey', async () => {
    await useSyncStore.getState().init()
    fireStatus({
      state: 'error',
      enabled: true,
      provider: 'gdrive',
      lastSync: null,
      entriesPending: 0,
      error:
        'pull: templates: network: error sending request for url (https://www.googleapis.com/drive/v3/files?...&spaces=appDataFolder)',
    })
    expect(useSyncStore.getState().lastErrorKey).toBe('nav:sync.network_error')
  })

  it('non-transport backend error leaves lastErrorKey null (raw message shown)', async () => {
    await useSyncStore.getState().init()
    fireStatus({
      state: 'error',
      enabled: true,
      provider: 'gdrive',
      lastSync: null,
      entriesPending: 0,
      error: 'Drive read failed: 503',
    })
    expect(useSyncStore.getState().lastErrorKey).toBeNull()
  })

  it('non-error event (syncing, error=null) preserves an active force_re_pair_required action', async () => {
    await useSyncStore.getState().init()
    fireStatus({
      state: 'error',
      enabled: true,
      provider: 'gdrive',
      lastSync: null,
      entriesPending: 0,
      error:
        'FORCE_RE_PAIR_REQUIRED reason=inconclusive: The cloud keyring could not be verified. Re-pair before syncing.',
    })
    expect(useSyncStore.getState().lastErrorAction).toEqual({
      kind: 'force_re_pair_required',
      reason: 'inconclusive',
    })

    // A subsequent in-flight event with no error must NOT drop the action —
    // otherwise the Repair button would vanish mid-retry.
    fireStatus({
      state: 'syncing',
      enabled: true,
      provider: 'gdrive',
      lastSync: null,
      entriesPending: 0,
      error: null,
    })
    expect(useSyncStore.getState().lastErrorAction).toEqual({
      kind: 'force_re_pair_required',
      reason: 'inconclusive',
    })
  })

  it('status event with reason=rotated sets force_re_pair_required action', async () => {
    await useSyncStore.getState().init()
    fireStatus({
      state: 'error',
      enabled: true,
      provider: 'gdrive',
      lastSync: null,
      entriesPending: 0,
      error:
        'FORCE_RE_PAIR_REQUIRED reason=rotated: The vault was rotated on another device. Re-pair before syncing.',
    })
    expect(useSyncStore.getState().lastErrorAction).toEqual({
      kind: 'force_re_pair_required',
      reason: 'rotated',
    })
  })

  it('synced event clears force_re_pair_required action', async () => {
    await useSyncStore.getState().init()
    fireStatus({
      state: 'error',
      enabled: true,
      provider: 'gdrive',
      lastSync: null,
      entriesPending: 0,
      error:
        'FORCE_RE_PAIR_REQUIRED reason=rotated: The vault was rotated on another device. Re-pair before syncing.',
    })
    expect(useSyncStore.getState().lastErrorAction).not.toBeNull()

    fireStatus({
      state: 'synced',
      enabled: true,
      provider: 'gdrive',
      lastSync: 1_700_000_000,
      entriesPending: 0,
      error: null,
    })
    expect(useSyncStore.getState().lastErrorAction).toBeNull()
  })

  // ── retry-scheduled event ──────────────────────────────────────────────

  it('sync:retry-scheduled event sets retryAt', async () => {
    await useSyncStore.getState().init()
    const retryMs = Date.now() + 60_000
    ;(listenersByName['sync:retry-scheduled'] ?? []).forEach((h) =>
      h({ payload: { retry_at_ms: retryMs } }),
    )
    expect(useSyncStore.getState().retryAt).toBe(retryMs)
  })

  it('sync:retry-scheduled with null clears retryAt', async () => {
    await useSyncStore.getState().init()
    // Set it first.
    ;(listenersByName['sync:retry-scheduled'] ?? []).forEach((h) =>
      h({ payload: { retry_at_ms: Date.now() + 60_000 } }),
    )
    expect(useSyncStore.getState().retryAt).not.toBeNull()
    // Clear it.
    ;(listenersByName['sync:retry-scheduled'] ?? []).forEach((h) =>
      h({ payload: { retry_at_ms: null } }),
    )
    expect(useSyncStore.getState().retryAt).toBeNull()
  })

  it('syncing lifecycle event clears retryAt', async () => {
    await useSyncStore.getState().init()
    // Seed a retry.
    ;(listenersByName['sync:retry-scheduled'] ?? []).forEach((h) =>
      h({ payload: { retry_at_ms: Date.now() + 60_000 } }),
    )
    expect(useSyncStore.getState().retryAt).not.toBeNull()
    // Syncing event should clear it.
    fireStatus({
      state: 'syncing',
      enabled: true,
      provider: 'gdrive',
      lastSync: null,
      entriesPending: 0,
      error: null,
    })
    expect(useSyncStore.getState().retryAt).toBeNull()
  })

  it('syncNow clears retryAt', async () => {
    vi.mocked(tauri.syncNow).mockResolvedValueOnce(defaultSummary)
    await useSyncStore.getState().init()
    // Seed a retry.
    ;(listenersByName['sync:retry-scheduled'] ?? []).forEach((h) =>
      h({ payload: { retry_at_ms: Date.now() + 60_000 } }),
    )
    expect(useSyncStore.getState().retryAt).not.toBeNull()
    await useSyncStore.getState().syncNow()
    expect(useSyncStore.getState().retryAt).toBeNull()
  })
})
