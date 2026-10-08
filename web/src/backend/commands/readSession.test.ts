import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Core } from '../../core/core'
import { setWriteFlagForTest } from '../config'
import { VaultLockedError } from '../keys'
import { WRAPPED_MASTER_HEX_LEN, openWebDb, type DraftRecord, type WebDb } from '../storage/idb'
import type { IndexEntry } from '../sync/entryIndex'
import { isFormatGuardLatched, latchFormatGuard, resetFormatGuardLatch } from '../sync/formatGuard'
import { PullTransientError } from '../sync/pull'
import { createEmptyOutboxFields, type OutboxEntryV1 } from '../sync/outbox'
import { entryHandlers } from './entries'
import { configureReadEnv, createReadSession, openForRead, type ReadSession } from './readSession'
import { sha256Hex } from '../drafts'
import type { RetentionDesktops } from '../sync/retention'
import { FakeVault } from './readTestKit'

const fakes = vi.hoisted(() => ({
  hooks: [] as Array<() => void>,
  puller: null as unknown,
  vault: null as unknown,
  vaultDeps: null as unknown,
}))

vi.mock('../keys', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../keys')>()),
  onLock: (cb: () => void) => {
    fakes.hooks.push(cb)
    return () => undefined
  },
  getKeyRing: () => ({}),
}))
vi.mock('../sync/pull', async (importOriginal) => ({
  // The real error classes (PullTransientError's instanceof drives the warm-start swallow);
  // only the puller construction is faked.
  ...(await importOriginal<typeof import('../sync/pull')>()),
  createPuller: () => fakes.puller,
}))
vi.mock('../vault', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../vault')>()),
  createVault: (deps: unknown) => {
    fakes.vaultDeps = deps
    return fakes.vault
  },
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
  puller: { index: Map<string, IndexEntry> | null }
  pathsGate: { current: Gate | null }
  warmGate: { current: Gate | null }
  refreshGate: { current: Gate | null }
  warmError: { current: unknown }
  refreshRows: { current: Array<[string, number]> }
  paths: ReturnType<typeof vi.fn>
  warmStart: ReturnType<typeof vi.fn>
  primeFromCache: ReturnType<typeof vi.fn>
  refresh: ReturnType<typeof vi.fn>
  setExcluded: ReturnType<typeof vi.fn>
  lock: () => void
}

const indexOf = (rows: Array<[string, number]>): Map<string, IndexEntry> =>
  new Map(
    rows.map(([id, updatedAt]) => [
      id,
      { entryId: id, authorDevice: 'devA', updatedAt, isDeleted: false },
    ]),
  )

