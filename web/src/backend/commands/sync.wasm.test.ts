import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Entry } from '../../../../src/types/entry'
import type { Journal } from '../../../../src/types/journal'
import type { PagedResult } from '../../../../src/types/pagination'
import { loadCore, type Core } from '../../core/core'
import { DriveReader, DriveWriter } from '../drive/client'
import {
  FakeDrive,
  fakeLocks,
  loadDesktopFixture,
  seedFromFixture,
  text,
  violations,
  type DesktopFixture,
} from '../drive/fakeDrive'
import { configureKeysEnv, dispose, isUnlocked } from '../keys'
import { openWebDb, type WebDb } from '../storage/idb'
import { onboardComplete } from '../sync/onboard'
import { clearReonboardReason } from '../sync/pull'
import { entryHandlers } from './entries'
import { configureReadEnv, createReadSession } from './readSession'
import {
  STATUS_EVENT,
  configureSyncEnv,
  startSyncSchedule,
  stopSyncSchedule,
  syncHandlers,
  type SyncStatusEvent,
} from './sync'
import { taxonomyHandlers } from './taxonomy'

const PASSWORD = '12345678'
const OWN_ID = 'cccccccc-1111-4222-8333-dddddddddddd'

class Gate {
  readonly promise: Promise<void>
  open!: () => void
  constructor() {
    this.promise = new Promise<void>((resolve) => {
      this.open = resolve
    })
  }
}

let core: Core
let fixture: DesktopFixture

interface Env {
  drive: FakeDrive
  db: WebDb
  reader: DriveReader
  emitted: string[]
  net: {
    down: boolean
    /** While set, every Drive request that is not an entry-payload download waits on the gate. */
    hold: Gate | null
  }
}

/** Memlore-relative path of a fake file (walks the parent chain below "Memlore"). */
function pathOf(drive: FakeDrive, id: string): string {
  const parts: string[] = []
  let current = drive.files.find((f) => f.id === id)
  while (current && current.parents[0] !== 'appDataFolder') {
    parts.unshift(current.name)
    const parent: string = current.parents[0]
    current = drive.files.find((f) => f.id === parent)
  }
  return parts.join('/')
}

async function setup(): Promise<Env> {
  const drive = new FakeDrive()
  seedFromFixture(drive, fixture)
  const net: Env['net'] = { down: false, hold: null }
  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    if (net.down) throw new TypeError('network down')
    const url = new URL(input)
    // alt=media URLs carry the file id, not a name: resolve the Memlore-relative path.
    const id = /\/files\/([^/]+)$/.exec(url.pathname)?.[1] ?? ''
    const isEntryDownload =
      url.searchParams.get('alt') === 'media' && pathOf(drive, id).includes('/entries/')
    if (net.hold !== null && !isEntryDownload) await net.hold.promise
    return drive.fetch(input, init)
  }
  const deps = {
    getToken: async () => 'tok',
    fetchImpl,
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
  const emitted: string[] = []
  configureReadEnv({
    session: async () => session,
    emit: (event) => {
      emitted.push(event)
    },
  })
  return { drive, db, reader, emitted, net }
}

const handlers = { ...entryHandlers, ...taxonomyHandlers }
const call = <T>(name: string, args: Record<string, unknown> = {}): Promise<T> =>
  Promise.resolve(handlers[name](args)) as Promise<T>

const listPaged = (journalId: string) =>
  call<PagedResult<Entry>>('list_entries_paged', {
    sort: 'newest',
    range: 'all',
    fromTs: null,
    toTs: null,
    firstDayOfWeek: 1,
    lockFilter: 'all',
    journalId,
    page: 1,
  })

/** The id of the journal holding most of the fixture's entries, listed in session 1. */
async function fixtureJournalId(): Promise<string> {
  const journals = await call<Journal[]>('list_journals')
  const journal = journals.find((j) => j.name === 'My Journal')
  if (journal === undefined) throw new Error('fixture journal missing')
  return journal.id
}

/**
 * A "reload": a second read session over the same `db`, then a schedule (re)start whose pull
 * drives that session. Returns the `sync:status-changed` states in emission order.
 */
async function reload(env: Env): Promise<string[]> {
  const session = await createReadSession({ db: env.db, reader: env.reader, core })
  configureReadEnv({
    session: async () => session,
    emit: (event) => {
      env.emitted.push(event)
    },
  })
  const states: string[] = []
  configureSyncEnv({
    setTimeout: () => 0,
    clearTimeout: () => {},
    document: null,
    window: null,
    emit: (event, payload) => {
      if (event === STATUS_EVENT) states.push((payload as SyncStatusEvent).state)
    },
  })
  startSyncSchedule()
  return states
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 200; i++) await new Promise<void>((resolve) => setImmediate(resolve))
}

beforeAll(async () => {
  core = await loadCore()
  fixture = loadDesktopFixture()
})

beforeEach(() => {
  violations.length = 0
  clearReonboardReason()
  configureKeysEnv({ setTimeout: () => 0, clearTimeout: () => {}, document: null, window: null })
  configureSyncEnv({ setTimeout: () => 0, clearTimeout: () => {}, document: null, window: null })
})

