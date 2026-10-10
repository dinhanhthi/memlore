import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Core } from '../../core/core'

vi.mock('../sync/onboard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../sync/onboard')>()),
  validatePassphrase: vi.fn(),
  onboardComplete: vi.fn(),
}))

import { DriveReader, VaultNotReadyError } from '../drive/client'
import {
  FakeDrive,
  fakeLocks,
  json,
  loadDesktopFixture,
  seedFromFixture,
  seedVault,
  violations,
} from '../drive/fakeDrive'
import { OAuthConnectError, ReauthRequiredError, SIGN_IN_CANCELLED_MESSAGE } from '../drive/oauth'
import { configureKeysEnv, dispose, getAutoLockMinutes, isUnlocked } from '../keys'
import { route } from '../router'
import {
  WEB_SETTING_PREFIX,
  WRAPPED_MASTER_HEX_LEN,
  openWebDb,
  type DeviceRecord,
  type WebDb,
} from '../storage/idb'
import { configureWebSettingsEnv } from './webSettings'
import {
  DeviceRecordConflictError,
  FormatUnsupportedError,
  RecoveryInProgressError,
  WrongPhraseError,
  onboardComplete,
  readContentFile,
  validatePassphrase,
} from '../sync/onboard'
import {
  FREE_TRIES,
  PENDING_SESSION_TTL_MS,
  MSG_INVALID_PASSWORD,
  MSG_NO_VAULT,
  configureAuthEnv,
  resetAuthState,
} from './auth'

const CONTENT = '.meta/keyring/_content.json'
const GOOD = 'right-password'
const CONTENT_TEXT = JSON.stringify({ version: 2, latest_epoch: 0, entries: [], created_at: 1 })
const RECORD: DeviceRecord = {
  deviceId: 'aaaaaaaa-1111-4222-8333-bbbbbbbbbbbb',
  wrappedMasterHex: 'ab'.repeat(WRAPPED_MASTER_HEX_LEN / 2),
  kekSaltHex: 'cd'.repeat(16),
  recoveryGeneration: 0,
  masterFingerprint: 'ef'.repeat(32),
  name: 'Memlore Web (Chrome)',
}

interface FakeRing {
  lock: ReturnType<typeof vi.fn<() => void>>
  loadContentList: ReturnType<typeof vi.fn<(text: string) => void>>
  loadMasterOnly: ReturnType<typeof vi.fn<() => void>>
}

let db: WebDb
let drive: FakeDrive
let events: string[]
let clock: number
let rings: FakeRing[]
/** A content list text the fake ring refuses (as a fingerprint mismatch would). */
let rejectedContent: string | null
let connect: (signal?: AbortSignal) => Promise<void>
let logout: ReturnType<typeof vi.fn<() => Promise<void>>>
let tokenFails: boolean

const fakeCore = {
  knownVersions: () =>
    JSON.stringify({ keyring_version: 2, sync_control_version: 1, content_list_version: 2 }),
  parseKeyringMeta: (text: string) => text,
  KeyRing: {
    unlockLocal: (_wrapped: string, password: string) => {
      if (password !== GOOD) throw new Error('bad tag')
      const ring: FakeRing = {
        lock: vi.fn(),
        loadContentList: vi.fn((text: string) => {
          if (text === rejectedContent) throw new Error('content key fingerprint mismatch')
        }),
        loadMasterOnly: vi.fn(),
      }
      rings.push(ring)
      return ring
    },
  },
} as unknown as Core

const call = (cmd: string, args: Record<string, unknown> = {}) => route(cmd, args)
const message = async (promise: Promise<unknown>): Promise<string> =>
  ((await promise.catch((e: unknown) => e)) as Error).message

const unlock = (password = GOOD) => call('initialize_encryption', { password })

