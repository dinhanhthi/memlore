import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GdriveConnectOutcome } from '../lib/tauri'
import {
  GDRIVE_CONNECT_PROGRESS_EVENT,
  shouldSurfaceConnectResult,
  useGdriveConnectStore,
  __resetGdriveConnectStoreForTests,
} from './gdriveConnectStore'

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

vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn(() => Promise.resolve()) }))

vi.mock('../lib/tauri', () => ({
  gdriveBeginConnect: vi.fn(),
  gdriveCompleteConnect: vi.fn(),
  gdriveCancelConnect: vi.fn(),
  cloudFolderConnect: vi.fn(),
}))

const syncNowMock = vi.fn(() => Promise.resolve())
const refreshMock = vi.fn(() => Promise.resolve())
vi.mock('./syncStore', () => ({
  useSyncStore: { getState: () => ({ syncNow: syncNowMock, refresh: refreshMock }) },
}))

const setForceRePairMock = vi.fn()
vi.mock('../hooks/useForceRePair', () => ({
  useForceRePairStore: { getState: () => ({ setForceRePair: setForceRePairMock }) },
}))

import { openUrl } from '@tauri-apps/plugin-opener'
import * as tauri from '../lib/tauri'

const beginConnect = tauri.gdriveBeginConnect as unknown as ReturnType<typeof vi.fn>
const completeConnect = tauri.gdriveCompleteConnect as unknown as ReturnType<typeof vi.fn>
const cancelConnect = tauri.gdriveCancelConnect as unknown as ReturnType<typeof vi.fn>
const folderConnect = tauri.cloudFolderConnect as unknown as ReturnType<typeof vi.fn>
const openUrlMock = openUrl as unknown as ReturnType<typeof vi.fn>

function fireProgress(sessionId: string, phase: string) {
  ;(listenersByName[GDRIVE_CONNECT_PROGRESS_EVENT] ?? []).forEach((h) =>
    h({ payload: { session_id: sessionId, phase } }),
  )
}

