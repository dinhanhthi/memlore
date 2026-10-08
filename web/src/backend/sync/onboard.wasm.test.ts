import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadCore, sealOutboxIntentV2, type Core } from '../../core/core'
import { DriveReader, DriveWriter, VaultNotReadyError } from '../drive/client'
import {
  FakeDrive,
  bytes,
  fakeLocks,
  fixtureBytes,
  json,
  loadDesktopFixture,
  seedFromFixture,
  text,
  violations,
  type DesktopFixture,
  type Recorded,
  type SeedFixtureOptions,
} from '../drive/fakeDrive'
import { isValidOwnId } from '../drive/paths'
import {
  createDraftManager,
  resetDraftsAutostartForTest,
  sha256Hex,
  unpushedDraftCount,
} from '../drafts'
import { configureReadEnv, readEnv, resetReadSession } from '../commands/readSession'
import {
  configureKeysEnv,
  dispose,
  getKeyRing,
  isUnlocked,
  lock,
  onLock,
  setKeyRing,
  type KeyRing,
} from '../keys'
import {
  StorageUnavailableError,
  WRAPPED_MASTER_HEX_LEN,
  assertDeviceRecord,
  openWebDb,
  type WebDb,
} from '../storage/idb'
import type { OutboxEntryV1 } from './outbox'
import {
  CONTENT_READ_ATTEMPTS,
  DeviceRecordConflictError,
  FingerprintMismatchError,
  FormatUnsupportedError,
  GenerationMismatchError,
  InvalidDeviceIdError,
  InvalidPhraseError,
  RecoveryInProgressError,
  TransientReadError,
  VaultChangedError,
  VaultCorruptError,
  WrongPhraseError,
  browserName,
  isAcceptableDeviceId,
  onboardComplete,
  validatePassphrase,
  type OnboardDeps,
} from './onboard'

const PASSWORD = '12345678'
const OTHER_PHRASE = `${'zoo '.repeat(23)}vote`
const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const REUSED_ID = 'aaaaaaaa-1111-4222-8333-bbbbbbbbbbbb'
const FIXED_ID = 'cccccccc-1111-4222-8333-dddddddddddd'
const DESKTOP_RE = /^[A-Za-z0-9_-]{4,64}$/
const WEB_RE = /^[0-9a-fA-F-]{8,64}$/
const META = '.meta/keyring/_meta.json'
const CONTROL = '.meta/control.json'
const RECOVERY = '.meta/keyring/_recovery.json'
const CONTENT = '.meta/keyring/_content.json'

let core: Core
let fixture: DesktopFixture

interface Env {
  drive: FakeDrive
  db: WebDb
  deps: OnboardDeps
  /** Backoff sleeps requested by onboard.ts itself (not the Drive client). */
  onboardSleeps: number[]
  persist: ReturnType<typeof vi.fn<() => Promise<boolean>>>
  randomUUID: ReturnType<typeof vi.fn<() => string>>
}

function patched(path: string, change: (value: Record<string, unknown>) => void): string {
  const value = JSON.parse(text(fixtureBytes(fixture, path))) as Record<string, unknown>
  change(value)
  return JSON.stringify(value)
}

async function setup(
  seed: SeedFixtureOptions = {},
  factory: IDBFactory = new IDBFactory(),
): Promise<Env> {
  const drive = new FakeDrive()
  seedFromFixture(drive, fixture, seed)
  const driveDeps = {
    getToken: async () => 'tok',
    fetchImpl: drive.fetch,
    sleep: async () => {},
    locks: fakeLocks(drive),
  }
  const reader = new DriveReader(driveDeps)
  const writer = new DriveWriter(reader, driveDeps)
  const db = await openWebDb({ factory })
  const onboardSleeps: number[] = []
  const persist = vi.fn<() => Promise<boolean>>(async () => true)
  const randomUUID = vi.fn<() => string>(() => FIXED_ID)
  const deps: OnboardDeps = {
    reader,
    writer,
    db,
    core,
    now: () => 1_800_000_000_000,
    randomUUID,
    userAgent: () => CHROME_UA,
    persist,
    sleep: async (ms) => {
      onboardSleeps.push(ms)
    },
  }
  return { drive, db, deps, onboardSleeps, persist, randomUUID }
}

const run = (env: Env, phrase = fixture.recovery_phrase) =>
  onboardComplete(env.deps, { phrase, password: PASSWORD })

/** Every file of the fake Drive as a comparable string (id, name, parent, bytes, version). */
function snapshot(drive: FakeDrive): Map<string, string> {
  return new Map(
    drive.files.map((f) => [
      f.id,
      JSON.stringify([f.name, f.parents, Buffer.from(f.content).toString('base64'), f.version]),
    ]),
  )
}

function expectNothingWritten(env: Env, before: Map<string, string>): void {
  expect(env.drive.mutating()).toEqual([])
  expect(snapshot(env.drive)).toEqual(before)
}

async function expectNoSideEffects(env: Env): Promise<void> {
  expect(await env.db.device.get()).toBeUndefined()
  expect(isUnlocked()).toBe(false)
}

/** The request that created or updated the device slot; asserts it is the ONLY mutation. */
function onlySlotWrite(drive: FakeDrive, deviceId: string): Recorded {
  const writes = drive.mutating()
  expect(writes).toHaveLength(1)
  const [req] = writes
  const devices = drive.find(['Memlore', '.meta', 'keyring', 'devices'])
  expect(devices).toBeDefined()
  if (req.method === 'POST') {
    expect(req.url.pathname).toBe('/upload/drive/v3/files')
    expect(req.url.searchParams.get('uploadType')).toBe('multipart')
    const raw = Buffer.from(req.body ?? new Uint8Array()).toString('latin1')
    expect(raw).toContain(`"name":"${deviceId}.json"`)
    expect(raw).toContain(`"parents":["${devices?.id}"]`)
  } else {
    expect(req.method).toBe('PATCH')
    const slot = drive.find(['Memlore', '.meta', 'keyring', 'devices', `${deviceId}.json`])
    expect(slot).toBeDefined()
    expect(req.url.pathname).toBe(`/upload/drive/v3/files/${slot?.id}`)
  }
  return req
}