beforeEach(async () => {
  violations.length = 0
  events = []
  clock = 1_000_000
  rings = []
  rejectedContent = null
  tokenFails = false
  connect = async () => undefined
  logout = vi.fn(async () => undefined)
  drive = new FakeDrive()
  seedVault(drive)
  db = await openWebDb({ factory: new IDBFactory() })
  configureKeysEnv({
    setTimeout: () => 0,
    clearTimeout: () => {},
    emit: (event) => events.push(event),
    document: null,
    window: null,
  })
  let uuid = 0
  configureAuthEnv({
    now: () => clock,
    sleep: async () => {},
    emit: (event) => events.push(event),
    randomUUID: () => `session-${++uuid}`,
    openDb: async () => db,
    loadCore: async () => fakeCore,
    oauth: {
      connect: (signal) => connect(signal),
      getAccessToken: async () => 'tok',
      logout: () => logout(),
    },
    driveDeps: () => ({
      getToken: async () => {
        if (tokenFails) throw new ReauthRequiredError()
        return 'tok'
      },
      fetchImpl: drive.fetch,
      sleep: async () => {},
      locks: fakeLocks(drive),
    }),
    origin: () => 'https://web.test',
  })
})

afterEach(() => {
  dispose()
  resetAuthState()
  configureAuthEnv({})
  vi.mocked(validatePassphrase).mockReset()
  vi.mocked(onboardComplete).mockReset()
  expect(violations).toEqual([])
})

const metaText = (fingerprint: string, contentEpoch: number): string =>
  JSON.stringify({
    version: 2,
    epoch: 1,
    master_fingerprint: fingerprint,
    content_epoch: contentEpoch,
    recovery_generation: 0,
    created_at: 1,
    updated_at: 1,
  })
function putMeta(fingerprint: string, contentEpoch: number): void {
  drive.addFile(
    '_meta.json',
    drive.chain('Memlore', '.meta', 'keyring'),
    metaText(fingerprint, contentEpoch),
  )
}
const putCache = (text = CONTENT_TEXT) =>
  db.files.put({
    path: CONTENT,
    ciphertext: new TextEncoder().encode(text),
    etag: null,
    modifiedTime: null,
    lastAccess: 1,
    pinned: true,
  })

function putContent(text = CONTENT_TEXT): void {
  drive.addFile('_content.json', drive.chain('Memlore', '.meta', 'keyring'), text)
}

describe('modes and queries', () => {
  it('reports unset / first_launch / placeholder id without a device record', async () => {
    await expect(call('get_encryption_mode')).resolves.toBe('unset')
    await expect(call('get_startup_mode')).resolves.toBe('first_launch')
    await expect(call('get_device_id')).resolves.toBe('web-unavailable')
  })

  it('reports password / password_locked / the device id with a device record', async () => {
    await db.device.put(RECORD)
    await expect(call('get_encryption_mode')).resolves.toBe('password')
    await expect(call('get_startup_mode')).resolves.toBe('password_locked')
    await expect(call('get_device_id')).resolves.toBe(RECORD.deviceId)
  })

  it('is_encryption_initialized follows the key holder', async () => {
    await db.device.put(RECORD)
    putContent()
    await expect(call('is_encryption_initialized')).resolves.toBe(false)
    await unlock()
    await expect(call('is_encryption_initialized')).resolves.toBe(true)
    await call('lock_encryption')
    await expect(call('is_encryption_initialized')).resolves.toBe(false)
  })
})