async function rig(): Promise<Rig> {
  const pathsGate: Rig['pathsGate'] = { current: null }
  const warmGate: Rig['warmGate'] = { current: null }
  const refreshGate: Rig['refreshGate'] = { current: null }
  const warmError: Rig['warmError'] = { current: undefined }
  const refreshRows: Rig['refreshRows'] = { current: [['e1', 1]] }
  const paths = vi.fn(async () => {
    await pathsGate.current?.promise
    return ['devA/journals/j1.bin']
  })
  const warmStart = vi.fn(async () => {
    await warmGate.current?.promise
    if (warmError.current !== undefined) throw warmError.current
    return [] as string[]
  })
  const setExcluded = vi.fn()
  // The session reads `puller.index` live; the fake keeps one object for the whole test.
  const puller = {
    index: null as Map<string, IndexEntry> | null,
    foreignIntents: [] as never[],
    desktops: { manifests: [] as string[], slots: null, tombstones: new Set<string>() },
    v2Desktops: new Set<string>() as ReadonlySet<string>,
    indexSource: null as string | null,
    getDegradedDevices: () => [] as Array<{ device: string; reason: string }>,
    primeFromCache: null as unknown as ReturnType<typeof vi.fn>,
    refresh: null as unknown as ReturnType<typeof vi.fn>,
    warmStart,
  }
  // Primes from "the cache": assigns the index (a reload has none) and resolves true.
  puller.primeFromCache = vi.fn(async () => {
    puller.index = indexOf([['e1', 1]])
    return true
  })
  puller.refresh = vi.fn(async () => {
    await refreshGate.current?.promise
    puller.index = indexOf(refreshRows.current)
    return { stale: [] as string[] }
  })
  fakes.puller = puller
  fakes.vault = {
    setExcludedJournalIds: setExcluded,
    setTrashedIds: () => undefined,
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
    puller,
    pathsGate,
    warmGate,
    refreshGate,
    warmError,
    refreshRows,
    paths,
    warmStart,
    primeFromCache: puller.primeFromCache,
    refresh: puller.refresh,
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
    // Let ready() reach the taxonomy read (it may prime or refresh the index first).
    for (let i = 0; i < 20; i++) await Promise.resolve()
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

  it('pull() reports a format guard latch so the sync status turns read-only', async () => {
    resetFormatGuardLatch()
    const r = await rig()
    Object.assign(fakes.puller as object, {
      refresh: async () => ({ stale: [] }),
      getDegradedDevices: () => [],
    })
    expect((await r.session.pull()).formatReadOnly).toBeUndefined()
    latchFormatGuard('devA/metadata.json', 'Unknown field(s) found: x')
    expect((await r.session.pull()).formatReadOnly).toBe('Unknown field(s) found: x')
    resetFormatGuardLatch()
  })

  it('pull() reports the desktop capabilities the refresh observed', async () => {
    const r = await rig()
    expect((await r.session.pull()).capabilities).toEqual({ outboxV2: false, monthIndex: false })
    Object.assign(fakes.puller as object, { v2Desktops: new Set(['devA']), indexSource: 'devB' })
    expect((await r.session.pull()).capabilities).toEqual({ outboxV2: true, monthIndex: true })
  })

  it('wires the month index reader and clears it on lock', async () => {
    const r = await rig()
    const reader = r.session.monthIndex
    expect(reader).toBeDefined()
    const clear = vi.spyOn(reader!, 'clear')
    r.lock()
    expect(clear).toHaveBeenCalledTimes(1)
  })

  it('the vault metadata guard latches on an unknown EntryMetadata field without throwing', async () => {
    resetFormatGuardLatch()
    await rig()
    const { guardMetadata } = fakes.vaultDeps as {
      guardMetadata: (id: string, json: string) => void
    }
    const meta = { entry_id: 'e1', device_id: 'd', updated_at: 1, journal_id: 'j' }
    guardMetadata('e1', JSON.stringify(meta))
    expect(isFormatGuardLatched()).toBe(false)
    expect(() => guardMetadata('e1', JSON.stringify({ ...meta, future_field: 1 }))).not.toThrow()
    expect(isFormatGuardLatched()).toBe(true)
    resetFormatGuardLatch()
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

describe('read session priming', () => {
  it('ready() serves a primed index without waiting for refresh', async () => {
    const r = await rig()
    r.refreshGate.current = new Gate() // stays closed: refresh must not be needed
    const taxonomy = await r.session.ready()
    expect(r.primeFromCache).toHaveBeenCalledTimes(1)
    expect(r.refresh).not.toHaveBeenCalled()
    expect(taxonomy.excludedJournalIds).toEqual(['j1'])
  })

  it('ready() awaits refresh on a first-ever unlock (prime finds nothing)', async () => {
    const r = await rig()
    r.primeFromCache.mockResolvedValue(false)
    r.refreshGate.current = new Gate()
    const pending = r.session.ready()
    let settled = false
    void pending.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    for (let i = 0; i < 20; i++) await Promise.resolve()
    expect(r.primeFromCache).toHaveBeenCalledTimes(1)
    expect(r.refresh).toHaveBeenCalledTimes(1)
    expect(settled, 'ready() resolved while the refresh was still held').toBe(false)
    r.refreshGate.current.open()
    await pending
    expect(r.puller.index).not.toBeNull()
  })

  it('pull() compares against the primed index even when it starts before any list call', async () => {
    const r = await rig()
    r.refreshRows.current = [['e1', 2]] // a changed row lands in the refresh
    const outcome = await r.session.pull()
    expect(outcome.changed).toBe(true)

    const same = await rig() // prime and refresh carry identical rows
    expect((await same.session.pull()).changed).toBe(false)
  })

  it('pull() reports a change when only the trash state of a row moved', async () => {
    const r = await rig()
    r.refresh.mockImplementationOnce(async () => {
      r.puller.index = new Map([
        [
          'e1',
          { entryId: 'e1', authorDevice: 'devA', updatedAt: 1, isDeleted: false, trashedAt: 1 },
        ],
      ])
      return { stale: [] as string[] }
    })
    expect((await r.session.pull()).changed).toBe(true)
  })

  it('prime runs once per unlock and again after a lock', async () => {
    const r = await rig()
    await r.session.ready()
    await r.session.ready()
    await r.session.pull() // prime is memoised for the unlock
    expect(r.primeFromCache).toHaveBeenCalledTimes(1)
    r.lock()
    r.puller.index = null // the index survives a lock; a reload's puller starts with none
    await r.session.ready()
    expect(r.primeFromCache).toHaveBeenCalledTimes(2)
  })

  it('a lock during prime rejects ready() with VaultLockedError and caches nothing', async () => {
    const r = await rig()
    r.primeFromCache.mockRejectedValueOnce(new VaultLockedError())
    await expect(r.session.ready()).rejects.toBeInstanceOf(VaultLockedError)
    expect(r.paths).not.toHaveBeenCalled()
    expect(r.setExcluded).not.toHaveBeenCalled()
    // The prime memo cleared itself: the next ready() primes again and proceeds.
    const taxonomy = await r.session.ready()
    expect(r.primeFromCache).toHaveBeenCalledTimes(2)
    expect(taxonomy.excludedJournalIds).toEqual(['j1'])
  })

  it('a warm-start transient failure on a primed index does not reject ready()', async () => {
    const r = await rig()
    r.warmError.current = new PullTransientError('offline')
    await r.session.ready() // the cached list is served; the warm failure is swallowed
    expect(r.warmStart).toHaveBeenCalledTimes(1)
    await r.session.ready() // the memo cleared itself: the warm start retries
    expect(r.warmStart).toHaveBeenCalledTimes(2)
    // Only a transient failure is swallowed: a different error still rejects.
    r.warmError.current = new Error('corrupt')
    await expect(r.session.ready()).rejects.toThrow('corrupt')

    // On a refreshed (not primed) index the old behaviour is unchanged: transient rejects.
    const refreshed = await rig()
    refreshed.primeFromCache.mockResolvedValue(false)
    refreshed.warmError.current = new PullTransientError('offline')
    await expect(refreshed.session.ready()).rejects.toBeInstanceOf(PullTransientError)
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
    drafts: Array<{
      entryId: string
      sealed: Uint8Array
      pushedHash?: string
      kind?: DraftRecord['kind']
    }>,
    desktops: RetentionDesktops = { manifests: [], slots: null, tombstones: new Set() },
    v2Desktops: ReadonlySet<string> = new Set<string>(),
  ) {
    const vault = Object.assign(new FakeVault([{ id: 'e1', updatedAt: 1 }]), {
      setExcludedJournalIds: vi.fn(),
    })
    fakes.vault = vault
    fakes.puller = {
      index: new Map(),
      primeFromCache: async () => true, // index already set: a no-op, like the real puller
      refresh: async () => ({ stale: [] }),
      warmStart: async () => [] as string[],
      getDegradedDevices: () => [],
      desktops,
      foreignIntents: [],
      v2Desktops,
      indexSource: null,
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
      // A v2 body has a `kind`.
      openOutboxIntent: (_r: unknown, b: Uint8Array) => {
        const json = dec.decode(b)
        const version = 'kind' in (JSON.parse(json) as object) ? 2 : 1
        return { version, json, free: () => undefined }
      },
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

  it("never decodes nor shows another browser's v2 intent ([jtpd]-); entry intents unchanged", async () => {
    const r = await hydrationRig([])
    const foreign = intent({ web_device_id: 'web-other' })
    const prefixed = 't-11111111-1111-4111-8111-111111111111'
    ;(fakes.puller as { foreignIntents: unknown[] }).foreignIntents = [
      { device: 'web-other', entryId: 'e1', bytes: enc.encode(JSON.stringify(foreign)) },
      { device: 'web-other', entryId: prefixed, bytes: enc.encode('{"kind":"create_tag"}') },
    ]

    await r.session.ready()

    expect(r.vault.foreignIntents).toEqual([foreign])
    expect(r.openOutboxEntry).toHaveBeenCalledTimes(1)
  })

  it('a pull drops a pushed tag draft whose tag the desktop created then deleted (v2 state wired)', async () => {
    const TAG = '11111111-1111-4111-8111-111111111111'
    const sealed = enc.encode(
      JSON.stringify({
        kind: 'create_tag',
        web_device_id: 'web-1234',
        web_updated_at_secs: 1,
        tag_id: TAG,
        name: 'Work',
        color: null,
      }),
    )
    const key = `t-${TAG}`
    const draft = {
      entryId: key,
      kind: 'tag' as const,
      sealed,
      pushedHash: await sha256Hex(sealed),
    }
    const desktops = {
      manifests: ['desk-a'],
      slots: new Set(['desk-a']),
      tombstones: new Set<string>(),
    }
    const r = await hydrationRig([draft], desktops, new Set(['desk-a']))
    const tags = { tags: [{ id: TAG, name: 'Work', color: null, updated_at: 2, is_deleted: true }] }
    await r.db.files.put({
      path: 'desk-a/tags.bin',
      ciphertext: enc.encode(JSON.stringify(tags)),
      etag: null,
      modifiedTime: null,
      lastAccess: 0,
      pinned: false,
    })

    await r.session.pull()

    expect(await r.db.drafts.get(key)).toBeUndefined()
  })

  describe('pending v2 overlay (Phase 22)', () => {
    const DESKTOPS = {
      manifests: ['desk-a'],
      slots: new Set(['desk-a']),
      tombstones: new Set<string>(),
    }

    async function pushedDraft(key: string, kind: DraftRecord['kind'], body: object) {
      const sealed = enc.encode(JSON.stringify(body))
      return { entryId: key, kind, sealed, pushedHash: await sha256Hex(sealed) }
    }

    async function refuse(db: WebDb, key: string, sealed: Uint8Array, reason: string) {
      const ack = {
        path: `web-1234/outbox/${key}.bin`,
        content_hash: await sha256Hex(sealed),
        applied_updated_at: null,
        created: false,
        refused_reason: reason,
        decided: [],
      }
      await db.files.put({
        path: 'desk-a/outbox-acks.bin',
        ciphertext: enc.encode(JSON.stringify({ desktop_device_id: 'desk-a', acks: [ack] })),
        etag: null,
        modifiedTime: null,
        lastAccess: 0,
        pinned: false,
      })
    }

    it('lists a pending journal and admits its entries while ready() stays synced; a final refusal removes it', async () => {
      const J = '55555555-5555-4555-8555-555555555555'
      const draft = await pushedDraft(`j-${J}`, 'journal', {
        kind: 'create_journal',
        web_device_id: 'web-1234',
        web_updated_at_secs: 9,
        journal_id: J,
        name: 'Trips',
        color: null,
        auto_tag_ids: [],
      })
      const r = await hydrationRig([draft], DESKTOPS, new Set(['desk-a']))
      configureReadEnv({ isUnlocked: () => true, session: async () => r.session })

      // Push hold-back and retention read ready(): it must not show the pending create.
      const synced = await r.session.ready()
      expect(synced.journals).toEqual([])
      expect(synced.knownJournalIds).toEqual([])
      expect((await openForRead()).taxonomy.journals.map((j) => j.id)).toEqual([J])
      expect(r.vault.setExcludedJournalIds.mock.lastCall?.[1]).toEqual([J])

      await refuse(r.db, draft.entryId, draft.sealed, 'name_taken')
      const outcome = await r.session.pull()

      expect(await r.db.drafts.get(draft.entryId)).toBeUndefined()
      expect(outcome.changed).toBe(true)
      expect(outcome.notices).toEqual([
        { kind: 'refused', field: 'create_journal', title: 'Trips', reason: 'name_taken' },
      ])
      expect((await openForRead()).taxonomy.journals).toEqual([])
      expect(r.vault.setExcludedJournalIds.mock.lastCall?.[1]).toEqual([])
    })

    it('hides an entry with a pending trash; a final refusal brings it back with a notice', async () => {
      const draft = await pushedDraft('d-e1', 'trash', {
        kind: 'trash_entry',
        web_device_id: 'web-1234',
        web_updated_at_secs: 9,
        entry_id: 'e1',
        base_updated_at: 1,
      })
      const r = await hydrationRig([draft], DESKTOPS, new Set(['desk-a']))
      await r.session.ready()
      await r.vault.load(['e1'])
      expect(r.vault.status('e1')).toBe('deleted')

      await refuse(r.db, draft.entryId, draft.sealed, 'changed_on_desktop')
      const outcome = await r.session.pull()

      expect(await r.db.drafts.get('d-e1')).toBeUndefined()
      expect(r.vault.status('e1')).toBe('visible')
      expect(outcome.changed).toBe(true)
      expect(outcome.notices).toEqual([
        { kind: 'refused', field: 'trash_entry', reason: 'changed_on_desktop' },
      ])
    })
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
        notices: [{ kind: 'refused', title: 'Web title', reason: 'no_journal' }],
      })
      expect(await r.db.drafts.get('e9')).toBeUndefined()
      expect((await r.session.pull()).notices).toBeUndefined()
    })
  })
})
