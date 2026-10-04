import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Entry } from '../../../../src/types/entry'
import { loadCore, type Core } from '../../core/core'
import { setWriteFlagForTest } from '../config'
import { createDraftManager } from '../drafts'
import { DriveReader, DriveWriter } from '../drive/client'
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
import { configureKeysEnv, dispose, getKeyRing } from '../keys'
import { openWebDb, type WebDb } from '../storage/idb'
import { onboardComplete } from '../sync/onboard'
import { createEmptyOutboxFields, type OutboxEntryV1 } from '../sync/outbox'
import { clearReonboardReason } from '../sync/pull'
import { MSG_UNAVAILABLE, entryHandlers } from './entries'
import { configureReadEnv, createReadSession, type ReadSession } from './readSession'

const PASSWORD = '12345678'
const OWN_ID = 'cccccccc-1111-4222-8333-dddddddddddd'
const WEB_A = 'eeeeeeee-3333-4444-8555-ffffffffffff'
const WEB_B = 'ffffffff-4444-4555-8666-000000000000'
const CREATED = 'aaaaaaaa-0000-4000-8000-0000000000aa'

let core: Core
let fixture: DesktopFixture

interface Row {
  entry_id: string
  updated_at: number
}

interface Env {
  drive: FakeDrive
  db: WebDb
  session: ReadSession
}

const call = <T>(name: string, args: Record<string, unknown> = {}): Promise<T> =>
  Promise.resolve(entryHandlers[name](args)) as Promise<T>

function manifestRows(): Row[] {
  const raw = fixtureBytes(fixture, `generations/g-0/${fixture.device_id}/metadata.json`)
  return (JSON.parse(text(raw)) as { entries: Row[] }).entries
}

/** A fixture entry with its synced title and `updated_at`. */
function synced(title: string): { id: string; updatedAt: number } {
  const entry = fixture.expected.entries.find((e) => e.title === title)
  const row = manifestRows().find((r) => r.entry_id === entry?.entry_id)
  if (entry === undefined || row === undefined) throw new Error(`no fixture entry ${title}`)
  return { id: entry.entry_id, updatedAt: row.updated_at }
}

function intent(
  device: string,
  entryId: string,
  overrides: Partial<OutboxEntryV1> = {},
): OutboxEntryV1 {
  return {
    schema_version: 1,
    entry_id: entryId,
    web_device_id: device,
    created_on_web: false,
    web_updated_at_secs: 1_800_000_000,
    base_state_vector: [],
    yjs_full_state: [],
    content_text: null,
    preview_text: null,
    fields: createEmptyOutboxFields(),
    media: [],
    ...overrides,
  }
}

const titleField = (value: string, base: string, baseUpdatedAt: number) => ({
  ...createEmptyOutboxFields(),
  title: { value, base, base_updated_at: baseUpdatedAt, change_seq: 1, changed_at_secs: 1 },
})

async function setup(): Promise<Env> {
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
  drive.requests.length = 0
  const session = await createReadSession({ db, reader, core })
  configureReadEnv({ session: async () => session, emit: () => {}, pageSize: 20 })
  return { drive, db, session }
}

/** Another browser of the vault: a device slot and `generations/g-0/<device>/outbox/*.bin`. */
function addWebDevice(drive: FakeDrive, device: string, files: Record<string, Uint8Array>): void {
  if (device !== OWN_ID) {
    const slots = drive.chain('Memlore', '.meta', 'keyring', 'devices')
    drive.addFile(`${device}.json`, slots, '{}')
  }
  const outbox = drive.chain('Memlore', 'generations', 'g-0', device, 'outbox')
  for (const [name, content] of Object.entries(files)) drive.addFile(name, outbox, content)
}

const seal = (value: OutboxEntryV1): Uint8Array =>
  core.sealOutboxEntry(getKeyRing(), JSON.stringify(value))

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
  setWriteFlagForTest(false)
  configureReadEnv({})
  dispose()
  vi.restoreAllMocks()
  expect(violations).toEqual([])
})

