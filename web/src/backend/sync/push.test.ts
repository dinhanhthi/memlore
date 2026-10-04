import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadCore, type Core } from '../../core/core'
import { resetClock } from '../clock'
import {
  DriveProtocolError,
  DriveReader,
  type DriveWriterDeps,
  type LockManagerLike,
} from '../drive/client'
import {
  FakeDrive,
  bytes,
  fakeLocks,
  fixtureBytes,
  loadDesktopFixture,
  seedFromFixture,
  text,
  violations,
  type DesktopFixture,
} from '../drive/fakeDrive'
import { createDraftManager, resetDraftsAutostartForTest, sha256Hex } from '../drafts'
import {
  VaultLockedError,
  configureKeysEnv,
  dispose,
  lock,
  setKeyRing,
  type KeyRing,
} from '../keys'
import { WRAPPED_MASTER_HEX_LEN, openWebDb, type WebDb } from '../storage/idb'
import { RecoveryFenceError, resumeWrites } from './fence'
import { resetFormatGuardLatch } from './formatGuard'
import { META_PATH, parseMetaText, readVersions } from './onboard'
import { packOutboxUploadIntents, type OutboxEntryV1, type OutboxMediaRef } from './outbox'
import { MissingVaultStateError, configurePushEnv, pushAll } from './push'
import { createOutboxWriter, type SafeUploadDeps } from './safeUpload'

const WEB_ID = 'cccccccc-1111-4222-8333-dddddddddddd'
const CONTROL = '.meta/control.json'
const RECOVERY = '.meta/keyring/_recovery.json'
const CONTENT = '.meta/keyring/_content.json'
const ENTRY_A = '00000000-0000-4000-8000-00000000000a'
const ENTRY_B = '00000000-0000-4000-8000-00000000000b'
const MEDIA_1 = '00000000-0000-4000-8000-000000000101'

let realCore: Core
let fixture: DesktopFixture

let core: Core
let ring: KeyRing
let drive: FakeDrive
let db: WebDb
let locks: ReturnType<typeof fakeLocks>
let reader: DriveReader
let driveDeps: DriveWriterDeps
let metaText: string
/** Runs before the push session's n-th lock request (1-based) is forwarded to `locks`. */
let beforeLockRequest: ((n: number) => Promise<void>) | null
let freshFlag: boolean
let cachedFlag: boolean
let unlocked: boolean

function intent(entryId: string, media: OutboxMediaRef[] = []): OutboxEntryV1 {
  return {
    schema_version: 1,
    entry_id: entryId,
    web_device_id: WEB_ID,
    created_on_web: true,
    web_updated_at_secs: 1_700_000_000,
    base_state_vector: [],
    yjs_full_state: [1, 2, 3],
    content_text: `text of ${entryId}`,
    preview_text: null,
    fields: {
      title: {
        value: 'Hello',
        base: '',
        base_updated_at: 0,
        change_seq: 1,
        changed_at_secs: 1_700_000_000,
      },
      entry_date: null,
      emotion: null,
      is_favorite: null,
      journal_id: null,
      tags_add: {},
      tags_remove: {},
    },
    media,
  }
}

async function putDraft(entry: OutboxEntryV1, updatedAt: number): Promise<Uint8Array> {
  const sealed = realCore.sealOutboxEntry(ring, JSON.stringify(entry))
  await db.drafts.put({ entryId: entry.entry_id, sealed, updatedAt })
  return sealed
}

async function putMedia(mediaId: string, withThumb: boolean): Promise<OutboxMediaRef> {
  const sealed = realCore.sealOutboxMedia(ring, new Uint8Array([1, 2, 3, 4]))
  await db.blobs.put({
    path: `outbox/m-${mediaId}`,
    bytes: sealed,
    size: sealed.length,
    lastAccess: 1,
  })
  if (withThumb) {
    const thumb = realCore.sealOutboxThumb(ring, new Uint8Array([9, 8]))
    await db.blobs.put({
      path: `outbox/m-${mediaId}.thumb`,
      bytes: thumb,
      size: thumb.length,
      lastAccess: 1,
    })
  }
  return {
    media_id: mediaId,
    file_name: 'a.jpg',
    file_type: 'image/jpeg',
    size: 4,
    has_thumb: withThumb,
  }
}

