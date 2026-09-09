import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { useSync } from './useSync'
import { __resetSyncStoreForTests } from '../stores/syncStore'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

// Event listener capture — tests can grab the registered handler and
// fire synthetic `SyncStatusEvent` payloads to exercise the
// lifecycle-driven update path of `useSync`.
const listeners: Array<(event: { payload: unknown }) => void> = []
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((_name: string, handler: (event: { payload: unknown }) => void) => {
    listeners.push(handler)
    return Promise.resolve(() => {
      const idx = listeners.indexOf(handler)
      if (idx >= 0) listeners.splice(idx, 1)
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
    setSyncSettings: vi.fn(),
    setSyncEnabled: vi.fn(),
    syncNow: vi.fn(),
    pushEntry: vi.fn(),
  }
})

import * as tauri from '../lib/tauri'

const defaultStatus: tauri.SyncStatus = {
  enabled: false,
  configured: false,
  provider: null,
  lastSync: null,
  entriesPending: 0,
}

const defaultSettings: tauri.SyncSettings = {
  intervalMinutes: 5,
  onSave: true,
  onLaunch: true,
}

const defaultSummary: tauri.SyncSummary = {
  pushed: 0,
  pulled: 0,
  merged: 0,
  errors: [],
}

beforeEach(() => {
  vi.resetAllMocks()
  listeners.length = 0
  vi.mocked(tauri.getDeviceId).mockResolvedValue('test-device-uuid')
  vi.mocked(tauri.getSyncStatus).mockResolvedValue(defaultStatus)
  vi.mocked(tauri.getSyncSettings).mockResolvedValue(defaultSettings)
  vi.mocked(tauri.getSyncRecoveryStatus).mockResolvedValue(null)
  vi.mocked(tauri.getAiProviders).mockResolvedValue({
    generation: null,
    image: null,
    embedding: null,
  })
  vi.mocked(tauri.setSyncSettings).mockResolvedValue()
  vi.mocked(tauri.setSyncEnabled).mockResolvedValue()
  vi.mocked(tauri.syncNow).mockResolvedValue(defaultSummary)
  vi.mocked(tauri.pushEntry).mockResolvedValue()
  // Wipe shared store state between tests — Zustand stores live for the
  // whole module's lifetime, so prior-test side effects would leak in.
  __resetSyncStoreForTests()
})

afterEach(() => {
  __resetSyncStoreForTests()
})

describe('useSync', () => {
  it('fetches device ID and status on mount', async () => {
    const { result } = renderHook(() => useSync())
    await waitFor(() => {
      expect(result.current.deviceId).toBe('test-device-uuid')
      expect(result.current.status).toEqual(defaultStatus)
    })
    expect(tauri.getDeviceId).toHaveBeenCalledTimes(1)
    expect(tauri.getSyncStatus).toHaveBeenCalledTimes(1)
  })

  it('refresh re-fetches status', async () => {
    const { result } = renderHook(() => useSync())
    await waitFor(() => expect(result.current.deviceId).toBe('test-device-uuid'))

    vi.mocked(tauri.getSyncStatus).mockResolvedValueOnce({
      ...defaultStatus,
      entriesPending: 3,
    })

    await act(async () => {
      await result.current.refresh()
    })
    expect(result.current.status?.entriesPending).toBe(3)
  })

  it('setSyncEnabled round-trips and status updates on refresh', async () => {
    vi.mocked(tauri.getSyncStatus)
      .mockResolvedValueOnce(defaultStatus)
      .mockResolvedValueOnce({ ...defaultStatus, enabled: true })

    const { result } = renderHook(() => useSync())
    await waitFor(() => expect(result.current.status?.enabled).toBe(false))

    await act(async () => {
      await result.current.setEnabled(true)
    })
    expect(tauri.setSyncEnabled).toHaveBeenCalledWith(true)
    expect(result.current.status?.enabled).toBe(true)
  })

  it('exposes null state before load completes', () => {
    vi.mocked(tauri.getDeviceId).mockReturnValue(new Promise(() => {}))
    const { result } = renderHook(() => useSync())
    expect(result.current.deviceId).toBeNull()
    expect(result.current.status).toBeNull()
  })

  it('warns on getDeviceId rejection and leaves deviceId null', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(tauri.getDeviceId).mockRejectedValue(new Error('db locked'))

    const { result } = renderHook(() => useSync())
    await waitFor(() => expect(warn).toHaveBeenCalled())
    expect(result.current.deviceId).toBeNull()
    expect(warn.mock.calls[0]?.[0]).toMatch(/syncStore/i)
    warn.mockRestore()
  })

  it('warns on getSyncStatus rejection and leaves status null', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(tauri.getSyncStatus).mockRejectedValue(new Error('boom'))

    const { result } = renderHook(() => useSync())
    await waitFor(() => expect(warn).toHaveBeenCalled())
    expect(result.current.status).toBeNull()
    warn.mockRestore()
  })

  it('syncNow flips isSyncing during the call and reflects pushed count on refresh', async () => {
    vi.mocked(tauri.syncNow).mockResolvedValueOnce({
      pushed: 2,
      pulled: 1,
      merged: 0,
      errors: [],
    })
    vi.mocked(tauri.getSyncStatus)
      .mockResolvedValueOnce(defaultStatus)
      .mockResolvedValueOnce({ ...defaultStatus, entriesPending: 0, lastSync: 1700000000 })

    const { result } = renderHook(() => useSync())
    await waitFor(() => expect(result.current.deviceId).toBe('test-device-uuid'))

    let summaryPromise: Promise<tauri.SyncSummary> | undefined
    await act(async () => {
      summaryPromise = result.current.syncNow()
    })
    const summary = await summaryPromise!
    expect(summary.pushed).toBe(2)
    expect(result.current.isSyncing).toBe(false)
    expect(result.current.lastError).toBeNull()
    expect(result.current.lastSummary?.pushed).toBe(2)
    expect(tauri.syncNow).toHaveBeenCalledTimes(1)
  })

  it('syncNow surfaces backend errors into lastError', async () => {
    vi.mocked(tauri.syncNow).mockResolvedValueOnce({
      pushed: 1,
      pulled: 0,
      merged: 0,
      errors: ['pull: network timeout'],
    })

    const { result } = renderHook(() => useSync())
    await waitFor(() => expect(result.current.deviceId).toBe('test-device-uuid'))

    await act(async () => {
      await result.current.syncNow()
    })
    expect(result.current.lastError).toMatch(/timeout/)
  })

  it('syncNow thrown errors propagate and clear isSyncing', async () => {
    vi.mocked(tauri.syncNow).mockRejectedValueOnce(new Error('boom'))

    const { result } = renderHook(() => useSync())
    await waitFor(() => expect(result.current.deviceId).toBe('test-device-uuid'))

    await act(async () => {
      await expect(result.current.syncNow()).rejects.toThrow('boom')
    })
    expect(result.current.isSyncing).toBe(false)
    expect(result.current.lastError).toBe('boom')
  })

  it('pushEntry forwards the id to the backend', async () => {
    const { result } = renderHook(() => useSync())
    await waitFor(() => expect(result.current.deviceId).toBe('test-device-uuid'))

    await act(async () => {
      await result.current.pushEntry('entry-123')
    })
    expect(tauri.pushEntry).toHaveBeenCalledWith('entry-123')
  })

  it('refresh clears a prior lastError is not automatic — only explicit user actions do', async () => {
    // Contract test: a bare `refresh()` is passive — it must NOT silently
    // wipe `lastError` because the error might still be actionable. Only
    // user actions (`syncNow`, `setEnabled`) clear it.
    vi.mocked(tauri.syncNow).mockResolvedValueOnce({
      pushed: 0,
      pulled: 0,
      merged: 0,
      errors: ['prior-error'],
    })
    const { result } = renderHook(() => useSync())
    await waitFor(() => expect(result.current.deviceId).toBe('test-device-uuid'))

    await act(async () => {
      await result.current.syncNow()
    })
    expect(result.current.lastError).toBe('prior-error')

    // refresh by itself leaves lastError in place.
    await act(async () => {
      await result.current.refresh()
    })
    expect(result.current.lastError).toBe('prior-error')
  })

  it('loads sync settings on mount', async () => {
    const { result } = renderHook(() => useSync())
    await waitFor(() => {
      expect(result.current.settings).toEqual(defaultSettings)
    })
    expect(tauri.getSyncSettings).toHaveBeenCalledTimes(1)
  })

  it('updateSettings delegates to tauri and caches the next value', async () => {
    const { result } = renderHook(() => useSync())
    await waitFor(() => expect(result.current.settings).not.toBeNull())

    const next: tauri.SyncSettings = {
      intervalMinutes: 15,
      onSave: false,
      onLaunch: true,
    }
    await act(async () => {
      await result.current.updateSettings(next)
    })
    expect(tauri.setSyncSettings).toHaveBeenCalledWith(next)
    expect(result.current.settings).toEqual(next)
  })

  it('lifecycle event updates phase, status and isSyncing', async () => {
    const { result } = renderHook(() => useSync())
    await waitFor(() => expect(result.current.deviceId).toBe('test-device-uuid'))
    // Four listeners: status-changed, progress, recovery-status, retry-scheduled.
    expect(listeners.length).toBe(4)

    await act(async () => {
      listeners[0]!({
        payload: {
          state: 'syncing',
          enabled: true,
          provider: 'local',
          lastSync: null,
          entriesPending: 2,
          error: null,
        } satisfies tauri.SyncStatusEvent,
      })
    })
    expect(result.current.phase).toBe('syncing')
    expect(result.current.isSyncing).toBe(true)
    expect(result.current.status?.entriesPending).toBe(2)

    await act(async () => {
      listeners[0]!({
        payload: {
          state: 'synced',
          enabled: true,
          provider: 'local',
          lastSync: 1_700_000_000,
          entriesPending: 0,
          error: null,
        } satisfies tauri.SyncStatusEvent,
      })
    })
    expect(result.current.phase).toBe('synced')
    expect(result.current.isSyncing).toBe(false)
    expect(result.current.status?.lastSync).toBe(1_700_000_000)
    expect(result.current.lastError).toBeNull()
  })

  it('consumes provider refresh rejection after a synced lifecycle event', async () => {
    const { result } = renderHook(() => useSync())
    await waitFor(() => expect(result.current.deviceId).toBe('test-device-uuid'))
    vi.mocked(tauri.getAiProviders).mockRejectedValueOnce(new Error('provider refresh failed'))

    await act(async () => {
      listeners[0]!({
        payload: {
          state: 'synced',
          enabled: true,
          provider: 'gdrive',
          lastSync: 1_700_000_000,
          entriesPending: 0,
          error: null,
        } satisfies tauri.SyncStatusEvent,
      })
      await Promise.resolve()
    })

    expect(result.current.phase).toBe('synced')
    expect(result.current.lastError).toBeNull()
  })

  it('lifecycle error event surfaces into lastError', async () => {
    const { result } = renderHook(() => useSync())
    await waitFor(() => expect(result.current.deviceId).toBe('test-device-uuid'))

    await act(async () => {
      listeners[0]!({
        payload: {
          state: 'error',
          enabled: true,
          provider: 'local',
          lastSync: null,
          entriesPending: 1,
          error: 'network down',
        } satisfies tauri.SyncStatusEvent,
      })
    })
    expect(result.current.phase).toBe('error')
    expect(result.current.lastError).toBe('network down')
    expect(result.current.isSyncing).toBe(false)
  })

  it('shares state across multiple useSync() consumers', async () => {
    // Two components mounting useSync at the same time must observe the
    // same `phase` / `lastError` — Zustand store is the single source of
    // truth. Prior to the store refactor, each hook instance kept its
    // own copy and silently disagreed.
    const a = renderHook(() => useSync())
    const b = renderHook(() => useSync())
    await waitFor(() => expect(a.result.current.deviceId).toBe('test-device-uuid'))
    // Four listeners per store: status + progress + recovery + retry. Init is
    // idempotent so two hook consumers share one store → still four total.
    expect(listeners.length).toBe(4)

    await act(async () => {
      listeners[0]!({
        payload: {
          state: 'error',
          enabled: true,
          provider: 'gdrive',
          lastSync: null,
          entriesPending: 9,
          error: 'fingerprint mismatch',
        } satisfies tauri.SyncStatusEvent,
      })
    })

    expect(a.result.current.phase).toBe('error')
    expect(b.result.current.phase).toBe('error')
    expect(a.result.current.lastError).toBe('fingerprint mismatch')
    expect(b.result.current.lastError).toBe('fingerprint mismatch')
    expect(a.result.current.status?.entriesPending).toBe(9)
    expect(b.result.current.status?.entriesPending).toBe(9)
  })

  it('preserves phase/lastError across consumer remount', async () => {
    // Regression for the reported bug: leaving Settings → Sync and coming
    // back wiped `lastError` because the hook held it locally. With the
    // Zustand store, remounting must NOT zero the active error state.
    const first = renderHook(() => useSync())
    await waitFor(() => expect(first.result.current.deviceId).toBe('test-device-uuid'))

    await act(async () => {
      listeners[0]!({
        payload: {
          state: 'error',
          enabled: true,
          provider: 'gdrive',
          lastSync: null,
          entriesPending: 13,
          error: 'fingerprint mismatch',
        } satisfies tauri.SyncStatusEvent,
      })
    })
    expect(first.result.current.lastError).toBe('fingerprint mismatch')

    // Simulate the user navigating away — destroy the only consumer.
    first.unmount()

    // ...then back: a fresh consumer mounts. Without the store fix this
    // saw `lastError: null` and rendered "Up to date".
    const second = renderHook(() => useSync())
    expect(second.result.current.phase).toBe('error')
    expect(second.result.current.lastError).toBe('fingerprint mismatch')
    expect(second.result.current.status?.entriesPending).toBe(13)
  })

  it('setEnabled propagates backend errors into lastError', async () => {
    vi.mocked(tauri.setSyncEnabled).mockRejectedValueOnce(new Error('backend down'))
    const { result } = renderHook(() => useSync())
    await waitFor(() => expect(result.current.deviceId).toBe('test-device-uuid'))

    await act(async () => {
      await expect(result.current.setEnabled(true)).rejects.toThrow('backend down')
    })
    expect(result.current.lastError).toBe('backend down')
  })

  it('syncNow is guarded against rapid re-entry', async () => {
    // Three concurrent syncNow() calls must invoke the backend once —
    // subsequent calls while one is in flight short-circuit to avoid
    // queueing block_on on the main thread.
    let resolveBackend!: (value: tauri.SyncSummary) => void
    vi.mocked(tauri.syncNow).mockReturnValueOnce(
      new Promise<tauri.SyncSummary>((resolve) => {
        resolveBackend = resolve
      }),
    )
    const { result } = renderHook(() => useSync())
    await waitFor(() => expect(result.current.deviceId).toBe('test-device-uuid'))

    const p1 = result.current.syncNow()
    const p2 = result.current.syncNow()
    const p3 = result.current.syncNow()
    resolveBackend({ pushed: 1, pulled: 0, merged: 0, errors: [] })
    await act(async () => {
      await Promise.all([p1, p2, p3])
    })
    expect(tauri.syncNow).toHaveBeenCalledTimes(1)
  })
})