describe('unlock: content keys', () => {
  beforeEach(async () => {
    await db.device.put(RECORD)
  })

  it('reads _content.json from the Drive, caches it and emits app:unlocked', async () => {
    putContent()
    await unlock()
    expect(isUnlocked()).toBe(true)
    expect(rings[0].loadContentList).toHaveBeenCalledWith(CONTENT_TEXT)
    expect(rings[0].loadMasterOnly).not.toHaveBeenCalled()
    const cached = await db.files.get(CONTENT)
    expect(new TextDecoder().decode(cached?.ciphertext)).toBe(CONTENT_TEXT)
    expect(events).toEqual(['app:unlocked'])
  })

  it('applies the stored web auto-lock minutes before emitting app:unlocked', async () => {
    putContent()
    configureWebSettingsEnv({ openDb: async () => db })
    try {
      await db.meta.put({ key: `${WEB_SETTING_PREFIX}web_auto_lock_minutes`, value: '5' })
      await unlock()
      expect(getAutoLockMinutes()).toBe(5)
      expect(events).toEqual(['app:unlocked'])
    } finally {
      configureWebSettingsEnv({})
    }
  })

  it('never caches a Drive content list the ring refuses: the good cached copy survives', async () => {
    await putCache()
    const bad = JSON.stringify({ version: 2, latest_epoch: 9, entries: [], created_at: 2 })
    rejectedContent = bad
    putContent(bad)
    await expect(unlock()).rejects.toThrow()
    expect(isUnlocked()).toBe(false)
    const cached = await db.files.get(CONTENT)
    expect(new TextDecoder().decode(cached?.ciphertext)).toBe(CONTENT_TEXT)
  })

  it('falls back to the cached copy when there is no Drive session', async () => {
    await db.files.put({
      path: CONTENT,
      ciphertext: new TextEncoder().encode(CONTENT_TEXT),
      etag: null,
      modifiedTime: null,
      lastAccess: 1,
      pinned: true,
    })
    tokenFails = true
    await unlock()
    expect(isUnlocked()).toBe(true)
    expect(rings[0].loadContentList).toHaveBeenCalledWith(CONTENT_TEXT)
  })

  it('fails (and re-locks the ring) when neither the Drive nor the cache can supply it', async () => {
    tokenFails = true
    expect(await message(unlock())).toContain('Could not load the vault keys')
    expect(isUnlocked()).toBe(false)
    expect(rings[0].lock).toHaveBeenCalled()
    expect(rings[0].loadMasterOnly).not.toHaveBeenCalled()
    expect(events).toEqual([])
  })

  it('never falls back to master-only on a transient error', async () => {
    drive.interceptors.push(() => json({ error: 'x' }, 503))
    expect(await message(unlock())).toContain('please retry')
    expect(isUnlocked()).toBe(false)
    expect(rings[0].loadMasterOnly).not.toHaveBeenCalled()
    expect(rings[0].lock).toHaveBeenCalled()
  })

  it('uses the cached copy on a transient error, still never master-only', async () => {
    await db.files.put({
      path: CONTENT,
      ciphertext: new TextEncoder().encode(CONTENT_TEXT),
      etag: null,
      modifiedTime: null,
      lastAccess: 1,
      pinned: true,
    })
    drive.interceptors.push(() => json({ error: 'x' }, 503))
    await unlock()
    expect(rings[0].loadContentList).toHaveBeenCalledWith(CONTENT_TEXT)
    expect(rings[0].loadMasterOnly).not.toHaveBeenCalled()
  })

  it('loads master only when NotFound AND _meta.json is this vault with no content keys yet', async () => {
    putMeta(RECORD.masterFingerprint, 0)
    await unlock()
    expect(rings[0].loadMasterOnly).toHaveBeenCalledTimes(1)
    expect(rings[0].loadContentList).not.toHaveBeenCalled()
    expect(isUnlocked()).toBe(true)
  })

  it('re-reads _content.json after the _meta check: a list that appeared meanwhile is used and cached', async () => {
    putMeta(RECORD.masterFingerprint, 0)
    drive.interceptors.push((req) => {
      // The desktop finishes the epoch 0 -> 1 migration just as _meta.json is read.
      if (
        req.url.searchParams.get('q')?.includes('_meta.json') &&
        !drive.find(['Memlore', '.meta', 'keyring', '_content.json'])
      ) {
        putContent()
      }
      return undefined
    })
    await unlock()
    expect(rings[0].loadContentList).toHaveBeenCalledWith(CONTENT_TEXT)
    expect(rings[0].loadMasterOnly).not.toHaveBeenCalled()
    const cached = await db.files.get(CONTENT)
    expect(new TextDecoder().decode(cached?.ciphertext)).toBe(CONTENT_TEXT)
  })

  it('a transient error on the _content.json re-read never means master-only', async () => {
    putMeta(RECORD.masterFingerprint, 0)
    let contentReads = 0
    drive.interceptors.push((req) => {
      if (!req.url.searchParams.get('q')?.includes('_content.json')) return undefined
      contentReads += 1
      return contentReads >= 2 ? json({ error: 'x' }, 503) : undefined
    })
    expect(await message(unlock())).toContain('please retry')
    expect(rings[0].loadMasterOnly).not.toHaveBeenCalled()
    await putCache()
    contentReads = 0
    await unlock()
    expect(rings[1].loadContentList).toHaveBeenCalledWith(CONTENT_TEXT)
    expect(rings[1].loadMasterOnly).not.toHaveBeenCalled()
  })

  it('a reauth error on the _meta.json read never means master-only', async () => {
    putMeta(RECORD.masterFingerprint, 0)
    drive.interceptors.push((req) => {
      // The session is gone by the time _meta.json is read (_content.json was NotFound before).
      if (req.url.searchParams.get('q')?.includes('_meta.json')) tokenFails = true
      return undefined
    })
    expect(await message(unlock())).toContain('Could not load the vault keys')
    expect(rings[0].loadMasterOnly).not.toHaveBeenCalled()
    await putCache()
    tokenFails = false
    await unlock()
    expect(rings[1].loadContentList).toHaveBeenCalledWith(CONTENT_TEXT)
    expect(rings[1].loadMasterOnly).not.toHaveBeenCalled()
  })

  it('NotFound never means master-only without a matching _meta.json (other account, reset vault)', async () => {
    // No _meta.json at all (empty appData folder / reset vault): fail closed.
    expect(await message(unlock())).toContain('Could not load the vault keys')
    // _meta.json of ANOTHER vault: fail closed.
    putMeta('11'.repeat(32), 0)
    expect(await message(unlock())).toContain('Could not load the vault keys')
    // The vault already has content keys (content_epoch >= 1) yet the file is missing: fail closed.
    drive.files.length = 0
    seedVault(drive)
    putMeta(RECORD.masterFingerprint, 1)
    expect(await message(unlock())).toContain('Could not load the vault keys')
    expect(isUnlocked()).toBe(false)
    for (const ring of rings) expect(ring.loadMasterOnly).not.toHaveBeenCalled()
  })

  it('NotFound with a cached list uses the cache, even with a matching _meta.json, and keeps it', async () => {
    await putCache()
    await unlock() // no _meta.json
    expect(rings[0].loadContentList).toHaveBeenCalledWith(CONTENT_TEXT)
    await call('lock_encryption')
    putMeta(RECORD.masterFingerprint, 0)
    await unlock()
    expect(rings[1].loadContentList).toHaveBeenCalledWith(CONTENT_TEXT)
    expect(rings[1].loadMasterOnly).not.toHaveBeenCalled()
    expect(await db.files.get(CONTENT)).toBeDefined()
  })

  it('a transport failure falls back to the cache after ONE attempt (offline unlock is fast)', async () => {
    await putCache()
    let calls = 0
    drive.interceptors.push(() => {
      calls += 1
      throw new TypeError('Failed to fetch')
    })
    await unlock()
    expect(calls).toBe(1)
    expect(rings[0].loadContentList).toHaveBeenCalledWith(CONTENT_TEXT)
  })

  it('readContentFile keeps its bounded retries for a transport failure unless told to fail fast', async () => {
    let calls = 0
    drive.interceptors.push(() => {
      calls += 1
      throw new TypeError('Failed to fetch')
    })
    const reader = new DriveReader({
      getToken: async () => 'tok',
      fetchImpl: drive.fetch,
      sleep: async () => {},
    })
    await expect(readContentFile(reader, async () => {})).rejects.toThrow(/please retry/)
    expect(calls).toBe(3)
    calls = 0
    await expect(
      readContentFile(reader, async () => {}, { failFastOnTransport: true }),
    ).rejects.toThrow(/please retry/)
    expect(calls).toBe(1)
  })

  it('maps an unknown content version to the update message', async () => {
    putContent(JSON.stringify({ version: 99 }))
    expect(await message(unlock())).toContain('newer version of Memlore')
    expect(isUnlocked()).toBe(false)
    expect(rings[0].lock).toHaveBeenCalled()
  })
})