const outbox = (name: string) =>
  drive.find(['Memlore', 'generations', 'g-0', WEB_ID, 'outbox', name])

/** Names of the files created by multipart upload, in request order. */
function uploadedNames(): string[] {
  return drive
    .mutating()
    .filter((r) => r.method === 'POST' && r.url.pathname === '/upload/drive/v3/files')
    .map((r) => /"name":"([^"]+)"/.exec(Buffer.from(r.body ?? []).toString('latin1'))?.[1] ?? '')
}

const folderCreates = () =>
  drive.mutating().filter((r) => r.method === 'POST' && r.url.pathname === '/drive/v3/files')

/** The fixture vault's key ring, as an unlock would build it. */
function openRing(): KeyRing {
  const meta = JSON.parse(metaText) as { master_fingerprint: string }
  const recovery = JSON.parse(text(fixtureBytes(fixture, RECOVERY))) as { wrapped_master: string }
  const next = realCore.KeyRing.fromRecovery(
    fixture.recovery_phrase,
    recovery.wrapped_master,
    meta.master_fingerprint,
  )
  next.loadContentList(text(fixtureBytes(fixture, CONTENT)))
  return next
}

async function isPushed(entryId: string): Promise<boolean> {
  return typeof (await db.drafts.get(entryId))?.pushedHash === 'string'
}

beforeAll(async () => {
  realCore = await loadCore()
  fixture = loadDesktopFixture()
})

beforeEach(async () => {
  violations.length = 0
  configureKeysEnv({
    setTimeout: () => 0,
    clearTimeout: () => {},
    emit: () => {},
    document: null,
    window: null,
  })
  resetClock()
  resumeWrites()
  resetFormatGuardLatch()
  resetDraftsAutostartForTest()
  vi.spyOn(console, 'warn').mockImplementation(() => {})

  core = realCore
  drive = new FakeDrive()
  seedFromFixture(drive, fixture)
  locks = fakeLocks(drive)
  beforeLockRequest = null
  let lockRequests = 0
  const sessionLocks: LockManagerLike = {
    request: async (name, callback) => {
      lockRequests += 1
      await beforeLockRequest?.(lockRequests)
      return locks.request(name, callback)
    },
  }
  driveDeps = {
    getToken: async () => 'tok',
    fetchImpl: drive.fetch,
    sleep: async () => {},
    locks: sessionLocks,
  }
  reader = new DriveReader(driveDeps)
  db = await openWebDb({ factory: new IDBFactory() })

  metaText = text(fixtureBytes(fixture, META_PATH))
  const meta = JSON.parse(metaText) as { master_fingerprint: string }
  ring = openRing()
  setKeyRing(ring)

  await db.device.put({
    deviceId: WEB_ID,
    wrappedMasterHex: 'ab'.repeat(WRAPPED_MASTER_HEX_LEN / 2),
    kekSaltHex: 'cd'.repeat(16),
    recoveryGeneration: 0,
    masterFingerprint: meta.master_fingerprint,
    name: 'Memlore Web (Chrome)',
  })
  await db.files.put({
    path: META_PATH,
    ciphertext: bytes(metaText),
    etag: null,
    modifiedTime: null,
    lastAccess: 1,
    pinned: true,
  })

  freshFlag = true
  cachedFlag = true
  unlocked = true
  configurePushEnv({
    isUnlocked: () => unlocked,
    cachedWriteFlag: () => cachedFlag,
    deps: async () => ({
      db,
      reader,
      core,
      driveDeps,
      fetchWriteFlagImpl: async () => freshFlag,
    }),
  })
})

afterEach(() => {
  configurePushEnv({})
  dispose()
  vi.restoreAllMocks()
  expect(violations).toEqual([])
})