describe('the overlay shows other browsers pending edits (read-only)', () => {
  it('overlays a foreign intent on a synced entry, skips a corrupt one, writes nothing', async () => {
    const env = await setup()
    const one = synced('Golden one')
    const two = synced('Golden two')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    addWebDevice(env.drive, WEB_A, {
      [`${one.id}.bin`]: seal(
        intent(WEB_A, one.id, {
          fields: titleField('From browser A', 'Golden one', one.updatedAt),
        }),
      ),
      [`${two.id}.bin`]: bytes('not a sealed intent'),
    })

    const entry = await call<Entry>('get_entry', { id: one.id })
    expect(entry.title).toBe('From browser A')
    expect((await call<Entry>('get_entry', { id: two.id })).title).toBe('Golden two')
    expect(warn).toHaveBeenCalled()
    for (const [message] of warn.mock.calls) expect(String(message)).not.toContain('Golden')
    expect(env.session.vault.getOutboxIntents()).toEqual([])
    expect(await createDraftManager({ db: env.db }).listDrafts()).toEqual([])
    expect(env.drive.mutating()).toEqual([])
  })

  it('never masks a later desktop edit', async () => {
    const env = await setup()
    const one = synced('Golden one')
    addWebDevice(env.drive, WEB_A, {
      [`${one.id}.bin`]: seal(
        intent(WEB_A, one.id, {
          fields: titleField('Stale web title', 'Older', one.updatedAt - 1),
        }),
      ),
    })

    expect((await call<Entry>('get_entry', { id: one.id })).title).toBe('Golden one')
  })

  it('orders two foreign browsers deterministically and ignores a spoofed device id', async () => {
    const env = await setup()
    const one = synced('Golden one')
    const at = (device: string, secs: number, title: string, claimed = device) =>
      seal(
        intent(claimed, one.id, {
          web_updated_at_secs: secs,
          fields: titleField(title, 'Golden one', one.updatedAt),
        }),
      )
    addWebDevice(env.drive, WEB_A, { [`${one.id}.bin`]: at(WEB_A, 500, 'A') })
    // Same time: the greater device id (WEB_B) wins. A file claiming another device is skipped.
    addWebDevice(env.drive, WEB_B, { [`${one.id}.bin`]: at(WEB_B, 500, 'B') })
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect((await call<Entry>('get_entry', { id: one.id })).title).toBe('B')

    const b = env.drive.find(['Memlore', 'generations', 'g-0', WEB_B, 'outbox', `${one.id}.bin`])
    if (!b) throw new Error('layout')
    b.content = at(WEB_B, 900, 'spoofed', WEB_A)
    expect((await env.session.pull()).changed).toBe(true)
    expect((await call<Entry>('get_entry', { id: one.id })).title).toBe('A')
  })

  it('shows a foreign web-created entry and refuses to write it', async () => {
    const env = await setup()
    setWriteFlagForTest(true)
    addWebDevice(env.drive, WEB_A, {
      [`${CREATED}.bin`]: seal(
        intent(WEB_A, CREATED, {
          created_on_web: true,
          content_text: 'Made elsewhere',
          fields: titleField('Created in browser A', '', 0),
        }),
      ),
    })

    expect((await call<Entry>('get_entry', { id: CREATED })).title).toBe('Created in browser A')
    await expect(call('update_entry', { id: CREATED, title: 'Mine now' })).rejects.toMatchObject({
      name: 'ForeignEntryReadOnlyError',
    })
    expect(await createDraftManager({ db: env.db }).listDrafts()).toEqual([])
    expect(env.drive.mutating()).toEqual([])
  })

  it('a locked entry stays hidden whatever a foreign intent says', async () => {
    const env = await setup()
    const locked = fixture.expected.entries.find(
      (e) => (e as { is_locked?: boolean }).is_locked === true,
    )
    if (!locked) throw new Error('no locked fixture entry')
    addWebDevice(env.drive, WEB_A, {
      [`${locked.entry_id}.bin`]: seal(
        intent(WEB_A, locked.entry_id, {
          created_on_web: true,
          fields: titleField('Unlocked?', '', 0),
        }),
      ),
    })

    await expect(call('get_entry', { id: locked.entry_id })).rejects.toThrow(MSG_UNAVAILABLE)
  })

  it('never reads the own outbox folder as foreign', async () => {
    const env = await setup()
    const one = synced('Golden one')
    addWebDevice(env.drive, OWN_ID, {
      [`${one.id}.bin`]: seal(
        intent(OWN_ID, one.id, {
          fields: titleField('Own cloud copy', 'Golden one', one.updatedAt),
        }),
      ),
    })

    expect((await call<Entry>('get_entry', { id: one.id })).title).toBe('Golden one')
    const ownOutbox = env.drive.find(['Memlore', 'generations', 'g-0', OWN_ID, 'outbox'])
    expect(
      env.drive.requests.some((r) =>
        (r.url.searchParams.get('q') ?? '').includes(ownOutbox?.id ?? '?'),
      ),
    ).toBe(false)
    expect(env.drive.mutating()).toEqual([])
  })
})
