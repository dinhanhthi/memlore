import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
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
import { configureKeysEnv, dispose } from '../keys'
import { openWebDb } from '../storage/idb'
import { onboardComplete } from '../sync/onboard'
import { clearReonboardReason } from '../sync/pull'
import { configureReadEnv, createReadSession } from './readSession'
import { configureSyncEnv, startSyncSchedule, stopSyncSchedule, syncHandlers } from './sync'

const PASSWORD = '12345678'
const OWN_ID = 'cccccccc-1111-4222-8333-dddddddddddd'

let core: Core
let fixture: DesktopFixture

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
  drive.requests.length = 0
  const session = await createReadSession({ db, reader, core })
  const emitted: string[] = []
  configureReadEnv({
    session: async () => session,
    emit: (event) => {
      emitted.push(event)
    },
  })
  return { drive, emitted }
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