describe('pushAll', () => {
  it('uploads an unpushed draft to its outbox path and marks it pushed', async () => {
    const sealed = await putDraft(intent(ENTRY_A), 1)

    const result = await pushAll()

    expect(result).toEqual({ pushed: 1, skipped: 0, pending: 0 })
    expect(outbox(`${ENTRY_A}.bin`)?.content).toEqual(sealed)
    expect(await isPushed(ENTRY_A)).toBe(true)
    expect(await db.drafts.get(ENTRY_A)).toBeDefined()
  })

  it('uploads media and thumbnail before the entry .bin', async () => {
    const ref = await putMedia(MEDIA_1, true)
    await putDraft(intent(ENTRY_A, [ref]), 1)

    const result = await pushAll()

    expect(result.pushed).toBe(1)
    expect(uploadedNames()).toEqual([`m-${MEDIA_1}`, `m-${MEDIA_1}.thumb`, `${ENTRY_A}.bin`])
  })

  it('creates the outbox folder once per session', async () => {
    await putDraft(intent(ENTRY_A), 1)
    await pushAll()
    await putDraft(intent(ENTRY_B), 2)
    const entersBefore = locks.events.filter((e) => e.startsWith('enter')).length

    await pushAll()

    // Two folders (<webId>, outbox), created by the first run only.
    expect(folderCreates()).toHaveLength(2)
    // The second run takes the lock for its one batch only, not for a folder check.
    expect(locks.events.filter((e) => e.startsWith('enter')).length - entersBefore).toBe(1)
    expect(await isPushed(ENTRY_B)).toBe(true)
  })

  it('does not touch Drive while the cached write flag is off', async () => {
    cachedFlag = false
    await putDraft(intent(ENTRY_A), 1)

    const result = await pushAll()

    expect(result).toEqual({ pushed: 0, skipped: 0, pending: 1 })
    expect(drive.requests).toEqual([])
    expect(await isPushed(ENTRY_A)).toBe(false)
  })

  it('writes nothing when the fresh write flag is off', async () => {
    freshFlag = false
    await putDraft(intent(ENTRY_A), 1)

    const result = await pushAll()

    expect(result.error).toBeInstanceOf(Error)
    expect(result.pending).toBe(1)
    expect(drive.mutating()).toEqual([])
    expect(await isPushed(ENTRY_A)).toBe(false)
  })

  it('stops on a recovery fence refusal and keeps every draft unpushed', async () => {
    const control = drive.find(['Memlore', ...CONTROL.split('/')])
    const value = JSON.parse(text(control?.content ?? new Uint8Array())) as Record<string, unknown>
    value.recovery_lease = {
      version: 1,
      job_id: 1,
      owner_device_id: 'aaaaaaaa-bbbb',
      operation: 'cloud_cleanup',
      recovery_generation: 0,
      nonce: 'abcdef0123456789',
      created_at: 1,
      updated_at: 1,
    }
    if (control) control.content = bytes(JSON.stringify(value))
    await putDraft(intent(ENTRY_A), 1)
    await putDraft(intent(ENTRY_B), 2)

    const result = await pushAll()

    expect(result.error).toBeInstanceOf(RecoveryFenceError)
    expect(result).toMatchObject({ pushed: 0, pending: 2 })
    expect(drive.mutating()).toEqual([])
    expect(await isPushed(ENTRY_A)).toBe(false)
    expect(await isPushed(ENTRY_B)).toBe(false)
  })

  it('stops with the error when an update has no ETag, keeping the draft unpushed', async () => {
    const outboxId = drive.chain('Memlore', 'generations', 'g-0', WEB_ID, 'outbox')
    drive.addFile(`${ENTRY_A}.bin`, outboxId, 'old')
    drive.omitEtag = true
    await putDraft(intent(ENTRY_A), 1)
    await putDraft(intent(ENTRY_B), 2)

    const result = await pushAll()

    expect(result.error).toBeInstanceOf(DriveProtocolError)
    expect(result).toMatchObject({ pushed: 0, pending: 2 })
    expect(text(outbox(`${ENTRY_A}.bin`)?.content ?? new Uint8Array())).toBe('old')
    expect(outbox(`${ENTRY_B}.bin`)).toBeUndefined()
    expect(await isPushed(ENTRY_A)).toBe(false)
  })

  it('skips only the draft whose seal-then-verify fails; the others still push', async () => {
    const badSealed = await putDraft(intent(ENTRY_A), 1)
    await putDraft(intent(ENTRY_B), 2)
    // The second open of A (safeUpload's verify, after push.ts's own open) sees other content.
    let opensOfA = 0
    core = {
      ...realCore,
      openOutboxEntry: (r: KeyRing, sealed: Uint8Array) => {
        const json = realCore.openOutboxEntry(r, sealed)
        if (sealed.length === badSealed.length && sealed.every((b, i) => b === badSealed[i])) {
          opensOfA += 1
          if (opensOfA === 2) return json.replace('Hello', 'Tampered')
        }
        return json
      },
    }

    const result = await pushAll()

    expect(result).toEqual({ pushed: 1, skipped: 1, pending: 1 })
    expect(outbox(`${ENTRY_A}.bin`)).toBeUndefined()
    expect(await isPushed(ENTRY_A)).toBe(false)
    expect(await isPushed(ENTRY_B)).toBe(true)
  })

  it('skips an entry whose outbox media is missing, and never deletes it', async () => {
    const missing: OutboxMediaRef = {
      media_id: MEDIA_1,
      file_name: 'a.jpg',
      file_type: 'image/jpeg',
      size: 4,
      has_thumb: false,
    }
    await putDraft(intent(ENTRY_A, [missing]), 1)
    await putDraft(intent(ENTRY_B), 2)

    const result = await pushAll()

    expect(result).toEqual({ pushed: 1, skipped: 1, pending: 1 })
    expect(outbox(`${ENTRY_A}.bin`)).toBeUndefined()
    expect(await db.drafts.get(ENTRY_A)).toBeDefined()
    expect(await isPushed(ENTRY_B)).toBe(true)
  })

  it('refuses with a re-onboard error and writes nothing when the cached _meta.json is missing', async () => {
    await db.files.delete(META_PATH)
    await putDraft(intent(ENTRY_A), 1)

    const result = await pushAll()

    expect(result.error).toBeInstanceOf(MissingVaultStateError)
    expect(String((result.error as Error).message)).toMatch(/re-onboard/i)
    expect(drive.requests).toEqual([])
    expect(await isPushed(ENTRY_A)).toBe(false)
  })

  it('is a no-op that never touches Drive while locked', async () => {
    await putDraft(intent(ENTRY_A), 1)
    lock('manual')
    unlocked = false

    const result = await pushAll()

    expect(result).toEqual({ pushed: 0, skipped: 0, pending: 0 })
    expect(drive.requests).toEqual([])
    expect(await isPushed(ENTRY_A)).toBe(false)
  })

  // With a re-unlock, a ring is installed again: only the run's epoch can stop it.
  it.each([
    ['a lock', false],
    ['a lock and re-unlock', true],
  ])(
    '%s between two drafts stops the run: nothing more is written or marked',
    async (_, reunlock) => {
      await putDraft(intent(ENTRY_A), 1)
      await putDraft(intent(ENTRY_B), 2)
      let writesAtLock = -1
      let marksAfterLock = 0
      const markPushed = db.drafts.markPushed
      vi.spyOn(db.drafts, 'markPushed').mockImplementation(async (...args) => {
        if (writesAtLock >= 0) marksAfterLock += 1
        const marked = await markPushed(...args)
        if (args[0] === ENTRY_A) {
          expect(outbox(`${ENTRY_A}.bin`)).toBeDefined()
          writesAtLock = drive.mutating().length
          lock('manual')
          unlocked = false
          if (reunlock) {
            ring = openRing()
            setKeyRing(ring)
            unlocked = true
          }
        }
        return marked
      })

      const result = await pushAll()

      expect(result.error).toBeInstanceOf(VaultLockedError)
      expect(result).toMatchObject({ pushed: 1, skipped: 0, pending: 1 })
      expect(drive.mutating()).toHaveLength(writesAtLock)
      expect(outbox(`${ENTRY_B}.bin`)).toBeUndefined()
      expect(marksAfterLock).toBe(0)
      expect(await isPushed(ENTRY_A)).toBe(true)
      expect(await isPushed(ENTRY_B)).toBe(false)
    },
  )

  it('is single-flight: calls during a run share one follow-up run that sees the new save', async () => {
    await putDraft(intent(ENTRY_A), 1)

    const first = pushAll()
    await putDraft(intent(ENTRY_B), 2)
    const second = pushAll()
    const third = pushAll()

    expect(second).toBe(third)
    const [r1, r2] = await Promise.all([first, second])
    // B was saved during the first run: whichever run saw it, it is pushed exactly once.
    expect(r1.pushed + r2.pushed).toBe(2)
    expect(r2.pending).toBe(0)
    expect(locks.maxActive).toBe(1)
    expect(uploadedNames().sort()).toEqual([`${ENTRY_A}.bin`, `${ENTRY_B}.bin`])
  })

  it('skips an entry another tab re-saved and pushed while this run waited on the lock', async () => {
    const older = intent(ENTRY_A)
    const sealedX = await putDraft(older, 1)
    await putDraft(intent(ENTRY_B), 2)
    const newer = intent(ENTRY_A)
    newer.content_text = 'the newer edit'
    const sealedY = realCore.sealOutboxEntry(ring, JSON.stringify(newer))

    // Tab A: saves Y, then pushes it through its own DraftManager and the same serializing lock.
    const tabA = async (): Promise<void> => {
      const manager = createDraftManager({ db })
      await manager.saveDraft(ENTRY_A, sealedY)
      const meta = parseMetaText(realCore, readVersions(realCore), metaText)
      const deps: SafeUploadDeps = {
        writer: createOutboxWriter(reader, driveDeps, { ownId: WEB_ID, localGen: 0 }),
        reader,
        core: realCore,
        ring,
        localGen: 0,
        ownDeviceId: WEB_ID,
        expectedFence: {
          recoveryGeneration: meta.recoveryGeneration,
          masterFingerprint: meta.masterFingerprint,
          epoch: meta.epoch,
          contentEpoch: meta.contentEpoch,
        },
        fetchWriteFlagImpl: async () => true,
        locks,
      }
      const intents = packOutboxUploadIntents({
        localGen: 0,
        ownDeviceId: WEB_ID,
        entry: newer,
        sealedEntryBytes: sealedY,
        sealedMediaMap: new Map(),
        plainMediaMap: new Map(),
        sealedThumbMap: new Map(),
        plainThumbMap: new Map(),
      })
      await manager.flush(ENTRY_A, intents, deps, sealedY)
    }
    // Run B: request 1 is the folder, request 2 is A's batch, already packed from X.
    beforeLockRequest = async (n) => {
      if (n !== 2) return
      expect(drive.mutating()).toHaveLength(2)
      expect(outbox(`${ENTRY_A}.bin`)).toBeUndefined()
      expect((await db.drafts.get(ENTRY_A))?.sealed).toEqual(sealedX)
      await tabA()
    }

    const result = await pushAll()

    expect(result).toEqual({ pushed: 1, skipped: 1, pending: 0 })
    expect(outbox(`${ENTRY_A}.bin`)?.content).toEqual(sealedY)
    // Run B wrote nothing for A: the only write to A.bin is tab A's create.
    const writesOfA = drive.mutating().filter((r) =>
      Buffer.from(r.body ?? [])
        .toString('latin1')
        .includes(`${ENTRY_A}.bin`),
    )
    expect(writesOfA).toHaveLength(1)
    expect(drive.mutating().filter((r) => r.method === 'PATCH')).toEqual([])
    expect((await db.drafts.get(ENTRY_A))?.pushedHash).toBe(await sha256Hex(sealedY))
    expect(await isPushed(ENTRY_B)).toBe(true)
    expect(locks.maxActive).toBe(1)
  })
})