beforeEach(() => {
  __resetGdriveConnectStoreForTests()
  beginConnect.mockReset()
  completeConnect.mockReset()
  cancelConnect.mockReset()
  folderConnect.mockReset()
  syncNowMock.mockClear()
  refreshMock.mockClear()
  setForceRePairMock.mockClear()
  openUrlMock.mockReset()
  openUrlMock.mockResolvedValue(undefined)
  for (const k of Object.keys(listenersByName)) delete listenersByName[k]
  beginConnect.mockResolvedValue({ authUrl: 'https://accounts.google/x', sessionId: 'sess-1' })
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('gdriveConnectStore.connect', () => {
  it('marks success and triggers a sync on a ready outcome', async () => {
    completeConnect.mockResolvedValue({ outcome: 'ready' } satisfies GdriveConnectOutcome)

    await useGdriveConnectStore.getState().connect('pw')

    const s = useGdriveConnectStore.getState()
    expect(s.status).toBe('success')
    expect(s.errorKey).toBeNull()
    expect(s.phase).toBeNull()
    expect(s.isAwaitingCallback).toBe(false)
    expect(s.sessionId).toBeNull()
    expect(syncNowMock).toHaveBeenCalledOnce()
  })

  it('clears a prior acknowledged result so a new connect can toast again', async () => {
    useGdriveConnectStore.setState({ resultAcknowledged: true })
    completeConnect.mockResolvedValue({ outcome: 'ready' } satisfies GdriveConnectOutcome)

    await useGdriveConnectStore.getState().connect('pw')

    expect(useGdriveConnectStore.getState().resultAcknowledged).toBe(false)
  })

  it('passes the password straight through to completeConnect (empty for the unlocked onboarding connect)', async () => {
    completeConnect.mockResolvedValue({ outcome: 'ready' } satisfies GdriveConnectOutcome)

    await useGdriveConnectStore.getState().connect('')

    expect(completeConnect).toHaveBeenCalledWith('sess-1', '')
  })

  it.each([
    ['Loopback callback timed out', 'settings:gdrive.errors.timed_out'],
    ['KEYRING_MISMATCH: cloud vs local', 'settings:gdrive.errors.keyring_mismatch'],
    ['Wrong password for cloud keyring', 'settings:gdrive.errors.keyring_mismatch'],
    ['Cloud keyring is internally inconsistent', 'settings:gdrive.errors.keyring_corrupted'],
    ['some unrecognised backend failure', 'auth:onboarding.drive.error_generic'],
  ])('maps rejection %j to error key %s', async (message, expectedKey) => {
    completeConnect.mockRejectedValue(new Error(message))

    await useGdriveConnectStore.getState().connect('pw')

    const s = useGdriveConnectStore.getState()
    expect(s.status).toBe('error')
    expect(s.errorKey).toBe(expectedKey)
  })

  it('surfaces the generic error and cleans up when gdriveBeginConnect rejects', async () => {
    beginConnect.mockRejectedValue(new Error('network down'))

    await useGdriveConnectStore.getState().connect('pw')

    const s = useGdriveConnectStore.getState()
    expect(s.status).toBe('error')
    expect(s.errorKey).toBe('auth:onboarding.drive.error_generic')
    expect(s.isAwaitingCallback).toBe(false)
    expect(s.sessionId).toBeNull()
    expect(completeConnect).not.toHaveBeenCalled()
  })

  it('hands needs_force_re_pair to the re-pair flow with a non-toasting status', async () => {
    completeConnect.mockResolvedValue({
      outcome: 'needs_force_re_pair',
      reason: 'epoch_changed',
      cloud_epoch: 3,
    } satisfies GdriveConnectOutcome)

    await useGdriveConnectStore.getState().connect('pw')

    expect(setForceRePairMock).toHaveBeenCalledWith('epoch_changed')
    const s = useGdriveConnectStore.getState()
    // Non-toasting idle: the force-re-pair flag is authoritative now, and a
    // leftover 'error' would make the toaster fire after the user re-pairs.
    expect(s.status).toBe('idle')
    expect(s.errorKey).toBeNull()
    expect(syncNowMock).not.toHaveBeenCalled()
  })

  it('maps a v1 wipe outcome to its specific error key', async () => {
    completeConnect.mockResolvedValue({
      outcome: 'v1_wiped_reconnect_required',
    } satisfies GdriveConnectOutcome)

    await useGdriveConnectStore.getState().connect('pw')

    expect(useGdriveConnectStore.getState().errorKey).toBe(
      'settings:gdrive.errors.v1_wiped_reconnect',
    )
  })

  it('maps an Invalid password rejection to its error key', async () => {
    completeConnect.mockRejectedValue(new Error('Invalid password'))

    await useGdriveConnectStore.getState().connect('pw')

    const s = useGdriveConnectStore.getState()
    expect(s.status).toBe('error')
    expect(s.errorKey).toBe('settings:gdrive.errors.invalid_password')
  })

  it('returns to idle (no error) when the user cancels', async () => {
    completeConnect.mockRejectedValue(new Error('OAUTH_CANCELLED: User cancelled the OAuth flow'))

    await useGdriveConnectStore.getState().connect('pw')

    const s = useGdriveConnectStore.getState()
    expect(s.status).toBe('idle')
    expect(s.errorKey).toBeNull()
    expect(s.isAwaitingCallback).toBe(false)
    expect(s.sessionId).toBeNull()
  })

  it('ignores re-entrant connect calls while one is in flight', async () => {
    useGdriveConnectStore.setState({ status: 'connecting' })

    await useGdriveConnectStore.getState().connect('pw')

    expect(beginConnect).not.toHaveBeenCalled()
  })

  it('updates phase from a matching progress event and ignores stale ones', async () => {
    // Hold completeConnect open so the listener is active when we fire events.
    let resolveComplete!: (o: GdriveConnectOutcome) => void
    completeConnect.mockReturnValue(
      new Promise<GdriveConnectOutcome>((r) => {
        resolveComplete = r
      }),
    )

    const done = useGdriveConnectStore.getState().connect('pw')
    // Let begin + listen resolve.
    await vi.waitFor(() => expect(useGdriveConnectStore.getState().sessionId).toBe('sess-1'))

    fireProgress('other-session', 'finalizing')
    expect(useGdriveConnectStore.getState().phase).toBeNull()

    fireProgress('sess-1', 'establishing_root')
    expect(useGdriveConnectStore.getState().phase).toBe('establishing_root')

    fireProgress('sess-1', 'not_a_real_phase')
    expect(useGdriveConnectStore.getState().phase).toBe('establishing_root')

    resolveComplete({ outcome: 'ready' })
    await done
  })

  it('tears down the progress listener when openUrl rejects after listen resolved', async () => {
    openUrlMock.mockRejectedValueOnce(new Error('opener failed'))

    await useGdriveConnectStore.getState().connect('pw')

    // The listener was registered (listen ran before openUrl) then removed in
    // `finally` — a stale event after teardown must not touch `phase`.
    expect(listenersByName[GDRIVE_CONNECT_PROGRESS_EVENT] ?? []).toHaveLength(0)
    fireProgress('sess-1', 'finalizing')
    expect(useGdriveConnectStore.getState().phase).toBeNull()
    expect(useGdriveConnectStore.getState().status).toBe('error')
  })

  it('folder connect ready path calls cloudFolderConnect with a UUID and skips OAuth', async () => {
    folderConnect.mockResolvedValue({ outcome: 'ready' } satisfies GdriveConnectOutcome)

    await useGdriveConnectStore.getState().connect('pw', { provider: 'icloud' })

    expect(beginConnect).not.toHaveBeenCalled()
    expect(openUrlMock).not.toHaveBeenCalled()
    expect(completeConnect).not.toHaveBeenCalled()
    expect(folderConnect).toHaveBeenCalledOnce()
    const [sessionId, provider, rootPath, password] = folderConnect.mock.calls[0] as [
      string,
      string,
      string | null,
      string,
    ]
    expect(sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    expect(provider).toBe('icloud')
    expect(rootPath).toBeNull()
    expect(password).toBe('pw')

    const s = useGdriveConnectStore.getState()
    expect(s.status).toBe('success')
    expect(s.errorKey).toBeNull()
    expect(s.isAwaitingCallback).toBe(false)
    expect(refreshMock).toHaveBeenCalledOnce()
    expect(syncNowMock).toHaveBeenCalledOnce()
  })

  it('folder connect hands needs_force_re_pair to the re-pair flow', async () => {
    folderConnect.mockResolvedValue({
      outcome: 'needs_force_re_pair',
      reason: 'epoch_changed',
      cloud_epoch: 3,
    } satisfies GdriveConnectOutcome)

    await useGdriveConnectStore.getState().connect('pw', {
      provider: 'local',
      rootPath: '/tmp/vault',
    })

    expect(beginConnect).not.toHaveBeenCalled()
    expect(folderConnect).toHaveBeenCalledWith(expect.any(String), 'local', '/tmp/vault', 'pw')
    expect(setForceRePairMock).toHaveBeenCalledWith('epoch_changed')
    const s = useGdriveConnectStore.getState()
    expect(s.status).toBe('idle')
    expect(s.errorKey).toBeNull()
    expect(syncNowMock).not.toHaveBeenCalled()
  })

  it('maps "Disconnect the current provider first" to already_connected', async () => {
    folderConnect.mockRejectedValue(new Error('Disconnect the current provider first'))

    await useGdriveConnectStore.getState().connect('pw', { provider: 'icloud' })

    const s = useGdriveConnectStore.getState()
    expect(s.status).toBe('error')
    expect(s.errorKey).toBe('settings:cloud.errors.already_connected')
  })

  it('maps "Grant Memlore access" to permission_denied', async () => {
    folderConnect.mockRejectedValue(
      new Error(
        'Grant Memlore access to iCloud Drive in System Settings › Privacy & Security › Files and Folders, then retry.',
      ),
    )

    await useGdriveConnectStore.getState().connect('pw', { provider: 'icloud' })

    expect(useGdriveConnectStore.getState().errorKey).toBe(
      'settings:cloud.errors.permission_denied',
    )
  })

  it('Settings-style connect then reset leaves status idle', async () => {
    folderConnect.mockResolvedValue({ outcome: 'ready' } satisfies GdriveConnectOutcome)

    await useGdriveConnectStore.getState().connect('pw', { provider: 'icloud' })
    expect(useGdriveConnectStore.getState().status).toBe('success')

    useGdriveConnectStore.getState().resetConnectResult()

    const s = useGdriveConnectStore.getState()
    expect(s.status).toBe('idle')
    expect(s.errorKey).toBeNull()
    expect(s.phase).toBeNull()
    expect(shouldSurfaceConnectResult(s.status, s.resultAcknowledged, false)).toBeNull()
  })

  it('Settings-style connect then reset after an error also returns to idle', async () => {
    folderConnect.mockRejectedValue(new Error('Grant Memlore access'))

    await useGdriveConnectStore.getState().connect('pw', { provider: 'icloud' })
    expect(useGdriveConnectStore.getState().status).toBe('error')

    useGdriveConnectStore.getState().resetConnectResult()

    const s = useGdriveConnectStore.getState()
    expect(s.status).toBe('idle')
    expect(s.errorKey).toBeNull()
  })
})

describe('shouldSurfaceConnectResult', () => {
  it('returns null once the result was acknowledged', () => {
    expect(shouldSurfaceConnectResult('success', true, false)).toBeNull()
    expect(shouldSurfaceConnectResult('error', true, false)).toBeNull()
  })

  it('stays quiet while the celebration modal is pending', () => {
    expect(shouldSurfaceConnectResult('success', false, true)).toBeNull()
    expect(shouldSurfaceConnectResult('error', false, true)).toBeNull()
  })

  it('surfaces a terminal result once dismissed and not acknowledged', () => {
    expect(shouldSurfaceConnectResult('success', false, false)).toBe('success')
    expect(shouldSurfaceConnectResult('error', false, false)).toBe('error')
  })

  it('stays quiet for non-terminal statuses', () => {
    expect(shouldSurfaceConnectResult('idle', false, false)).toBeNull()
    expect(shouldSurfaceConnectResult('connecting', false, false)).toBeNull()
  })

  it('stays quiet while Settings manualConnecting is in flight', () => {
    expect(shouldSurfaceConnectResult('success', false, false, true)).toBeNull()
    expect(shouldSurfaceConnectResult('error', false, false, true)).toBeNull()
  })
})

describe('gdriveConnectStore.target', () => {
  it('starts as null before any connect', () => {
    expect(useGdriveConnectStore.getState().target).toBeNull()
  })

  it('records the default gdrive target when connect is called without one', async () => {
    completeConnect.mockResolvedValue({ outcome: 'ready' } satisfies GdriveConnectOutcome)

    await useGdriveConnectStore.getState().connect('pw')

    expect(useGdriveConnectStore.getState().target).toEqual({ provider: 'gdrive' })
  })

  it('records the folder target including rootPath so the toaster can interpolate {{provider}}', async () => {
    folderConnect.mockResolvedValue({ outcome: 'ready' } satisfies GdriveConnectOutcome)

    await useGdriveConnectStore.getState().connect('pw', {
      provider: 'local',
      rootPath: '/tmp/vault',
    })

    expect(useGdriveConnectStore.getState().target).toEqual({
      provider: 'local',
      rootPath: '/tmp/vault',
    })
  })

  it('records an icloud target without inventing a rootPath', async () => {
    folderConnect.mockResolvedValue({ outcome: 'ready' } satisfies GdriveConnectOutcome)

    await useGdriveConnectStore.getState().connect('', { provider: 'icloud' })

    expect(useGdriveConnectStore.getState().target).toEqual({ provider: 'icloud' })
    const [, , , password] = folderConnect.mock.calls[0] as [string, string, string | null, string]
    expect(password).toBe('')
  })

  it('does not overwrite target on a re-entrant connect', async () => {
    useGdriveConnectStore.setState({
      status: 'connecting',
      target: { provider: 'icloud' },
    })

    await useGdriveConnectStore.getState().connect('pw', { provider: 'gdrive' })

    expect(beginConnect).not.toHaveBeenCalled()
    expect(useGdriveConnectStore.getState().target).toEqual({ provider: 'icloud' })
  })

  it('keeps target after resetConnectResult so a late toaster read can still interpolate', async () => {
    folderConnect.mockResolvedValue({ outcome: 'ready' } satisfies GdriveConnectOutcome)

    await useGdriveConnectStore.getState().connect('pw', { provider: 'icloud' })
    useGdriveConnectStore.getState().resetConnectResult()

    expect(useGdriveConnectStore.getState().target).toEqual({ provider: 'icloud' })
  })
})

describe('gdriveConnectStore.cancelAwaiting', () => {
  it('cancels the in-flight session by id', async () => {
    cancelConnect.mockResolvedValue(true)
    useGdriveConnectStore.setState({ sessionId: 'sess-9', isAwaitingCallback: true })

    await useGdriveConnectStore.getState().cancelAwaiting()

    expect(cancelConnect).toHaveBeenCalledWith('sess-9')
    expect(useGdriveConnectStore.getState().isAwaitingCallback).toBe(false)
  })

  it('is a no-op with no session', async () => {
    await useGdriveConnectStore.getState().cancelAwaiting()
    expect(cancelConnect).not.toHaveBeenCalled()
  })
})