/** Make the Nth `alt=media` GET of `path` run `change` first (then the fake answers normally). */
function onNthRead(env: Env, path: string, nth: number, change: () => void): void {
  const file = env.drive.find(['Memlore', ...path.split('/')])
  if (!file) throw new Error(`no such file ${path}`)
  let seen = 0
  env.drive.interceptors.push((req) => {
    if (req.method === 'GET' && req.url.pathname === `/drive/v3/files/${file.id}`) {
      if (req.url.searchParams.get('alt') === 'media' && ++seen === nth) change()
    }
    return undefined
  })
}

const entryPath = (id: string): string =>
  `generations/g-${fixture.generation}/${fixture.device_id}/entries/${id}.bin`

function expectOpensFixtureEntries(ring = getKeyRing()): void {
  for (const e of fixture.expected.entries) {
    const opened = core.openEntry(ring, fixtureBytes(fixture, entryPath(e.entry_id)))
    expect((JSON.parse(opened.metadataJson) as { title: string }).title).toBe(e.title)
  }
}

beforeAll(async () => {
  core = await loadCore()
  fixture = loadDesktopFixture()
})

beforeEach(() => {
  violations.length = 0
  resetDraftsAutostartForTest()
  // No real timers or events from the key holder's idle watchers.
  configureKeysEnv({
    setTimeout: () => 0,
    clearTimeout: () => {},
    emit: () => {},
    document: null,
    window: null,
  })
})

afterEach(() => {
  dispose()
  configureReadEnv({})
  vi.unstubAllGlobals()
  expect(violations).toEqual([])
})

describe('onboardComplete: happy path', () => {
  it('unlocks a ring that opens the fixture entries and writes only the device slot', async () => {
    const env = await setup()
    const before = snapshot(env.drive)
    const result = await run(env)

    expect(isUnlocked()).toBe(true)
    expectOpensFixtureEntries()
    expect(result).toMatchObject({
      deviceId: FIXED_ID,
      deviceName: 'Memlore Web (Chrome)',
      reusedDeviceId: false,
      recoveryGeneration: 0,
      persisted: true,
    })

    // The ONE write: a single create of .meta/keyring/devices/<id>.json, nothing else.
    onlySlotWrite(env.drive, FIXED_ID)
    const after = snapshot(env.drive)
    const added = [...after.keys()].filter((id) => !before.has(id))
    expect(added).toHaveLength(1)
    for (const [id, state] of before) expect(after.get(id)).toBe(state) // incl. _meta/control
    const slotFile = env.drive.find(['Memlore', '.meta', 'keyring', 'devices', `${FIXED_ID}.json`])
    const slot = JSON.parse(core.parseDeviceSlot(text(slotFile?.content ?? new Uint8Array()))) as {
      device_id: string
      name: string
      created_at: number
      last_seen_at: number
      version: number
    }
    expect(slot).toEqual({
      version: 2,
      device_id: FIXED_ID,
      name: 'Memlore Web (Chrome)',
      created_at: 1_800_000_000,
      last_seen_at: 1_800_000_000,
    })
  })

  it('stores only the wrapped master: it unlocks with the web password, no raw key or phrase', async () => {
    const env = await setup()
    await run(env)
    const record = await env.db.device.get()
    expect(record).toBeDefined()
    assertDeviceRecord(record)
    expect(record.deviceId).toBe(FIXED_ID)
    expect(record.wrappedMasterHex).toHaveLength(WRAPPED_MASTER_HEX_LEN)
    expect(record.kekSaltHex).toMatch(/^[0-9a-f]{32}$/)
    expect(record.recoveryGeneration).toBe(0)
    expect(record.name).toBe('Memlore Web (Chrome)')
    const meta = JSON.parse(text(fixtureBytes(fixture, META))) as { master_fingerprint: string }
    expect(record.masterFingerprint).toBe(meta.master_fingerprint)
    const serialized = JSON.stringify(record)
    expect(serialized).not.toContain('abandon')
    expect(serialized).not.toContain(PASSWORD)

    // The stored blob round-trips through unlockLocal with the web password only.
    const salt = Uint8Array.from(Buffer.from(record.kekSaltHex, 'hex'))
    const ring = core.KeyRing.unlockLocal(record.wrappedMasterHex, PASSWORD, salt)
    ring.loadContentList(text(fixtureBytes(fixture, CONTENT)))
    expectOpensFixtureEntries(ring)
    ring.lock()
    expect(() => core.KeyRing.unlockLocal(record.wrappedMasterHex, 'wrong', salt)).toThrow()
  })

  it('caches the _content.json text it read (pinned, under its Drive path) for offline unlock', async () => {
    const env = await setup()
    await run(env)
    const cached = await env.db.files.get(CONTENT)
    expect(cached?.pinned).toBe(true)
    expect(text(cached?.ciphertext ?? new Uint8Array())).toBe(text(fixtureBytes(fixture, CONTENT)))
  })

  it('caches the _meta.json text it onboarded with (pinned) for the push fence', async () => {
    const env = await setup()
    await env.db.files.put({
      path: META,
      ciphertext: bytes('stale'),
      etag: null,
      modifiedTime: null,
      lastAccess: 1,
      pinned: true,
    })
    await run(env)
    const cached = await env.db.files.get(META)
    expect(cached?.pinned).toBe(true)
    expect(text(cached?.ciphertext ?? new Uint8Array())).toBe(text(fixtureBytes(fixture, META)))
  })

  it('caches nothing when _content.json is confirmed absent', async () => {
    const env = await setup({ omit: (p) => p === CONTENT })
    await run(env)
    expect(await env.db.files.get(CONTENT)).toBeUndefined()
  })

  it('uses a crypto.randomUUID id that desktop and the web client both accept', async () => {
    const env = await setup()
    delete env.deps.randomUUID
    const result = await run(env)
    expect(result.deviceId).toMatch(DESKTOP_RE)
    expect(result.deviceId).toMatch(WEB_RE)
    expect(isValidOwnId(result.deviceId)).toBe(true)
    expect(isAcceptableDeviceId(result.deviceId)).toBe(true)
    onlySlotWrite(env.drive, result.deviceId)
  })

  it('carries the control generation into the stored record', async () => {
    const env = await setup({
      overrides: {
        [CONTROL]: patched(CONTROL, (c) => (c.recovery_generation = 3)),
        [META]: patched(META, (m) => (m.recovery_generation = 3)),
      },
    })
    const result = await run(env)
    expect(result.recoveryGeneration).toBe(3)
    expect((await env.db.device.get())?.recoveryGeneration).toBe(3)
  })

  it('asks for durable storage once; a refusal or an error is not fatal', async () => {
    const env = await setup()
    await run(env)
    expect(env.persist).toHaveBeenCalledTimes(1)

    const refused = await setup()
    refused.persist.mockResolvedValue(false)
    expect((await run(refused)).persisted).toBe(false)

    dispose()
    const broken = await setup()
    broken.persist.mockRejectedValue(new Error('denied'))
    const result = await run(broken)
    expect(result.persisted).toBe(false)
    expect(isUnlocked()).toBe(true)
  })

  it('a failed slot write aborts: no device record, no key left loaded', async () => {
    const env = await setup()
    env.drive.interceptors.push((req) =>
      req.method === 'POST' ? json({ error: 'boom' }, 500) : undefined,
    )
    await expect(run(env)).rejects.toThrow()
    await expectNoSideEffects(env)
    expect(env.persist).not.toHaveBeenCalled()
  })
})

