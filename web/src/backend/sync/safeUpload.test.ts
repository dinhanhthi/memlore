import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadCore, type Core } from '../../core/core'
import type { KeyRing } from '../keys'
import {
  ClockSkewError,
  resetClock,
  updateClockOffset,
} from '../clock'
import {
  DriveReader,
  DriveWriter,
  LockUnavailableError,
  type DriveWriterDeps,
  type LockManagerLike,
} from '../drive/client'
import {
  FakeDrive,
  fixtureBytes,
  loadDesktopFixture,
  seedFromFixture,
} from '../drive/fakeDrive'
import {
  ROOT_FOLDER_NAME,
  outboxEntryPath,
  outboxMediaPath,
} from '../drive/paths'
import { resumeWrites } from './fence'
import { latchFormatGuard, resetFormatGuardLatch } from './formatGuard'
import {
  safeUpload,
  type SafeUploadIntent,
  type SafeUploadDeps,
} from './safeUpload'

const WEB_DEVICE_ID = '00000000-0000-0000-0000-000000000002'
const DESKTOP_DEVICE_ID = '00000000-0000-0000-0000-000000000001'

describe('safeUpload: the only write path', () => {
  let core: Core
  let ring: KeyRing
  let drive: FakeDrive
  let reader: DriveReader
  let writer: DriveWriter
  let lockManager: LockManagerLike
  let writeFlag: boolean

  const localGen = 0

  beforeEach(async () => {
    resetClock()
    resumeWrites()
    resetFormatGuardLatch()
    writeFlag = true

    core = await loadCore()

    // Build a mock lock manager that enforces non-reentrancy
    let lockHeld = false
    lockManager = {
      request: vi.fn(async (_name, cb) => {
        if (lockHeld) {
          throw new Error('Lock deadlock: non-reentrant lock requested while already held')
        }
        lockHeld = true
        try {
          return await cb()
        } finally {
          lockHeld = false
        }
      }),
    }

    const fixture = loadDesktopFixture()
    const metaJson = JSON.parse(
      new TextDecoder().decode(fixtureBytes(fixture, '.meta/keyring/_meta.json')),
    ) as { master_fingerprint: string }
    const recoveryJson = JSON.parse(
      new TextDecoder().decode(fixtureBytes(fixture, '.meta/keyring/_recovery.json')),
    ) as { wrapped_master: string }
    const contentList = new TextDecoder().decode(
      fixtureBytes(fixture, '.meta/keyring/_content.json'),
    )

    drive = new FakeDrive()
    seedFromFixture(drive, fixture)
    drive.chain(ROOT_FOLDER_NAME, 'generations', 'g-0', WEB_DEVICE_ID, 'outbox')

    ring = core.KeyRing.fromRecovery(
      fixture.recovery_phrase,
      recoveryJson.wrapped_master,
      metaJson.master_fingerprint,
    )
    ring.loadContentList(contentList)

    reader = new DriveReader({
      getToken: async () => 'test-token',
      fetchImpl: drive.fetch,
    })

    const writerDeps: DriveWriterDeps = {
      getToken: async () => 'test-token',
      fetchImpl: drive.fetch,
      locks: lockManager,
    }
    writer = new DriveWriter(reader, writerDeps)
    writer.setIdentity({ ownId: WEB_DEVICE_ID, localGen })
  })

  function makeDeps(overrides: Partial<SafeUploadDeps> = {}): SafeUploadDeps {
    const fixture = loadDesktopFixture()
    const metaJson = JSON.parse(
      new TextDecoder().decode(fixtureBytes(fixture, '.meta/keyring/_meta.json')),
    ) as { master_fingerprint: string }
    return {
      writer,
      reader,
      core,
      ring,
      localGen,
      ownDeviceId: WEB_DEVICE_ID,
      expectedFence: {
        recoveryGeneration: 0,
        masterFingerprint: metaJson.master_fingerprint,
        epoch: 1,
        contentEpoch: 1,
      },
      fetchWriteFlagImpl: async () => writeFlag,
      locks: lockManager,
      ...overrides,
    }
  }

  it('uploads a verified outbox entry and media intent under writer lock', async () => {
    const entryId = '00000000-0000-0000-0000-000000000010'
    const entryObj = {
      schema_version: 1,
      entry_id: entryId,
      web_device_id: WEB_DEVICE_ID,
      created_on_web: true,
      web_updated_at_secs: 1700000000,
      base_state_vector: [],
      yjs_full_state: [1, 2, 3],
      content_text: 'Hello world',
      preview_text: 'Hello',
      fields: {
        title: {
          value: 'Hello',
          base: '',
          base_updated_at: 0,
          change_seq: 1,
          changed_at_secs: 1700000000,
        },
        entry_date: null,
        emotion: null,
        is_favorite: null,
        journal_id: null,
        tags_add: {},
        tags_remove: {},
      },
      media: [],
    }

    const entryBytes = core.sealOutboxEntry(ring, JSON.stringify(entryObj))
    const entryPath = outboxEntryPath(WEB_DEVICE_ID, localGen, entryId)

    const mediaId = '00000000-0000-0000-0000-000000000020'
    const mediaPlain = new Uint8Array([10, 20, 30, 40])
    const mediaBytes = core.sealOutboxMedia(ring, mediaPlain)
    const mediaPath = outboxMediaPath(WEB_DEVICE_ID, localGen, mediaId, false)

    const intents: SafeUploadIntent[] = [
      {
        path: entryPath,
        bytes: entryBytes,
        intended: { kind: 'entry', entry: entryObj },
      },
      {
        path: mediaPath,
        bytes: mediaBytes,
        intended: { kind: 'media', plaintext: mediaPlain },
      },
    ]

    const results = await safeUpload(intents, makeDeps())
    expect(results).toHaveLength(2)
    expect(lockManager.request).toHaveBeenCalled()

    // Verify mutating calls reached the fake drive
    const putCalls = drive.mutating()
    expect(putCalls.length).toBeGreaterThanOrEqual(2)
  })

  it('rejects upload when seal-then-verify detects a 1-bit corruption in entry bytes', async () => {
    const entryId = '00000000-0000-0000-0000-000000000011'
    const entryObj = {
      schema_version: 1,
      entry_id: entryId,
      web_device_id: WEB_DEVICE_ID,
      created_on_web: true,
      web_updated_at_secs: 1700000000,
      base_state_vector: [],
      yjs_full_state: [],
      content_text: 'Safe text',
      preview_text: 'Safe',
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
    }

    const validBytes = core.sealOutboxEntry(ring, JSON.stringify(entryObj))
    const corruptBytes = new Uint8Array(validBytes)
    corruptBytes[validBytes.length - 1] ^= 0x01 // flip 1 bit in tag

    const intents: SafeUploadIntent[] = [
      {
        path: outboxEntryPath(WEB_DEVICE_ID, localGen, entryId),
        bytes: corruptBytes,
        intended: { kind: 'entry', entry: entryObj },
      },
    ]

    const mutatingBefore = drive.mutating().length
    await expect(safeUpload(intents, makeDeps())).rejects.toThrow(/seal.*verify/i)
    expect(drive.mutating().length).toBe(mutatingBefore)
  })

  it('stops the second batch when write flag flips OFF between batches', async () => {
    const entryId = '00000000-0000-0000-0000-000000000012'
    const entryObj = {
      schema_version: 1,
      entry_id: entryId,
      web_device_id: WEB_DEVICE_ID,
      created_on_web: true,
      web_updated_at_secs: 1700000000,
      base_state_vector: [],
      yjs_full_state: [],
      content_text: 'Text',
      preview_text: 'Text',
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
    }
    const entryBytes = core.sealOutboxEntry(ring, JSON.stringify(entryObj))
    const intents: SafeUploadIntent[] = [
      {
        path: outboxEntryPath(WEB_DEVICE_ID, localGen, entryId),
        bytes: entryBytes,
        intended: { kind: 'entry', entry: entryObj },
      },
    ]

    // Batch 1 succeeds
    await expect(safeUpload(intents, makeDeps())).resolves.toBeDefined()

    // Flip flag off
    writeFlag = false

    // Batch 2 must fail closed
    const mutatingCount = drive.mutating().length
    await expect(safeUpload(intents, makeDeps())).rejects.toThrow(/writes disabled/i)
    expect(drive.mutating().length).toBe(mutatingCount)
  })

  it('blocks upload when browser clock is skewed > 120s', async () => {
    const entryId = '00000000-0000-0000-0000-000000000013'
    const entryObj = {
      schema_version: 1,
      entry_id: entryId,
      web_device_id: WEB_DEVICE_ID,
      created_on_web: true,
      web_updated_at_secs: 1700000000,
      base_state_vector: [],
      yjs_full_state: [],
      content_text: 'Clock test',
      preview_text: 'Clock',
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
    }
    const entryBytes = core.sealOutboxEntry(ring, JSON.stringify(entryObj))
    const intents: SafeUploadIntent[] = [
      {
        path: outboxEntryPath(WEB_DEVICE_ID, localGen, entryId),
        bytes: entryBytes,
        intended: { kind: 'entry', entry: entryObj },
      },
    ]

    // Simulate clock skew: 150 seconds skew
    const clientNow = 1775000000000
    updateClockOffset(new Date(clientNow + 150000).toUTCString(), clientNow)

    const mutatingCount = drive.mutating().length
    await expect(safeUpload(intents, makeDeps())).rejects.toThrow(ClockSkewError)
    expect(drive.mutating().length).toBe(mutatingCount)
  })

  it('throws and performs zero writes when target path is not in outbox', async () => {
    const badPaths = [
      `.meta/control.json`,
      `.meta/keyring/_meta.json`,
      `generations/g-0/${DESKTOP_DEVICE_ID}/outbox/00000000-0000-0000-0000-000000000010.bin`,
      `generations/g-0/${WEB_DEVICE_ID}/metadata.json`,
      `generations/g-1/${WEB_DEVICE_ID}/outbox/00000000-0000-0000-0000-000000000010.bin`,
    ]

    for (const badPath of badPaths) {
      const intents: SafeUploadIntent[] = [
        {
          path: badPath,
          bytes: new Uint8Array([1, 2, 3]),
          intended: { kind: 'media', plaintext: new Uint8Array([1, 2, 3]) },
        },
      ]

      const mutatingCount = drive.mutating().length
      await expect(safeUpload(intents, makeDeps())).rejects.toThrow(/outbox allowlist/i)
      expect(drive.mutating().length).toBe(mutatingCount)
    }
  })

  it('blocks upload when recovery fence refuses due to active recovery lease', async () => {
    // Put an active lease in control.json
    const ctrl = drive.find([ROOT_FOLDER_NAME, '.meta', 'control.json'])!
    ctrl.content = new TextEncoder().encode(
      JSON.stringify({
        version: 1,
        recovery_generation: 1,
        recovery_lease: {
          version: 1,
          job_id: 1,
          owner_device_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
          operation: 'local_to_cloud',
          recovery_generation: 1,
          nonce: '0123456789abcdef0123456789abcdef',
          created_at: 1000,
          updated_at: 2000,
        },
        updated_at: 2000,
      }),
    )
    ctrl.version++

    const intents: SafeUploadIntent[] = [
      {
        path: outboxEntryPath(WEB_DEVICE_ID, localGen, '00000000-0000-0000-0000-000000000010'),
        bytes: new Uint8Array([1, 2, 3]),
        intended: { kind: 'media', plaintext: new Uint8Array([1, 2, 3]) },
      },
    ]

    await expect(safeUpload(intents, makeDeps())).rejects.toThrow(/recovery/i)
  })

  it('fails closed when navigator.locks is unavailable', async () => {
    const intents: SafeUploadIntent[] = []
    await expect(
      safeUpload(intents, makeDeps({ locks: null })),
    ).rejects.toThrow(LockUnavailableError)
  })

  it('blocks upload when format guard is latched', async () => {
    latchFormatGuard('some/path', 'unknown format')
    const intents: SafeUploadIntent[] = []
    await expect(safeUpload(intents, makeDeps())).rejects.toThrow(/format guard/i)
  })
})
