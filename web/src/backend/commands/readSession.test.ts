import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Core } from '../../core/core'
import { setWriteFlagForTest } from '../config'
import { VaultLockedError } from '../keys'
import { WRAPPED_MASTER_HEX_LEN, openWebDb, type WebDb } from '../storage/idb'
import { createEmptyOutboxFields, type OutboxEntryV1 } from '../sync/outbox'
import { entryHandlers } from './entries'
import { configureReadEnv, createReadSession, type ReadSession } from './readSession'
import { sha256Hex } from '../drafts'
import type { RetentionDesktops } from '../sync/retention'
import { FakeVault } from './readTestKit'

const fakes = vi.hoisted(() => ({
  hooks: [] as Array<() => void>,
  puller: null as unknown,
  vault: null as unknown,
}))

vi.mock('../keys', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../keys')>()),
  onLock: (cb: () => void) => {
    fakes.hooks.push(cb)
    return () => undefined
  },
  getKeyRing: () => ({}),
}))
vi.mock('../sync/pull', () => ({ createPuller: () => fakes.puller }))
vi.mock('../vault', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../vault')>()),
  createVault: () => fakes.vault,
}))

class Gate {
  readonly promise: Promise<void>
  open!: () => void
  constructor() {
    this.promise = new Promise<void>((resolve) => {
      this.open = resolve
    })
  }
}

const enc = new TextEncoder()
const journalFile = JSON.stringify({
  journal_id: 'j1',
  name: 'J',
  updated_at: 5,
  is_locked: true,
})

interface Rig {
  session: ReadSession
  pathsGate: { current: Gate | null }
  warmGate: { current: Gate | null }
  paths: ReturnType<typeof vi.fn>
  warmStart: ReturnType<typeof vi.fn>
  setExcluded: ReturnType<typeof vi.fn>
  lock: () => void
}

async function rig(): Promise<Rig> {
  const pathsGate: Rig['pathsGate'] = { current: null }
  const warmGate: Rig['warmGate'] = { current: null }
  const paths = vi.fn(async () => {
    await pathsGate.current?.promise
    return ['devA/journals/j1.bin']
  })
  const warmStart = vi.fn(async () => {
    await warmGate.current?.promise
    return [] as string[]
  })
  const setExcluded = vi.fn()
  const index = new Map([
    ['e1', { entryId: 'e1', authorDevice: 'devA', updatedAt: 1, isDeleted: false }],
  ])
  fakes.puller = { index, refresh: async () => ({}), warmStart, foreignIntents: [] }
  fakes.vault = {
    setExcludedJournalIds: setExcluded,
    load: async () => ({}),
    status: () => 'not-loaded',
  }
  const db = {
    files: { paths, get: async () => ({ ciphertext: enc.encode(journalFile) }) },
    meta: { listByPrefix: async () => [], put: async () => undefined },
    drafts: { list: async () => [] },
  } as unknown as WebDb
  const core = { openDeviceBin: (_r: unknown, b: Uint8Array) => b } as unknown as Core
  const session = await createReadSession({ db, reader: {} as never, core })
  return {
    session,
    pathsGate,
    warmGate,
    paths,
    warmStart,
    setExcluded,
    lock: () => {
      for (const hook of [...fakes.hooks]) hook()
    },
  }
}

beforeEach(() => {
  fakes.hooks.length = 0
})
afterEach(() => {
  fakes.hooks.length = 0
})