describe('onboardComplete: vault checks (zero writes on refusal)', () => {
  it('refuses while a recovery lease is active', async () => {
    const env = await setup({
      overrides: {
        [CONTROL]: patched(CONTROL, (c) => {
          c.recovery_generation = 1
          c.recovery_lease = {
            version: 1,
            job_id: 1,
            owner_device_id: 'aaaaaaaa-bbbb',
            operation: 'local_to_cloud',
            recovery_generation: 1,
            nonce: 'abcdef0123456789',
            created_at: 1,
            updated_at: 1,
          }
        }),
      },
    })
    const before = snapshot(env.drive)
    await expect(run(env)).rejects.toBeInstanceOf(RecoveryInProgressError)
    expectNothingWritten(env, before)
    await expectNoSideEffects(env)
  })

  it('maps a wrong phrase, a malformed phrase and a foreign fingerprint to typed errors', async () => {
    const env = await setup()
    const before = snapshot(env.drive)
    await expect(run(env, OTHER_PHRASE)).rejects.toBeInstanceOf(WrongPhraseError)
    await expect(run(env, 'not a real phrase')).rejects.toBeInstanceOf(InvalidPhraseError)
    expectNothingWritten(env, before)
    await expectNoSideEffects(env)

    const foreign = await setup({
      overrides: { [META]: patched(META, (m) => (m.master_fingerprint = 'ab'.repeat(32))) },
    })
    await expect(run(foreign)).rejects.toBeInstanceOf(FingerprintMismatchError)
    expect(foreign.drive.mutating()).toEqual([])
    await expectNoSideEffects(foreign)
  })

  it('refuses when meta.recovery_generation differs from control', async () => {
    const env = await setup({
      overrides: { [CONTROL]: patched(CONTROL, (c) => (c.recovery_generation = 1)) },
    })
    await expect(run(env)).rejects.toBeInstanceOf(GenerationMismatchError)
    expect(env.drive.mutating()).toEqual([])
    await expectNoSideEffects(env)
  })

  it.each([
    ['control.json', CONTROL, 9],
    ['_meta.json', META, 3],
    ['_recovery.json', RECOVERY, 3],
    ['_content.json', CONTENT, 3],
  ])('format guard: an unknown version in %s is read-only-incompatible', async (_n, path, v) => {
    const env = await setup({
      overrides: { [path]: patched(path, (value) => (value.version = v)) },
    })
    const before = snapshot(env.drive)
    const error = await run(env).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(FormatUnsupportedError)
    expect((error as FormatUnsupportedError).path).toBe(path)
    expect((error as FormatUnsupportedError).version).toBe(v)
    expectNothingWritten(env, before)
    await expectNoSideEffects(env)
  })

  it('refuses a missing recovery slot and an empty content list as a corrupt vault', async () => {
    const noRecovery = await setup({ omit: (p) => p === RECOVERY })
    await expect(run(noRecovery)).rejects.toBeInstanceOf(VaultCorruptError)
    expect(noRecovery.drive.mutating()).toEqual([])

    const empty = await setup({
      overrides: {
        [CONTENT]: JSON.stringify({ version: 2, latest_epoch: 0, entries: [], created_at: 1 }),
      },
    })
    await expect(run(empty)).rejects.toBeInstanceOf(VaultCorruptError)
    expect(empty.drive.mutating()).toEqual([])
    await expectNoSideEffects(empty)
  })
})