describe('unlock: password and backoff', () => {
  beforeEach(async () => {
    await db.device.put(RECORD)
    putContent()
  })

  it('rejects a wrong password with "Invalid password" and installs no ring', async () => {
    expect(await message(unlock('nope'))).toBe(MSG_INVALID_PASSWORD)
    expect(isUnlocked()).toBe(false)
    expect(events).toEqual([])
  })

  it('rejects when there is no device record', async () => {
    await db.device.clear()
    expect(await message(unlock())).toContain('not initialized')
  })

  it('allows free tries, then blocks with a growing delay, and resets on success', async () => {
    for (let i = 0; i < FREE_TRIES; i++)
      expect(await message(unlock('x'))).toBe(MSG_INVALID_PASSWORD)
    // The 4th wrong password is still judged, and it starts the 1 s block.
    expect(await message(unlock('x'))).toBe(MSG_INVALID_PASSWORD)
    expect(await message(unlock(GOOD))).toContain('Too many attempts')
    clock += 1_000
    expect(await message(unlock('x'))).toBe(MSG_INVALID_PASSWORD) // 2 s block now
    clock += 1_999
    expect(await message(unlock(GOOD))).toContain('Too many attempts')
    clock += 1
    await unlock(GOOD)
    expect(isUnlocked()).toBe(true)
    await call('lock_encryption')
    for (let i = 0; i < FREE_TRIES; i++)
      expect(await message(unlock('x'))).toBe(MSG_INVALID_PASSWORD)
    await unlock(GOOD) // counter was reset: three free tries again
  })

  it('caps the delay at 30 s', async () => {
    for (let i = 0; i < 12; i++) {
      await message(unlock('x'))
      clock += 31_000
    }
    await message(unlock('x'))
    clock += 29_999
    expect(await message(unlock(GOOD))).toContain('Too many attempts')
    clock += 1
    await unlock(GOOD)
  })

  it('serializes parallel attempts: the backoff applies to the later ones', async () => {
    const results = await Promise.all(
      Array.from({ length: FREE_TRIES + 2 }, () => message(unlock('x'))),
    )
    expect(results.slice(0, FREE_TRIES + 1)).toEqual(
      Array(FREE_TRIES + 1).fill(MSG_INVALID_PASSWORD),
    )
    expect(results[FREE_TRIES + 1]).toContain('Too many attempts')
  })

  it('does not count a content-load failure as a wrong password', async () => {
    tokenFails = true
    await db.files.delete(CONTENT)
    for (let i = 0; i < FREE_TRIES + 3; i++) {
      expect(await message(unlock(GOOD))).toContain('Could not load the vault keys')
    }
    tokenFails = false
    await unlock(GOOD)
  })
})