describe('read session and lock races', () => {
  it('a lock during an in-flight taxonomy read repopulates nothing; the next unlock recomputes', async () => {
    const r = await rig()
    r.pathsGate.current = new Gate()
    const pending = r.session.ready()
    const outcome = expect(pending).rejects.toBeInstanceOf(VaultLockedError)
    await Promise.resolve()
    r.lock()
    r.pathsGate.current.open()
    await outcome
    expect(r.setExcluded).not.toHaveBeenCalled()
    expect(r.warmStart).not.toHaveBeenCalled()

    r.pathsGate.current = null
    const taxonomy = await r.session.ready()
    expect(taxonomy.excludedJournalIds).toEqual(['j1'])
    expect(r.paths).toHaveBeenCalledTimes(2)
    expect(r.setExcluded).toHaveBeenCalledTimes(1)
    expect(r.warmStart).toHaveBeenCalledTimes(1)
  })

  it('a lock during the warm start leaves no warm state behind', async () => {
    const r = await rig()
    r.warmGate.current = new Gate()
    const pending = r.session.ready()
    const outcome = expect(pending).rejects.toBeInstanceOf(VaultLockedError)
    for (let i = 0; i < 20; i++) await Promise.resolve()
    expect(r.warmStart).toHaveBeenCalledTimes(1)
    r.lock()
    r.warmGate.current.open()
    await outcome

    r.warmGate.current = null
    await r.session.ready()
    expect(r.warmStart).toHaveBeenCalledTimes(2)
  })

  it('a lock during pull rejects it instead of reporting stale results', async () => {
    const r = await rig()
    await r.session.ready()
    r.pathsGate.current = new Gate()
    const puller = fakes.puller as { index: Map<string, unknown>; refresh: () => Promise<unknown> }
    puller.refresh = async () => {
      puller.index = new Map(puller.index) // a new index: the taxonomy cache is invalid
      return { stale: [] }
    }
    const pending = r.session.pull()
    const outcome = expect(pending).rejects.toBeInstanceOf(VaultLockedError)
    for (let i = 0; i < 20; i++) await Promise.resolve()
    r.lock()
    r.pathsGate.current.open()
    await outcome
  })
})