describe('onboardComplete: _content.json three-way handling', () => {
  it('present: every epoch is unwrapped and the fixture entries open', async () => {
    const env = await setup()
    await run(env)
    expectOpensFixtureEntries()
  })

  it('confirmed absent: epoch 1 = master (the vault keys are NOT the fixture content keys)', async () => {
    const env = await setup({ omit: (p) => p === CONTENT })
    await run(env)
    expect(isUnlocked()).toBe(true)
    const entry = fixture.expected.entries[0]
    expect(() =>
      core.openEntry(getKeyRing(), fixtureBytes(fixture, entryPath(entry.entry_id))),
    ).toThrow()
    onlySlotWrite(env.drive, FIXED_ID)
  })

  it('transient error: retried a bounded number of times, then TransientReadError, never absent', async () => {
    const env = await setup()
    const file = env.drive.find(['Memlore', ...CONTENT.split('/')])
    env.drive.interceptors.push((req) =>
      req.url.pathname === `/drive/v3/files/${file?.id}` ? json({ error: 'down' }, 503) : undefined,
    )
    const before = snapshot(env.drive)
    await expect(run(env)).rejects.toBeInstanceOf(TransientReadError)
    expect(env.onboardSleeps).toEqual([500, 1000]) // between the 3 attempts, none after the last
    expect(CONTENT_READ_ATTEMPTS).toBe(3)
    expectNothingWritten(env, before)
    await expectNoSideEffects(env)
  })

  it('transient error that clears: the retry loads the real content keys', async () => {
    const env = await setup()
    const file = env.drive.find(['Memlore', ...CONTENT.split('/')])
    let failures = 0
    env.drive.interceptors.push((req) => {
      if (req.url.pathname !== `/drive/v3/files/${file?.id}`) return undefined
      // The Drive client itself makes 4 attempts per read: fail the first full read only.
      return ++failures <= 4 ? json({ error: 'down' }, 503) : undefined
    })
    await run(env)
    expect(env.onboardSleeps).toEqual([500])
    expectOpensFixtureEntries()
  })
})

describe('onboardComplete: TOCTOU re-read', () => {
  it('aborts when control.json changes between the read and the re-read', async () => {
    const env = await setup()
    onNthRead(env, CONTROL, 2, () => {
      const file = env.drive.find(['Memlore', ...CONTROL.split('/')])
      if (file) file.content = bytes(patched(CONTROL, (c) => (c.updated_at = 99)))
    })
    await expect(run(env)).rejects.toBeInstanceOf(VaultChangedError)
    expect(env.drive.mutating()).toEqual([])
    await expectNoSideEffects(env)
  })

  it('aborts when a rotation changes the keyring meta between the read and the re-read', async () => {
    const env = await setup()
    onNthRead(env, META, 2, () => {
      const file = env.drive.find(['Memlore', ...META.split('/')])
      if (file) file.content = bytes(patched(META, (m) => (m.epoch = 2)))
    })
    await expect(run(env)).rejects.toBeInstanceOf(VaultChangedError)
    expect(env.drive.mutating()).toEqual([])
    await expectNoSideEffects(env)
  })

  it('aborts when a recovery lease appears on the re-read', async () => {
    const env = await setup()
    onNthRead(env, CONTROL, 2, () => {
      const file = env.drive.find(['Memlore', ...CONTROL.split('/')])
      if (file) {
        file.content = bytes(
          patched(CONTROL, (c) => {
            c.recovery_lease = {
              version: 1,
              job_id: 1,
              owner_device_id: 'aaaaaaaa-bbbb',
              operation: 'cloud_cleanup',
              recovery_generation: 0,
              nonce: 'abcdef0123456789',
              created_at: 1,
              updated_at: 1,
            }
          }),
        )
      }
    })
    await expect(run(env)).rejects.toThrow()
    expect(env.drive.mutating()).toEqual([])
    await expectNoSideEffects(env)
  })
})

describe('onboardComplete: the shared devices folder is never created', () => {
  it('VaultNotReadyError with ZERO writes when .meta/keyring/devices is missing', async () => {
    const env = await setup({ omit: (p) => p.startsWith('.meta/keyring/devices/') })
    expect(env.drive.find(['Memlore', '.meta', 'keyring', 'devices'])).toBeUndefined()
    const before = snapshot(env.drive)
    await expect(run(env)).rejects.toBeInstanceOf(VaultNotReadyError)
    expectNothingWritten(env, before) // no slot, no folder, no _meta.json
    await expectNoSideEffects(env)
    expect(env.persist).not.toHaveBeenCalled()
  })
})