describe('lock_encryption', () => {
  it('locks, emits app:locked once, and is idempotent', async () => {
    await db.device.put(RECORD)
    putContent()
    await unlock()
    events.length = 0
    await expect(call('lock_encryption')).resolves.toBeUndefined()
    await expect(call('lock_encryption')).resolves.toBeUndefined()
    expect(isUnlocked()).toBe(false)
    expect(events).toEqual(['app:locked'])
    expect(rings[0].lock).toHaveBeenCalledTimes(1)
  })
})

describe('gdrive connect', () => {
  const begin = async () =>
    (await call('gdrive_begin_connect')) as { authUrl: string; sessionId: string }

  it('begin returns the UI shape and starts the popup flow once', async () => {
    const spy = vi.fn(async () => undefined)
    connect = spy
    const result = await begin()
    expect(result).toEqual({ authUrl: 'https://web.test/api/config', sessionId: 'session-1' })
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('complete returns needs_onboarding when the keyring exists', async () => {
    seedFromFixture(drive, loadDesktopFixture())
    const { sessionId } = await begin()
    await expect(call('gdrive_complete_connect', { sessionId, password: '' })).resolves.toEqual({
      outcome: 'needs_onboarding',
    })
  })

  it('complete rejects with the plain message when the keyring is empty (never "ready")', async () => {
    const { sessionId } = await begin()
    expect(await message(call('gdrive_complete_connect', { sessionId, password: '' }))).toBe(
      MSG_NO_VAULT,
    )
  })

  it('complete rejects an unrecognised or half-present keyring and forgets the session', async () => {
    drive.addFile('_meta.json', drive.chain('Memlore', '.meta', 'keyring'), '{}')
    const { sessionId } = await begin()
    expect(await message(call('gdrive_complete_connect', { sessionId, password: '' }))).toContain(
      'incomplete',
    )
    expect(await message(call('gdrive_complete_connect', { sessionId, password: '' }))).toBe(
      'PENDING_DRIVE_SESSION_EXPIRED',
    )
  })

  it('complete with an unknown session reports the expired-session sentinel', async () => {
    expect(await message(call('gdrive_complete_connect', { sessionId: 'nope' }))).toBe(
      'PENDING_DRIVE_SESSION_EXPIRED',
    )
  })

  it('cancel makes the in-flight complete reject with OAUTH_CANCELLED', async () => {
    connect = () => new Promise<void>(() => undefined)
    const { sessionId } = await begin()
    const inFlight = call('gdrive_complete_connect', { sessionId, password: '' })
    await expect(call('gdrive_cancel_connect', { sessionId })).resolves.toBe(true)
    expect(await message(inFlight)).toContain('OAUTH_CANCELLED')
    await expect(call('gdrive_cancel_connect', { sessionId })).resolves.toBe(false)
  })

  it('cancel before complete starts still ends in OAUTH_CANCELLED', async () => {
    connect = () => new Promise<void>(() => undefined)
    const { sessionId } = await begin()
    await expect(call('gdrive_cancel_connect', { sessionId })).resolves.toBe(true)
    expect(await message(call('gdrive_complete_connect', { sessionId }))).toContain(
      'OAUTH_CANCELLED',
    )
  })

  it('cancel is false for an unknown session or after the connect finished', async () => {
    seedFromFixture(drive, loadDesktopFixture())
    await expect(call('gdrive_cancel_connect', { sessionId: 'nope' })).resolves.toBe(false)
    const { sessionId } = await begin()
    await call('gdrive_complete_connect', { sessionId })
    await expect(call('gdrive_cancel_connect', { sessionId })).resolves.toBe(false)
  })

  it('a closed popup (no sign-in) is a silent cancel; other connect errors pass through', async () => {
    connect = async () => {
      throw new OAuthConnectError(SIGN_IN_CANCELLED_MESSAGE)
    }
    const first = await begin()
    expect(
      await message(call('gdrive_complete_connect', { sessionId: first.sessionId })),
    ).toContain('OAUTH_CANCELLED')
    connect = async () => {
      throw new OAuthConnectError('Sign-in popup was blocked')
    }
    const second = await begin()
    expect(await message(call('gdrive_complete_connect', { sessionId: second.sessionId }))).toBe(
      'Sign-in popup was blocked',
    )
  })

  it('a pending session expires after the TTL (injectable clock)', async () => {
    seedFromFixture(drive, loadDesktopFixture())
    const { sessionId } = await begin()
    clock += PENDING_SESSION_TTL_MS + 1
    expect(await message(call('gdrive_complete_connect', { sessionId }))).toBe(
      'PENDING_DRIVE_SESSION_EXPIRED',
    )
    const fresh = await begin()
    await call('gdrive_complete_connect', { sessionId: fresh.sessionId })
    clock += PENDING_SESSION_TTL_MS + 1
    expect(
      await message(
        call('onboard_validate_passphrase', { mnemonic: 'x', sessionId: fresh.sessionId }),
      ),
    ).toBe('PENDING_DRIVE_SESSION_EXPIRED')
  })

  it('a new begin drops a ready session too', async () => {
    seedFromFixture(drive, loadDesktopFixture())
    const first = await begin()
    await call('gdrive_complete_connect', { sessionId: first.sessionId })
    await begin()
    expect(
      await message(
        call('onboard_validate_passphrase', { mnemonic: 'x', sessionId: first.sessionId }),
      ),
    ).toContain('not connected')
  })

  it('cancel aborts the in-flight popup flow and ends the Drive session', async () => {
    let seen: AbortSignal | undefined
    connect = (signal) => {
      seen = signal
      return new Promise<void>(() => undefined)
    }
    const { sessionId } = await begin()
    const inFlight = call('gdrive_complete_connect', { sessionId, password: '' })
    await call('gdrive_cancel_connect', { sessionId })
    expect(seen?.aborted).toBe(true)
    expect(await message(inFlight)).toContain('OAUTH_CANCELLED')
    expect(logout).toHaveBeenCalledTimes(1)
  })

  it('an expired session ends the Drive session', async () => {
    seedFromFixture(drive, loadDesktopFixture())
    const { sessionId } = await begin()
    clock += PENDING_SESSION_TTL_MS + 1
    await call('gdrive_complete_connect', { sessionId }).catch(() => undefined)
    expect(logout).toHaveBeenCalledTimes(1)
  })

  it('an expired ready session ends the Drive session', async () => {
    seedFromFixture(drive, loadDesktopFixture())
    const { sessionId } = await begin()
    await call('gdrive_complete_connect', { sessionId })
    clock += PENDING_SESSION_TTL_MS + 1
    await call('onboard_validate_passphrase', { mnemonic: 'x', sessionId }).catch(() => undefined)
    expect(logout).toHaveBeenCalledTimes(1)
  })

  it('a no-vault or incomplete keyring failure ends the Drive session', async () => {
    const first = await begin()
    expect(await message(call('gdrive_complete_connect', { sessionId: first.sessionId }))).toBe(
      MSG_NO_VAULT,
    )
    expect(logout).toHaveBeenCalledTimes(1)
    drive.addFile('_meta.json', drive.chain('Memlore', '.meta', 'keyring'), '{}')
    const second = await begin()
    await call('gdrive_complete_connect', { sessionId: second.sessionId }).catch(() => undefined)
    expect(logout).toHaveBeenCalledTimes(2)
  })

  it('a failed logout is swallowed: the complete error still surfaces', async () => {
    logout.mockRejectedValueOnce(new Error('offline'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { sessionId } = await begin()
    expect(await message(call('gdrive_complete_connect', { sessionId }))).toBe(MSG_NO_VAULT)
    await new Promise((r) => setTimeout(r, 0))
    expect(warn).toHaveBeenCalledWith(expect.any(String), 'Error')
    warn.mockRestore()
  })

  it('a successful connect and onboarding keep the Drive session', async () => {
    seedFromFixture(drive, loadDesktopFixture())
    const { sessionId } = await begin()
    await call('gdrive_complete_connect', { sessionId })
    await call('onboard_complete', { mnemonic: 'x', newLocalPassword: GOOD, sessionId })
    expect(logout).not.toHaveBeenCalled()
  })

  it('a new begin aborts the previous popup flow without logging out', async () => {
    let seen: AbortSignal | undefined
    connect = (signal) => {
      seen ??= signal
      return new Promise<void>(() => undefined)
    }
    await begin()
    await begin()
    expect(seen?.aborted).toBe(true)
    expect(logout).not.toHaveBeenCalled()
  })

  it('a new begin abandons the previous pending session', async () => {
    connect = () => new Promise<void>(() => undefined)
    const first = await begin()
    const inFlight = call('gdrive_complete_connect', { sessionId: first.sessionId })
    await begin()
    expect(await message(inFlight)).toContain('OAUTH_CANCELLED')
    // The replaced session's failed complete must not log out: that POST would race the new
    // popup's sign-in and clear the cookie it sets.
    expect(logout).not.toHaveBeenCalled()
  })
})

describe('onboard commands', () => {
  async function ready(): Promise<string> {
    seedFromFixture(drive, loadDesktopFixture())
    const { sessionId } = (await call('gdrive_begin_connect')) as { sessionId: string }
    await call('gdrive_complete_connect', { sessionId, password: '' })
    return sessionId
  }

  const completeArgs = (sessionId: string) => ({
    mnemonic: 'a b c',
    newLocalPassword: 'pw-1234',
    deviceName: 'ignored',
    sessionId,
    unlockMethod: 'password',
  })

  it('validate needs a connected session', async () => {
    expect(await message(call('onboard_validate_passphrase', { mnemonic: 'x' }))).toContain(
      'not connected',
    )
    expect(validatePassphrase).not.toHaveBeenCalled()
  })

  it('validate runs the read-only check on the session reader and keeps the session', async () => {
    const sessionId = await ready()
    await call('onboard_validate_passphrase', { mnemonic: 'a b c', sessionId })
    await call('onboard_validate_passphrase', { mnemonic: 'a b c', sessionId })
    const [reader, phrase] = vi.mocked(validatePassphrase).mock.calls[0]
    expect(reader).toBeInstanceOf(DriveReader)
    expect(phrase).toBe('a b c')
    expect(validatePassphrase).toHaveBeenCalledTimes(2)
  })

  it('maps the typed errors to plain sentences', async () => {
    const sessionId = await ready()
    const cases: Array<[Error, string]> = [
      [
        new RecoveryInProgressError(),
        'A recovery is in progress on another device. Try again later.',
      ],
      [
        new FormatUnsupportedError('.meta/control.json', 9),
        'This vault was created by a newer version of Memlore. Update the web app or use the desktop app.',
      ],
      [
        new VaultNotReadyError('devices'),
        'Open the Memlore desktop app once to finish setting up sync, then try again.',
      ],
      [
        new DeviceRecordConflictError(),
        'This browser holds unsent edits for a different vault. Discard them (or reconnect that vault) before onboarding another.',
      ],
      [new WrongPhraseError(), 'Wrong recovery phrase. Check each word and try again.'],
      [new ReauthRequiredError(), 'Google Drive session expired; reconnect required'],
    ]
    for (const [error, expected] of cases) {
      vi.mocked(validatePassphrase).mockRejectedValueOnce(error)
      expect(await message(call('onboard_validate_passphrase', { mnemonic: 'x', sessionId }))).toBe(
        expected,
      )
    }
  })

  it('complete passes the new password and driveDeps, emits app:unlocked and clears the session', async () => {
    const sessionId = await ready()
    await call('onboard_complete', completeArgs(sessionId))
    const [deps, input] = vi.mocked(onboardComplete).mock.calls[0]
    expect(deps.driveDeps).toBeDefined()
    expect(deps.reader).toBeInstanceOf(DriveReader)
    expect(deps.db).toBe(db)
    expect(input).toEqual({ phrase: 'a b c', password: 'pw-1234' })
    expect(events).toEqual(['app:unlocked'])
    expect(await message(call('onboard_complete', completeArgs(sessionId)))).toContain(
      'not connected',
    )

    // A second onboarding gets fresh driveDeps.
    const again = await ready()
    await call('onboard_complete', completeArgs(again))
    expect(vi.mocked(onboardComplete).mock.calls[1][0].driveDeps).toBeDefined()
  })

  it('complete failure is mapped, emits nothing and clears the session', async () => {
    const sessionId = await ready()
    vi.mocked(onboardComplete).mockRejectedValueOnce(new RecoveryInProgressError())
    expect(await message(call('onboard_complete', completeArgs(sessionId)))).toContain(
      'recovery is in progress',
    )
    expect(events).toEqual([])
    expect(
      await message(call('onboard_validate_passphrase', { mnemonic: 'x', sessionId })),
    ).toContain('not connected')
  })

  it('a cancelled session cannot be onboarded', async () => {
    connect = () => new Promise<void>(() => undefined)
    const { sessionId } = (await call('gdrive_begin_connect')) as { sessionId: string }
    const inFlight = call('gdrive_complete_connect', { sessionId })
    await call('gdrive_cancel_connect', { sessionId })
    await inFlight.catch(() => undefined)
    expect(await message(call('onboard_complete', completeArgs(sessionId)))).toContain(
      'not connected',
    )
  })
})