afterEach(() => {
  stopSyncSchedule()
  configureSyncEnv({})
  configureReadEnv({})
  dispose()
  expect(violations, 'fixture is read-only').toEqual([])
})

describe('sync with the desktop fixture', () => {
  it('pulls on unlock, then emits entries-changed only when the server changed', async () => {
    const { drive, emitted } = await setup()
    startSyncSchedule()
    await settle()
    expect(emitted).toEqual([])
    await expect(syncHandlers.get_sync_status({})).resolves.toMatchObject({
      provider: 'gdrive',
      lastSync: expect.any(Number),
    })

    const noop = (await syncHandlers.sync_now({})) as { pulled: number; errors: string[] }
    expect(noop).toMatchObject({ pulled: 0, errors: [] })
    expect(emitted).toEqual([])

    const manifest = drive.find([
      'Memlore',
      'generations',
      'g-0',
      fixture.device_id,
      'metadata.json',
    ])
    if (manifest === undefined) throw new Error('no fixture manifest')
    const body = JSON.parse(text(manifest.content)) as { entries: Array<{ updated_at: number }> }
    for (const row of body.entries) row.updated_at += 10
    manifest.content = new TextEncoder().encode(JSON.stringify(body))
    manifest.version += 1

    const changed = (await syncHandlers.sync_now({})) as { pulled: number; errors: string[] }
    expect(changed.errors).toEqual([])
    expect(changed.pulled).toBe(body.entries.length)
    expect(emitted).toEqual(['memlore:entries-changed'])
    expect(drive.mutating()).toEqual([])
  })
})

describe('reload: cached list while the unlock pull revalidates', () => {
  it('serves the primed list while the pull is still in flight, no entries-changed', async () => {
    const env = await setup()
    startSyncSchedule()
    await settle()
    const journalId = await fixtureJournalId()
    const first = await listPaged(journalId)
    env.drive.requests.length = 0

    const gate = new Gate()
    env.net.hold = gate
    const states = await reload(env)
    await settle()
    // The pull is held mid-flight; the cached index + payloads still serve the page.
    const page = await listPaged(journalId)
    expect(page.items).toEqual(first.items)
    expect(states).toEqual(['syncing'])
    gate.open()
    await settle()
    expect(states).toEqual(['syncing', 'synced'])
    expect(env.emitted).toEqual([])
    expect(env.drive.mutating()).toEqual([])
  })

  it('emits entries-changed once when the revalidating pull sees a changed manifest', async () => {
    const env = await setup()
    startSyncSchedule()
    await settle()
    const journalId = await fixtureJournalId()
    const first = await listPaged(journalId)

    const manifest = env.drive.find([
      'Memlore',
      'generations',
      'g-0',
      fixture.device_id,
      'metadata.json',
    ])
    if (manifest === undefined) throw new Error('no fixture manifest')
    const body = JSON.parse(text(manifest.content)) as { entries: Array<{ updated_at: number }> }
    for (const row of body.entries) row.updated_at += 10
    manifest.content = new TextEncoder().encode(JSON.stringify(body))
    manifest.version += 1

    const gate = new Gate()
    env.net.hold = gate
    const states = await reload(env)
    await settle()
    const page = await listPaged(journalId)
    expect(page.items).toEqual(first.items)
    expect(states).toEqual(['syncing'])
    gate.open()
    await settle()
    expect(states).toEqual(['syncing', 'synced'])
    expect(env.emitted.filter((e) => e === 'memlore:entries-changed')).toHaveLength(1)
    expect(env.drive.mutating()).toEqual([])
  })

  it('the revalidating pull still revokes a removed own slot: error, halted, locked', async () => {
    const env = await setup()
    startSyncSchedule()
    await settle()
    const journalId = await fixtureJournalId()
    const first = await listPaged(journalId)

    const slot = env.drive.find(['Memlore', '.meta', 'keyring', 'devices', `${OWN_ID}.json`])
    if (slot === undefined) throw new Error('no slot')
    env.drive.files = env.drive.files.filter((f) => f.id !== slot.id)

    const gate = new Gate()
    env.net.hold = gate
    const states = await reload(env)
    await settle()
    // The primed list still paints while the revocation check is in flight.
    const page = await listPaged(journalId)
    expect(page.items).toEqual(first.items)
    gate.open()
    await settle()
    expect(states).toEqual(['syncing', 'error'])
    expect(isUnlocked()).toBe(false)
    // Halted and locked: no retries, and reads now reject.
    await expect(listPaged(journalId)).rejects.toThrow('vault is locked')
    await settle()
    expect(states).toEqual(['syncing', 'error'])
  })

  it('an offline reload still paints the cached first page and lands on error', async () => {
    const env = await setup()
    startSyncSchedule()
    await settle()
    const journalId = await fixtureJournalId()
    const first = await listPaged(journalId)

    env.net.down = true
    const states = await reload(env)
    await settle()
    const page = await listPaged(journalId)
    expect(page.items).toEqual(first.items)
    expect(states).toEqual(['syncing', 'error'])
  })
})