describe('onboardComplete: device id', () => {
  const storedRecord = (masterFingerprint: string, deviceId = REUSED_ID) => ({
    deviceId,
    wrappedMasterHex: 'ab'.repeat(WRAPPED_MASTER_HEX_LEN / 2),
    kekSaltHex: 'cd'.repeat(16),
    recoveryGeneration: 0,
    masterFingerprint,
    name: 'Memlore Web (Firefox)',
  })
  const vaultFingerprint = (): string =>
    (JSON.parse(text(fixtureBytes(fixture, META))) as { master_fingerprint: string })
      .master_fingerprint

  it('reuses the IndexedDB device id of the same vault (rotation deleted the slot)', async () => {
    const env = await setup()
    await env.db.device.put(storedRecord(vaultFingerprint()))
    const result = await run(env)
    expect(result.deviceId).toBe(REUSED_ID)
    expect(result.reusedDeviceId).toBe(true)
    expect(env.randomUUID).not.toHaveBeenCalled()
    onlySlotWrite(env.drive, REUSED_ID)
    const record = await env.db.device.get()
    expect(record?.deviceId).toBe(REUSED_ID)
    // The stale wrapped master is replaced by the freshly wrapped one.
    expect(record?.wrappedMasterHex).not.toBe('ab'.repeat(WRAPPED_MASTER_HEX_LEN / 2))
  })

  it('updates an existing own slot in place (one PATCH, no second slot)', async () => {
    const env = await setup()
    const devices = env.drive.chain('Memlore', '.meta', 'keyring', 'devices')
    env.drive.addFile(`${REUSED_ID}.json`, devices, '{}')
    await env.db.device.put(storedRecord(vaultFingerprint()))
    await run(env)
    const req = onlySlotWrite(env.drive, REUSED_ID)
    expect(req.method).toBe('PATCH')
    expect(req.url.searchParams.get('uploadType')).toBe('media')
    expect(req.headers.has('if-match')).toBe(true)
  })

  it('generates a new id when the stored record belongs to another vault', async () => {
    const env = await setup()
    await env.db.device.put(storedRecord('ef'.repeat(32)))
    const result = await run(env)
    expect(result.deviceId).toBe(FIXED_ID)
    expect(result.reusedDeviceId).toBe(false)
    expect(env.randomUUID).toHaveBeenCalledTimes(1)
    onlySlotWrite(env.drive, FIXED_ID)
  })

  it('different vault + pushed drafts only: they are in the old outbox; replaced and cleared', async () => {
    const env = await setup()
    await env.db.device.put(storedRecord('ef'.repeat(32)))
    const sealed = new Uint8Array([1, 2])
    await env.db.drafts.put({
      entryId: 'e1',
      sealed,
      updatedAt: 1,
      pushedHash: await sha256Hex(sealed),
    })
    await run(env)
    expect(await env.db.drafts.list()).toEqual([])
    expect((await env.db.device.get())?.masterFingerprint).toBe(vaultFingerprint())
  })

  it('different vault + unsent drafts: refused with ZERO writes (cloud and IndexedDB)', async () => {
    const env = await setup()
    const old = storedRecord('ef'.repeat(32))
    await env.db.device.put(old)
    const sealed = new Uint8Array([1, 2])
    const pushedHash = 'ab'.repeat(32) // a hash of other bytes: this revision was never pushed
    await env.db.drafts.put({ entryId: 'e1', sealed, updatedAt: 1, pushedHash })
    await env.db.files.put({
      path: 'x',
      ciphertext: new Uint8Array([1]),
      etag: null,
      modifiedTime: null,
      lastAccess: 1,
      pinned: false,
    })
    const before = snapshot(env.drive)
    await expect(run(env)).rejects.toBeInstanceOf(DeviceRecordConflictError)
    expectNothingWritten(env, before)
    expect(await env.db.device.get()).toEqual(old)
    expect(await env.db.drafts.list()).toEqual([
      { entryId: 'e1', sealed, updatedAt: 1, pushedHash },
    ])
    expect(await env.db.files.get('x')).toBeDefined()
    expect(isUnlocked()).toBe(false)
  })

  it('different vault, no drafts: the old vault cache is cleared and the new record stored', async () => {
    const env = await setup()
    await env.db.device.put(storedRecord('ef'.repeat(32)))
    await env.db.files.put({
      path: 'old-vault-file',
      ciphertext: new Uint8Array([1]),
      etag: null,
      modifiedTime: null,
      lastAccess: 1,
      pinned: false,
    })
    await env.db.meta.put({ key: 'k', value: 1 })
    await run(env)
    expect(await env.db.files.get('old-vault-file')).toBeUndefined()
    expect(await env.db.meta.get('k')).toBeUndefined()
    expect((await env.db.device.get())?.masterFingerprint).toBe(vaultFingerprint())
  })

  /** A draft sealed under the fixture vault's content key (what this browser would have saved). */
  const sealedForThisVault = (entryId: string): Uint8Array => {
    const meta = JSON.parse(text(fixtureBytes(fixture, META))) as { master_fingerprint: string }
    const recovery = JSON.parse(text(fixtureBytes(fixture, RECOVERY))) as { wrapped_master: string }
    const ring = core.KeyRing.fromRecovery(
      fixture.recovery_phrase,
      recovery.wrapped_master,
      meta.master_fingerprint,
    )
    ring.loadContentList(text(fixtureBytes(fixture, CONTENT)))
    const empty = { entry_date: null, emotion: null, is_favorite: null, journal_id: null }
    const sealed = core.sealOutboxEntry(
      ring,
      JSON.stringify({
        schema_version: 1,
        entry_id: entryId,
        web_device_id: FIXED_ID,
        created_on_web: true,
        web_updated_at_secs: 1_700_000_000,
        base_state_vector: [],
        yjs_full_state: [1, 2, 3],
        content_text: 'x',
        preview_text: null,
        fields: { title: null, ...empty, tags_add: {}, tags_remove: {} },
        media: [],
      }),
    )
    ring.lock()
    return sealed
  }

  it('no device record + drafts of THIS vault: onboards and re-pushes them', async () => {
    const env = await setup()
    const entryId = 'eeeeeeee-1111-4222-8333-ffffffffffff'
    const sealed = sealedForThisVault(entryId)
    const pushedHash = await sha256Hex(sealed)
    await env.db.drafts.put({ entryId, sealed, updatedAt: 1, pushedHash })
    await run(env)
    expect(await env.db.drafts.list()).toEqual([{ entryId, sealed, updatedAt: 1 }])
  })

  it('no device record + a v2 (journal) draft of THIS vault: onboards, not a conflict', async () => {
    const env = await setup()
    const meta = JSON.parse(text(fixtureBytes(fixture, META))) as { master_fingerprint: string }
    const recovery = JSON.parse(text(fixtureBytes(fixture, RECOVERY))) as { wrapped_master: string }
    const ring = core.KeyRing.fromRecovery(
      fixture.recovery_phrase,
      recovery.wrapped_master,
      meta.master_fingerprint,
    )
    ring.loadContentList(text(fixtureBytes(fixture, CONTENT)))
    const journalId = 'eeeeeeee-1111-4222-8333-000000000001'
    const sealed = sealOutboxIntentV2(core, ring, {
      kind: 'create_journal',
      web_device_id: FIXED_ID,
      web_updated_at_secs: 1_700_000_000,
      journal_id: journalId,
      name: 'Travel',
      color: null,
      auto_tag_ids: [],
    })
    ring.lock()
    await env.db.drafts.put({ entryId: `j-${journalId}`, kind: 'journal', sealed, updatedAt: 1 })
    await run(env)
    expect(await env.db.drafts.list()).toEqual([
      { entryId: `j-${journalId}`, kind: 'journal', sealed, updatedAt: 1 },
    ])
  })

  it('no device record + drafts that do not open under this vault: refused, ZERO writes', async () => {
    const env = await setup()
    const sealed = new Uint8Array([1, 2])
    const pushedHash = await sha256Hex(sealed)
    await env.db.drafts.put({ entryId: 'e1', sealed, updatedAt: 1, pushedHash })
    const before = snapshot(env.drive)
    await expect(run(env)).rejects.toBeInstanceOf(DeviceRecordConflictError)
    expectNothingWritten(env, before)
    expect(await env.db.device.get()).toBeUndefined()
    expect(await env.db.drafts.list()).toEqual([
      { entryId: 'e1', sealed, updatedAt: 1, pushedHash },
    ])
    expect(isUnlocked()).toBe(false)
  })

  it('same vault: the id is reused and nothing is cleared (drafts and cache survive)', async () => {
    const env = await setup()
    await env.db.device.put(storedRecord(vaultFingerprint()))
    await env.db.drafts.put({ entryId: 'e1', sealed: new Uint8Array([1, 2]), updatedAt: 1 })
    await env.db.files.put({
      path: 'keep',
      ciphertext: new Uint8Array([1]),
      etag: null,
      modifiedTime: null,
      lastAccess: 1,
      pinned: false,
    })
    const result = await run(env)
    expect(result.reusedDeviceId).toBe(true)
    expect(await env.db.drafts.list()).toHaveLength(1)
    expect(await env.db.files.get('keep')).toBeDefined()
  })

  // A re-onboard may follow a recovery-generation change (new `g-<gen>` outbox) or a Cloud cleanup
  // (outbox deleted): drafts pushed before it must be pushed again (contract §9).
  const seedPushedDrafts = async (env: Env) => {
    const drafts = [
      { entryId: 'e1', sealed: new Uint8Array([1, 2]), updatedAt: 1 },
      { entryId: 'e2', sealed: new Uint8Array([3, 4, 5]), updatedAt: 2 },
    ]
    for (const d of drafts) await env.db.drafts.put({ ...d, pushedHash: await sha256Hex(d.sealed) })
    const media = { path: 'outbox/m-1', bytes: new Uint8Array([9]), size: 1, lastAccess: 1 }
    await env.db.blobs.put(media)
    return { drafts, media }
  }

  it('same vault: drafts pushed before the re-onboard are unpushed again, media kept', async () => {
    const env = await setup()
    await env.db.device.put(storedRecord(vaultFingerprint()))
    const { drafts, media } = await seedPushedDrafts(env)
    expect(await createDraftManager({ db: env.db }).listUnpushedDrafts()).toEqual([])
    expect(unpushedDraftCount()).toBe(0)
    await run(env)
    const unpushed = await env.db.drafts.list()
    expect(unpushed).toEqual(drafts)
    expect(unpushedDraftCount()).toBe(2)
    expect(await createDraftManager({ db: env.db }).listUnpushedDrafts()).toEqual(drafts)
    expect(await env.db.blobs.get(media.path)).toEqual(media)
  })

  it('same vault: a failed draft reset fails the onboarding before the new record lands', async () => {
    const env = await setup()
    const old = storedRecord(vaultFingerprint())
    await env.db.device.put(old)
    await seedPushedDrafts(env)
    vi.spyOn(env.db.drafts, 'clearPushed').mockRejectedValueOnce(new StorageUnavailableError())
    await expect(run(env)).rejects.toBeInstanceOf(StorageUnavailableError)
    expect(await env.db.device.get()).toEqual(old)
    expect(isUnlocked()).toBe(false)
  })

  // Settings can open onboarding while the vault is still unlocked (a reconnect after a refresh
  // 401). The old session must not outlive the ring it was built for.
  describe('re-onboard while unlocked', () => {
    const ENTRY_A = 'aaaaaaaa-2222-4333-8444-555555555555'
    const FOREIGN_ID = 'bbbbbbbb-2222-4333-8444-555555555555'
    const intent = (entryId: string): OutboxEntryV1 => ({
      schema_version: 1,
      entry_id: entryId,
      web_device_id: REUSED_ID,
      created_on_web: true,
      web_updated_at_secs: 1_700_000_000,
      base_state_vector: [],
      yjs_full_state: [1, 2, 3],
      content_text: 'from vault A',
      preview_text: null,
      fields: {
        title: null,
        entry_date: null,
        emotion: null,
        is_favorite: null,
        journal_id: null,
        tags_add: {},
        tags_remove: {},
      },
      media: [],
    })
    const openRingForTest = (): KeyRing => {
      const recovery = JSON.parse(text(fixtureBytes(fixture, RECOVERY))) as {
        wrapped_master: string
      }
      return core.KeyRing.fromRecovery(
        fixture.recovery_phrase,
        recovery.wrapped_master,
        vaultFingerprint(),
      )
    }

    /** An unlocked browser: a ring loaded, a read session built over the same IndexedDB. */
    async function unlockedEnv(masterFingerprint: string) {
      const factory = new IDBFactory()
      vi.stubGlobal('indexedDB', factory)
      const env = await setup({}, factory)
      await env.db.device.put(storedRecord(masterFingerprint))
      const oldRing = openRingForTest()
      setKeyRing(oldRing)
      const session = await readEnv().session()
      session.vault.setOutboxIntents([intent(ENTRY_A)])
      session.vault.setForeignIntents([intent(FOREIGN_ID)])
      const lockHook = vi.fn()
      onLock(lockHook)
      return { env, oldRing, session, lockHook }
    }

    it('another vault: locks first, drops the session, no old intent stays reachable', async () => {
      const { env, oldRing, session, lockHook } = await unlockedEnv('ef'.repeat(32))
      // The foreign intent of vault A is overlaid before the switch.
      expect(session.vault.status(FOREIGN_ID)).toBe('visible')
      await run(env)
      expect(lockHook).toHaveBeenCalledTimes(1)
      expect(isUnlocked()).toBe(true)
      expect(getKeyRing()).not.toBe(oldRing)
      // The old session was torn down by the lock hooks...
      expect(session.vault.getOutboxIntents()).toEqual([])
      expect(session.vault.getOutboxIntent(ENTRY_A)).toBeUndefined()
      // ...and is no longer the one the commands get.
      const fresh = await readEnv().session()
      expect(fresh).not.toBe(session)
      expect(fresh.vault.getOutboxIntents()).toEqual([])
      expect(fresh.vault.getOutboxIntent(ENTRY_A)).toBeUndefined()
      expect(session.vault.status(FOREIGN_ID)).toBe('not-loaded')
      expect(fresh.vault.status(FOREIGN_ID)).toBe('not-loaded')
      // Nothing of vault A is left to push.
      expect(await env.db.drafts.list()).toEqual([])
    })

    it('same vault: a clean lock/unlock cycle, drafts kept', async () => {
      const { env, oldRing, session, lockHook } = await unlockedEnv(vaultFingerprint())
      const draft = { entryId: ENTRY_A, sealed: new Uint8Array([1, 2]), updatedAt: 1 }
      await env.db.drafts.put(draft)
      await run(env)
      expect(lockHook).toHaveBeenCalledTimes(1)
      expect(isUnlocked()).toBe(true)
      expect(getKeyRing()).not.toBe(oldRing)
      // The overlay is rebuilt from IndexedDB by the next ready(), not carried over from RAM.
      expect(session.vault.getOutboxIntents()).toEqual([])
      expect(await env.db.drafts.list()).toEqual([draft])
    })

    it('a refused re-onboard leaves the user unlocked with the same session', async () => {
      const { env, oldRing, session, lockHook } = await unlockedEnv('ef'.repeat(32))
      await expect(run(env, OTHER_PHRASE)).rejects.toBeInstanceOf(WrongPhraseError)
      // Unsent draft of the old vault: the conflict refusal.
      await env.db.drafts.put({ entryId: ENTRY_A, sealed: new Uint8Array([1, 2]), updatedAt: 1 })
      await expect(run(env)).rejects.toBeInstanceOf(DeviceRecordConflictError)
      expect(lockHook).not.toHaveBeenCalled()
      expect(isUnlocked()).toBe(true)
      expect(getKeyRing()).toBe(oldRing)
      expect(await readEnv().session()).toBe(session)
      expect(session.vault.getOutboxIntent(ENTRY_A)).toEqual(intent(ENTRY_A))
    })

    // The slot write is the only network step: it runs BEFORE the lock, so a Drive failure (or a
    // reauth) leaves the user exactly as they were.
    it('a failed slot write while unlocked: still unlocked, same session, nothing wiped', async () => {
      const { env, oldRing, session, lockHook } = await unlockedEnv('ef'.repeat(32))
      const old = await env.db.device.get()
      env.drive.interceptors.push((req) =>
        req.method === 'POST' ? json({ error: 'boom' }, 500) : undefined,
      )
      await expect(run(env)).rejects.toThrow()
      expect(lockHook).not.toHaveBeenCalled()
      expect(isUnlocked()).toBe(true)
      expect(getKeyRing()).toBe(oldRing)
      expect(await readEnv().session()).toBe(session)
      expect(session.vault.getOutboxIntent(ENTRY_A)).toEqual(intent(ENTRY_A))
      expect(await env.db.device.get()).toEqual(old)
    })

    // After the lock only IndexedDB steps remain: a failure there leaves the app locked (a reload
    // recovers: same vault -> the old record unlocks; other vault -> onboarding).
    it('same vault: a failed record write after the lock leaves it locked, record and drafts kept', async () => {
      const { env, lockHook } = await unlockedEnv(vaultFingerprint())
      const old = await env.db.device.get()
      const draft = { entryId: ENTRY_A, sealed: new Uint8Array([1, 2]), updatedAt: 1 }
      await env.db.drafts.put(draft)
      vi.spyOn(env.db.device, 'put').mockRejectedValueOnce(new StorageUnavailableError())
      await expect(run(env)).rejects.toBeInstanceOf(StorageUnavailableError)
      onlySlotWrite(env.drive, REUSED_ID)
      expect(lockHook).toHaveBeenCalledTimes(1)
      expect(isUnlocked()).toBe(false)
      expect(await env.db.device.get()).toEqual(old)
      expect(await env.db.drafts.list()).toEqual([draft])
    })

    it('another vault: a failed record write after the lock leaves it locked, old vault wiped', async () => {
      const { env, session, lockHook } = await unlockedEnv('ef'.repeat(32))
      vi.spyOn(env.db.device, 'put').mockRejectedValueOnce(new StorageUnavailableError())
      await expect(run(env)).rejects.toBeInstanceOf(StorageUnavailableError)
      onlySlotWrite(env.drive, FIXED_ID)
      expect(lockHook).toHaveBeenCalledTimes(1)
      expect(isUnlocked()).toBe(false)
      expect(await env.db.device.get()).toBeUndefined()
      expect(await readEnv().session()).not.toBe(session)
    })

    // An old-vault draft saved after the first check must not be wiped by the switch. It is saved
    // during the slot write: the longest window, while the app is still unlocked. A re-check moved
    // back above the slot write would miss it.
    it('another vault: a draft saved during the slot write is refused, not wiped', async () => {
      const { env, lockHook } = await unlockedEnv('ef'.repeat(32))
      const old = await env.db.device.get()
      const draft = { entryId: ENTRY_A, sealed: new Uint8Array([1, 2]), updatedAt: 1 }
      let saved = false
      env.drive.interceptors.push((req) => {
        if (req.method === 'POST' && !saved) {
          saved = true
          // The IndexedDB transaction is created now, so it commits before any later read.
          void env.db.drafts.put(draft)
        }
        return undefined
      })
      await expect(run(env)).rejects.toBeInstanceOf(DeviceRecordConflictError)
      onlySlotWrite(env.drive, FIXED_ID) // the documented orphan slot, nothing else
      expect(lockHook).toHaveBeenCalledTimes(1)
      expect(isUnlocked()).toBe(false)
      expect(await env.db.drafts.list()).toEqual([draft])
      expect(await env.db.device.get()).toEqual(old)
    })

    it('resetReadSession unregisters the old session lock hooks', async () => {
      const { session } = await unlockedEnv(vaultFingerprint())
      lock('manual')
      resetReadSession()
      await new Promise((resolve) => setTimeout(resolve, 0))
      setKeyRing(openRingForTest())
      session.vault.setOutboxIntents([intent(ENTRY_A)])
      lock('manual')
      // The old vault's hook no longer runs: its intents are not cleared by the second lock.
      expect(session.vault.getOutboxIntent(ENTRY_A)).toEqual(intent(ENTRY_A))
    })
  })

  it('probes IndexedDB before the cloud write: a storage failure leaves no orphan slot', async () => {
    const env = await setup()
    vi.spyOn(env.db.meta, 'put').mockRejectedValueOnce(new StorageUnavailableError())
    const before = snapshot(env.drive)
    await expect(run(env)).rejects.toBeInstanceOf(StorageUnavailableError)
    expectNothingWritten(env, before)
    await expectNoSideEffects(env)
  })

  it('a failed content cache write drops the stale cached copy; an absent file drops it too', async () => {
    const stale = {
      path: CONTENT,
      ciphertext: new TextEncoder().encode('stale'),
      etag: null,
      modifiedTime: null,
      lastAccess: 1,
      pinned: true,
    }
    const failing = await setup()
    await failing.db.files.put(stale)
    vi.spyOn(failing.db.files, 'put').mockImplementationOnce(async () => {
      throw new StorageUnavailableError()
    })
    await run(failing)
    expect(await failing.db.files.get(CONTENT)).toBeUndefined()

    const absent = await setup({ omit: (p) => p === CONTENT })
    await absent.db.files.put(stale)
    await run(absent)
    expect(await absent.db.files.get(CONTENT)).toBeUndefined()
  })

  it('does not reuse a stored id that the desktop or the web client would reject', async () => {
    const env = await setup()
    await env.db.device.put(storedRecord(vaultFingerprint(), 'web-1234')) // not hex: web rejects
    const result = await run(env)
    expect(result.deviceId).toBe(FIXED_ID)
    expect(result.reusedDeviceId).toBe(false)
  })

  it('refuses a generated id that fails either validator, before any write', async () => {
    const env = await setup()
    env.randomUUID.mockReturnValue('not/an/id')
    const before = snapshot(env.drive)
    await expect(run(env)).rejects.toBeInstanceOf(InvalidDeviceIdError)
    expectNothingWritten(env, before)
    await expectNoSideEffects(env)
  })

  it('isAcceptableDeviceId requires BOTH rules', () => {
    expect(isAcceptableDeviceId('9c5eba44-ed3f-4dae-a3c7-31c0d96792dd')).toBe(true)
    expect(isAcceptableDeviceId('abcd1234')).toBe(true)
    expect(isAcceptableDeviceId('abcd')).toBe(false) // web needs 8+
    expect(isAcceptableDeviceId('zzzzzzzz')).toBe(false) // not hex
    expect(isAcceptableDeviceId('-abcd1234')).toBe(false)
    expect(isAcceptableDeviceId('abcd/1234')).toBe(false)
    expect(isAcceptableDeviceId(`${'a'.repeat(65)}`)).toBe(false)
    expect(isAcceptableDeviceId(undefined)).toBe(false)
  })
})