describe('drafts rehydrate the outbox overlay', () => {
  const dec = new TextDecoder()

  const intent = (over: Partial<OutboxEntryV1> = {}): OutboxEntryV1 => ({
    schema_version: 1,
    entry_id: 'e1',
    web_device_id: 'web-1234',
    created_on_web: false,
    web_updated_at_secs: 100,
    base_state_vector: [],
    yjs_full_state: [],
    content_text: null,
    preview_text: null,
    fields: {
      ...createEmptyOutboxFields(),
      title: {
        value: 'Web title',
        base: 'Title e1',
        base_updated_at: 1,
        change_seq: 1,
        changed_at_secs: 100,
      },
    },
    media: [],
    ...over,
  })

  async function hydrationRig(
    drafts: Array<{ entryId: string; sealed: Uint8Array; pushedHash?: string }>,
    desktops: RetentionDesktops = { manifests: [], slots: null, tombstones: new Set() },
  ) {
    const vault = Object.assign(new FakeVault([{ id: 'e1', updatedAt: 1 }]), {
      setExcludedJournalIds: vi.fn(),
    })
    fakes.vault = vault
    fakes.puller = {
      index: new Map(),
      refresh: async () => ({ stale: [] }),
      warmStart: async () => [] as string[],
      getDegradedDevices: () => [],
      desktops,
      foreignIntents: [],
    }
    const db = await openWebDb({ factory: new IDBFactory() })
    await db.device.put({
      deviceId: 'web-1234',
      wrappedMasterHex: 'ab'.repeat(WRAPPED_MASTER_HEX_LEN / 2),
      kekSaltHex: 'cd'.repeat(16),
      recoveryGeneration: 1,
      masterFingerprint: 'fp-1',
      name: 'Memlore Web',
      nextChangeSeq: 2,
    })
    for (const d of drafts) await db.drafts.put({ ...d, updatedAt: 1 })
    const openOutboxEntry = vi.fn((_ring: unknown, bytes: Uint8Array) => {
      if (bytes[0] !== 0x7b) throw new Error('aead: tag mismatch')
      return dec.decode(bytes)
    })
    const core = {
      openDeviceBin: (_r: unknown, b: Uint8Array) => b,
      openOutboxEntry,
      openOutboxAcks: (_r: unknown, b: Uint8Array) => dec.decode(b),
      sealOutboxEntry: (_r: unknown, json: string) => enc.encode(json),
    } as unknown as Core
    const session = await createReadSession({ db, reader: {} as never, core })
    return { vault, db, session, openOutboxEntry }
  }

  afterEach(() => {
    configureReadEnv({})
    setWriteFlagForTest(false)
    vi.restoreAllMocks()
  })

  it('exposes every sealed draft through the overlay once ready() resolves', async () => {
    const r = await hydrationRig([{ entryId: 'e1', sealed: enc.encode(JSON.stringify(intent())) }])
    expect(r.vault.getOutboxIntent('e1')).toBeUndefined()

    await r.session.ready()

    expect(r.vault.getOutboxIntent('e1')).toEqual(intent())
    await r.session.ready()
    expect(r.openOutboxEntry).toHaveBeenCalledTimes(1) // once per unlock
  })

  it('a second edit after a reload accumulates on top of the hydrated intent', async () => {
    const r = await hydrationRig([{ entryId: 'e1', sealed: enc.encode(JSON.stringify(intent())) }])
    configureReadEnv({ isUnlocked: () => true, session: async () => r.session })
    setWriteFlagForTest(true)

    await entryHandlers.toggle_favorite({ id: 'e1' })

    const next = r.vault.getOutboxIntent('e1')
    expect(next?.fields.title?.value).toBe('Web title')
    expect(next?.fields.is_favorite?.value).toBe(true)
    const stored = await r.db.drafts.get('e1')
    const persisted = JSON.parse(dec.decode(stored?.sealed)) as OutboxEntryV1
    expect(persisted.fields.title?.value).toBe('Web title')
  })

  it('skips and keeps a draft that fails to open', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const corrupt = new Uint8Array([0, 1, 2])
    const r = await hydrationRig([
      { entryId: 'bad', sealed: corrupt },
      { entryId: 'e1', sealed: enc.encode(JSON.stringify(intent())) },
    ])

    await r.session.ready()

    expect(r.vault.getOutboxIntent('bad')).toBeUndefined()
    expect(r.vault.getOutboxIntent('e1')).toEqual(intent())
    expect((await r.db.drafts.get('bad'))?.sealed).toEqual(corrupt)
    expect(warn).toHaveBeenCalled()
    // Only strings: an error object (e.g. a JSON.parse SyntaxError) can quote decrypted text.
    expect(warn.mock.calls.flat().every((arg) => typeof arg === 'string')).toBe(true)
  })

  it('a lock during hydration discards the result; the next unlock hydrates again', async () => {
    const r = await hydrationRig([{ entryId: 'e1', sealed: enc.encode(JSON.stringify(intent())) }])
    const gate = new Gate()
    const list = r.db.drafts.list
    r.db.drafts.list = async () => {
      await gate.promise
      return list()
    }
    const pending = r.session.ready()
    const outcome = expect(pending).rejects.toBeInstanceOf(VaultLockedError)
    for (let i = 0; i < 20; i++) await Promise.resolve()
    for (const hook of [...fakes.hooks]) hook()
    gate.open()
    await outcome
    expect(r.vault.getOutboxIntent('e1')).toBeUndefined()

    await r.session.ready()
    expect(r.vault.getOutboxIntent('e1')).toEqual(intent())
  })

  it('keeps an intent a write already set over the hydrated one', async () => {
    const r = await hydrationRig([{ entryId: 'e1', sealed: enc.encode(JSON.stringify(intent())) }])
    const newer = intent({ web_updated_at_secs: 200 })
    r.vault.setOutboxIntents([newer])

    await r.session.ready()

    expect(r.vault.getOutboxIntent('e1')).toEqual(newer)
  })

  describe('intent retention', () => {
    const pushedDraft = async (i: OutboxEntryV1) => {
      const sealed = enc.encode(JSON.stringify(i))
      return { entryId: i.entry_id, sealed, pushedHash: await sha256Hex(sealed) }
    }

    it('runs once the drafts hydrate: a pushed draft of a tombstoned entry is dropped', async () => {
      const r = await hydrationRig([await pushedDraft(intent())], {
        manifests: ['desk-a'],
        slots: new Set(['desk-a']),
        tombstones: new Set(['e1']),
      })
      await r.session.ready()
      expect(r.vault.getOutboxIntent('e1')).toBeUndefined()
      expect(await r.db.drafts.get('e1')).toBeUndefined()
    })

    it('a resolved field leaves the overlay at once and the stored draft at the next rewrite', async () => {
      const draft = { entryId: 'e1', sealed: enc.encode(JSON.stringify(intent())) } // unpushed
      const r = await hydrationRig([draft], {
        manifests: ['desk-a'],
        slots: new Set(['desk-a']),
        tombstones: new Set(),
      })
      const refused = {
        field: 'title',
        change_seq: 1,
        decision: 'refused',
        decided_updated_at: 50,
        reason: 'journal',
      }
      const acks = {
        schema_version: 1,
        desktop_device_id: 'desk-a',
        acks: [
          {
            path: 'web-1234/outbox/e1.bin',
            content_hash: 'x',
            applied_updated_at: null,
            created: false,
            refused_reason: null,
            decided: [refused],
          },
        ],
      }
      await r.db.files.put({
        path: 'desk-a/outbox-acks.bin',
        ciphertext: enc.encode(JSON.stringify(acks)),
        etag: null,
        modifiedTime: null,
        lastAccess: 0,
        pinned: false,
      })
      configureReadEnv({ isUnlocked: () => true, session: async () => r.session })
      setWriteFlagForTest(true)

      await r.session.ready()
      expect(r.vault.getOutboxIntent('e1')?.fields.title).toBeNull()
      expect((await r.db.drafts.get('e1'))?.sealed).toEqual(draft.sealed)

      await entryHandlers.toggle_favorite({ id: 'e1' })
      const stored = await r.db.drafts.get('e1')
      const persisted = JSON.parse(dec.decode(stored?.sealed)) as OutboxEntryV1
      expect(persisted.fields.title).toBeNull()
      expect(persisted.fields.is_favorite?.value).toBe(true)
    })

    describe('retention and outbox writes share one mutex', () => {
      const ref = {
        media_id: 'm1',
        file_name: 'a.jpg',
        file_type: 'image/jpeg',
        size: 1,
        has_thumb: true,
      }
      const BLOBS = ['outbox/m-m1', 'outbox/m-m1.thumb']

      /** A pushed draft with media that retention keeps until `e1` is tombstoned. */
      async function raceRig() {
        const draft = await pushedDraft(intent({ media: [ref] }))
        const desktops: RetentionDesktops = {
          manifests: ['desk-a'],
          slots: new Set(['desk-a']),
          tombstones: new Set(),
        }
        const r = await hydrationRig([draft], desktops)
        for (const path of BLOBS) {
          await r.db.blobs.put({ path, bytes: new Uint8Array([1]), size: 1, lastAccess: 0 })
        }
        configureReadEnv({ isUnlocked: () => true, session: async () => r.session })
        setWriteFlagForTest(true)
        await r.session.ready()
        expect(await r.db.drafts.get('e1')).toBeDefined() // kept by the first pass
        desktops.tombstones = new Set(['e1']) // the next pass drops it
        return { ...r, draft }
      }

      /** Holds the next call of `method` until the returned gate opens. */
      function holdNext<K extends 'get' | 'list'>(
        target: Record<K, () => Promise<unknown>>,
        method: K,
      ) {
        const gate = new Gate()
        const reached = { value: false }
        const original = target[method]
        target[method] = async () => {
          target[method] = original
          reached.value = true
          await gate.promise
          return original()
        }
        return { gate, reached }
      }

      const ticks = async (n = 30): Promise<void> => {
        for (let i = 0; i < n; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0))
      }

      /** Every media ref of the stored draft still has its sealed blobs: it can be packed. */
      async function assertPushable(db: WebDb): Promise<void> {
        const stored = await db.drafts.get('e1')
        if (stored === undefined) return
        const persisted = JSON.parse(dec.decode(stored.sealed)) as OutboxEntryV1
        for (const m of persisted.media) {
          expect(await db.blobs.get(`outbox/m-${m.media_id}`), m.media_id).toBeDefined()
          if (m.has_thumb) expect(await db.blobs.get(`outbox/m-${m.media_id}.thumb`)).toBeDefined()
        }
      }

      it('a retention pass waits for an in-flight write; the edit keeps its media', async () => {
        const r = await raceRig()
        // The write reads priorIntent, then awaits the device record: hold it there.
        const held = holdNext(r.db.device, 'get')
        const write = entryHandlers.toggle_favorite({ id: 'e1' })
        await ticks()
        expect(held.reached.value).toBe(true)

        const pulled = r.session.pull()
        await ticks()
        // Retention has not run: the pushed draft and its media are still there.
        expect((await r.db.drafts.get('e1'))?.sealed).toEqual(r.draft.sealed)
        expect(await r.db.blobs.get('outbox/m-m1')).toBeDefined()

        held.gate.open()
        await write
        await pulled
        const stored = await r.db.drafts.get('e1')
        expect(stored?.pushedHash).toBeUndefined() // the new edit, not yet pushed
        const persisted = JSON.parse(dec.decode(stored?.sealed)) as OutboxEntryV1
        expect(persisted.fields.is_favorite?.value).toBe(true)
        expect(persisted.media.map((m) => m.media_id)).toEqual(['m1'])
        await assertPushable(r.db)
      })

      it('a write waits for an in-flight retention pass', async () => {
        const r = await raceRig()
        const held = holdNext(r.db.drafts, 'list')
        const pulled = r.session.pull()
        await ticks()
        expect(held.reached.value).toBe(true)

        const write = entryHandlers.toggle_favorite({ id: 'e1' })
        await ticks()
        // The write has not saved: the stored draft is still the pushed one.
        expect((await r.db.drafts.get('e1'))?.sealed).toEqual(r.draft.sealed)

        held.gate.open()
        await pulled
        await write
        // Retention dropped the pushed draft first; the write built on the synced state.
        const persisted = JSON.parse(
          dec.decode((await r.db.drafts.get('e1'))?.sealed),
        ) as OutboxEntryV1
        expect(persisted.fields.is_favorite?.value).toBe(true)
        expect(persisted.media).toEqual([])
        expect(await r.db.blobs.get('outbox/m-m1')).toBeUndefined()
        await assertPushable(r.db)
      })
    })

    it('pull() returns its notices once and reports the change', async () => {
      const created = intent({ entry_id: 'e9', created_on_web: true })
      const draft = await pushedDraft(created)
      const r = await hydrationRig([draft], {
        manifests: ['desk-a'],
        slots: new Set(['desk-a']),
        tombstones: new Set(),
      })
      const acks = {
        schema_version: 1,
        desktop_device_id: 'desk-a',
        acks: [
          {
            path: 'web-1234/outbox/e9.bin',
            content_hash: draft.pushedHash,
            applied_updated_at: null,
            created: false,
            refused_reason: 'no_journal',
            decided: [],
          },
        ],
      }
      expect(await r.session.pull()).toMatchObject({ changed: false })
      expect(await r.db.drafts.get('e9')).toBeDefined()
      await r.db.files.put({
        path: 'desk-a/outbox-acks.bin',
        ciphertext: enc.encode(JSON.stringify(acks)),
        etag: null,
        modifiedTime: null,
        lastAccess: 0,
        pinned: false,
      })

      const second = await r.session.pull()
      expect(second).toMatchObject({
        changed: true,
        notices: ['This entry could not be added on your desktop: no_journal'],
      })
      expect(await r.db.drafts.get('e9')).toBeUndefined()
      expect((await r.session.pull()).notices).toBeUndefined()
    })
  })
})
