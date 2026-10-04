import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { loadCore, type Core } from '../../core/core'
import { configureReadEnv, createReadSession } from '../commands/readSession'
import { sha256Hex } from '../drafts'
import { DriveReader, DriveWriter } from '../drive/client'
import {
  FakeDrive,
  fakeLocks,
  loadDesktopFixture,
  seedFromFixture,
  violations,
  type DesktopFixture,
} from '../drive/fakeDrive'
import { configureKeysEnv, dispose, getKeyRing } from '../keys'
import { openWebDb } from '../storage/idb'
import { onboardComplete } from './onboard'
import {
  createEmptyOutboxFields,
  type OutboxAckEntry,
  type OutboxAcksV1,
  type OutboxEntryV1,
} from './outbox'
import { clearReonboardReason } from './pull'

const PASSWORD = '12345678'
const OWN_ID = 'cccccccc-1111-4222-8333-dddddddddddd'
const ENTRY = 'eeeeeeee-1111-4222-8333-ffffffffffff'

let core: Core
let fixture: DesktopFixture

/** bincode 1 with fixint encoding (the desktop's `bincode_opts`): little-endian, u64 lengths. */
class Bincode {
  readonly #out: number[] = []
  u8(v: number): this {
    this.#out.push(v)
    return this
  }
  u16(v: number): this {
    return this.u8(v & 0xff).u8(v >> 8)
  }
  u64(v: number): this {
    const b = new DataView(new ArrayBuffer(8))
    b.setBigUint64(0, BigInt(v), true)
    for (let i = 0; i < 8; i++) this.u8(b.getUint8(i))
    return this
  }
  str(s: string): this {
    const bytes = new TextEncoder().encode(s)
    this.u64(bytes.length)
    for (const x of bytes) this.u8(x)
    return this
  }
  opt<T>(v: T | null, write: (v: T) => void): this {
    if (v === null) return this.u8(0)
    this.u8(1)
    write(v)
    return this
  }
  bytes(): Uint8Array {
    return new Uint8Array(this.#out)
  }
}

/** `OutboxAcksV1` exactly as the desktop serializes it before sealing (field order matters). */
function encodeAcks(acks: OutboxAcksV1): Uint8Array {
  const w = new Bincode().u16(acks.schema_version).str(acks.desktop_device_id).u64(acks.acks.length)
  for (const a of acks.acks) {
    w.str(a.path)
      .str(a.content_hash)
      .opt(a.applied_updated_at, (v) => w.u64(v))
      .u64(a.decided.length)
    for (const d of a.decided) {
      w.str(d.field)
        .u64(d.change_seq)
        .str(d.decision)
        .u64(d.decided_updated_at)
        .opt(d.reason, (v) => w.str(v))
    }
    w.u8(a.created ? 1 : 0).opt(a.refused_reason, (v) => w.str(v))
  }
  return w.bytes()
}

async function setup() {
  const drive = new FakeDrive()
  seedFromFixture(drive, fixture)
  const deps = {
    getToken: async () => 'tok',
    fetchImpl: (input: string, init?: RequestInit) => drive.fetch(input, init),
    sleep: async () => {},
    locks: fakeLocks(drive),
  }
  const reader = new DriveReader(deps)
  const writer = new DriveWriter(reader, deps)
  const db = await openWebDb({ factory: new IDBFactory() })
  await onboardComplete(
    {
      reader,
      writer,
      db,
      core,
      now: () => 1_800_000_000_000,
      randomUUID: () => OWN_ID,
      userAgent: () => 'Chrome/126.0',
      persist: async () => true,
      sleep: async () => {},
    },
    { phrase: fixture.recovery_phrase, password: PASSWORD },
  )
  const session = await createReadSession({ db, reader, core })
  configureReadEnv({ session: async () => session, emit: () => undefined })
  const desktopFolder = drive.find(['Memlore', 'generations', 'g-0', fixture.device_id])
  if (!desktopFolder) throw new Error('no desktop folder')
  return { drive, db, session, desktopFolder: desktopFolder.id }
}

beforeAll(async () => {
  core = await loadCore()
  fixture = loadDesktopFixture()
})

beforeEach(() => {
  violations.length = 0
  clearReonboardReason()
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
  expect(violations).toEqual([])
})

describe('intent retention against real sealed acks', () => {
  it('the real core opens desktop-shaped acks; every desktop refused the create: drop + notice', async () => {
    const env = await setup()
    const doc = new Y.Doc()
    doc.getXmlFragment('default').insert(0, [new Y.XmlElement('paragraph')])
    const at = { base_updated_at: 0, change_seq: 3, changed_at_secs: 1_800_000_000 }
    // Every shape a write command builds, as a TS object (not one re-opened by the core).
    const intent: OutboxEntryV1 = {
      schema_version: 1,
      entry_id: ENTRY,
      web_device_id: OWN_ID,
      created_on_web: true,
      web_updated_at_secs: 1_800_000_000,
      base_state_vector: [],
      yjs_full_state: Array.from(Y.encodeStateAsUpdate(doc)),
      content_text: 'hello',
      preview_text: 'hello',
      fields: {
        ...createEmptyOutboxFields(),
        title: { value: 'T', base: '', ...at },
        entry_date: { value: '1800000000', base: '1800000000', ...at },
        emotion: { value: 'good', base: null, ...at },
        is_favorite: { value: true, base: false, ...at },
        journal_id: { value: 'efd3b558-3fa2-4b35-b31d-e16a918e98cc', base: '', ...at },
        tags_add: { 'abcdef12-0000-4000-8000-000000000001': { value: true, base: false, ...at } },
      },
      media: [
        {
          media_id: 'abcdef12-0000-4000-8000-0000000000ff',
          file_name: 'a.jpg',
          file_type: 'image/jpeg',
          size: 3,
          has_thumb: true,
        },
      ],
    }
    const ring = getKeyRing()
    const sealed = core.sealOutboxEntry(ring, JSON.stringify(intent))
    const hash = await sha256Hex(sealed)
    await env.db.drafts.put({ entryId: ENTRY, sealed, updatedAt: 1, pushedHash: hash })

    const ack: OutboxAckEntry = {
      path: `${OWN_ID}/outbox/${ENTRY}.bin`,
      content_hash: hash,
      applied_updated_at: null,
      decided: [
        {
          field: 'title',
          change_seq: 3,
          decision: 'refused',
          decided_updated_at: 1_790_000_000,
          reason: null,
        },
      ],
      created: false,
      refused_reason: 'no_journal',
    }
    const acks: OutboxAcksV1 = {
      schema_version: 1,
      desktop_device_id: fixture.device_id,
      acks: [ack],
    }
    const file = core.sealOutboxMedia(ring, encodeAcks(acks))
    expect(JSON.parse(core.openOutboxAcks(ring, file))).toEqual(acks)
    env.drive.addFile('outbox-acks.bin', env.desktopFolder, file)
    // A write in this session put the TS-built object in the overlay (hydration keeps it).
    env.session.vault.setOutboxIntents([intent])

    const outcome = await env.session.pull()

    expect(outcome.notices).toEqual(['This entry could not be added on your desktop: no_journal'])
    expect(await env.db.drafts.get(ENTRY)).toBeUndefined()
    expect(env.session.vault.getOutboxIntent(ENTRY)).toBeUndefined()
  })

  it('keeps every draft while an acks file does not open', async () => {
    const env = await setup()
    const ring = getKeyRing()
    const locked = (
      fixture.expected.entries as unknown as Array<{ entry_id: string; is_locked: boolean }>
    ).find((e) => e.is_locked)
    if (!locked) throw new Error('fixture has no locked entry')
    const intent: OutboxEntryV1 = {
      schema_version: 1,
      entry_id: locked.entry_id,
      web_device_id: OWN_ID,
      created_on_web: false,
      web_updated_at_secs: 1_800_000_000,
      base_state_vector: [],
      yjs_full_state: [],
      content_text: null,
      preview_text: null,
      fields: createEmptyOutboxFields(),
      media: [],
    }
    const sealed = core.sealOutboxEntry(ring, JSON.stringify(intent))
    await env.db.drafts.put({
      entryId: locked.entry_id,
      sealed,
      updatedAt: 1,
      pushedHash: await sha256Hex(sealed),
    })
    const bad = env.drive.addFile('outbox-acks.bin', env.desktopFolder, 'not a sealed file')

    await env.session.pull()
    expect(await env.db.drafts.get(locked.entry_id)).toBeDefined()

    // Control: once the file is gone, the locked entry's pushed draft is dropped.
    env.drive.files = env.drive.files.filter((f) => f.id !== bad)
    await env.session.pull()
    expect(await env.db.drafts.get(locked.entry_id)).toBeUndefined()
  })
})