describe('browserName', () => {
  it.each([
    [CHROME_UA, 'Chrome'],
    [`${CHROME_UA} Edg/126.0.0.0`, 'Edge'],
    [`${CHROME_UA} OPR/110.0.0.0`, 'Opera'],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0', 'Firefox'],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
      'Safari',
    ],
    ['curl/8.0', 'Browser'],
    ['', 'Browser'],
  ])('%s -> %s', (ua, name) => {
    expect(browserName(ua)).toBe(name)
  })
})

describe('validatePassphrase (onboard_validate_passphrase)', () => {
  it('accepts the right phrase: read-only, no control read, no key, no device record', async () => {
    const env = await setup()
    const before = snapshot(env.drive)
    await validatePassphrase(env.deps.reader, fixture.recovery_phrase, { core })
    expectNothingWritten(env, before)
    await expectNoSideEffects(env)
    const control = env.drive.find(['Memlore', ...CONTROL.split('/')])
    expect(env.drive.requests.some((r) => r.url.pathname.endsWith(`/${control?.id}`))).toBe(false)
  })

  it('maps wrong phrase, malformed phrase, foreign fingerprint and a missing recovery slot', async () => {
    const env = await setup()
    await expect(
      validatePassphrase(env.deps.reader, OTHER_PHRASE, { core }),
    ).rejects.toBeInstanceOf(WrongPhraseError)
    await expect(validatePassphrase(env.deps.reader, 'nope', { core })).rejects.toBeInstanceOf(
      InvalidPhraseError,
    )

    const foreign = await setup({
      overrides: { [META]: patched(META, (m) => (m.master_fingerprint = 'ab'.repeat(32))) },
    })
    await expect(
      validatePassphrase(foreign.deps.reader, fixture.recovery_phrase, { core }),
    ).rejects.toBeInstanceOf(FingerprintMismatchError)

    const missing = await setup({ omit: (p) => p === RECOVERY })
    await expect(
      validatePassphrase(missing.deps.reader, fixture.recovery_phrase, { core }),
    ).rejects.toBeInstanceOf(VaultCorruptError)
  })

  it('reports a wrong phrase before a missing _meta.json (desktop order: unwrap, then meta)', async () => {
    const env = await setup({ omit: (p) => p === META })
    await expect(
      validatePassphrase(env.deps.reader, OTHER_PHRASE, { core }),
    ).rejects.toBeInstanceOf(WrongPhraseError)
    await expect(
      validatePassphrase(env.deps.reader, fixture.recovery_phrase, { core }),
    ).rejects.toBeInstanceOf(VaultCorruptError)
  })
})
