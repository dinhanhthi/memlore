import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { loadCore, type Core } from '../../core/core'
import {
  FakeDrive,
  fakeLocks,
  fixtureBytes,
  json,
  loadDesktopFixture,
  seedFromFixture,
  violations,
  type DesktopFixture,
} from '../drive/fakeDrive'
import { ReauthRequiredError } from '../drive/oauth'
import { configureKeysEnv, dispose, getKeyRing, isUnlocked } from '../keys'
import { route } from '../router'
import { openWebDb, type WebDb } from '../storage/idb'
import { configureAuthEnv, resetAuthState } from './auth'

const PASSWORD = '12345678'
const CONTENT = '.meta/keyring/_content.json'

let core: Core
let fixture: DesktopFixture
let drive: FakeDrive
let db: WebDb
let events: string[]
let offline: boolean

const entryPath = (id: string): string =>
  `generations/g-${fixture.generation}/${fixture.device_id}/entries/${id}.bin`

function expectOpensFixtureEntries(): void {
  for (const e of fixture.expected.entries) {
    const opened = core.openEntry(getKeyRing(), fixtureBytes(fixture, entryPath(e.entry_id)))
    expect((JSON.parse(opened.metadataJson) as { title: string }).title).toBe(e.title)
  }
}

/** Connect, validate and onboard against the fixture-seeded fake Drive, then lock. */
async function onboardThenLock(): Promise<void> {
  const begin = (await route('gdrive_begin_connect')) as { sessionId: string }
  await expect(
    route('gdrive_complete_connect', { sessionId: begin.sessionId, password: '' }),
  ).resolves.toEqual({ outcome: 'needs_onboarding' })
  const phrase = fixture.recovery_phrase
  await route('onboard_validate_passphrase', { mnemonic: phrase, sessionId: begin.sessionId })
  await route('onboard_complete', {
    mnemonic: phrase,
    newLocalPassword: PASSWORD,
    deviceName: 'Web',
    sessionId: begin.sessionId,
    unlockMethod: 'password',
  })
  expect(isUnlocked()).toBe(true)
  await route('lock_encryption')
  expect(isUnlocked()).toBe(false)
}

beforeAll(async () => {
  core = await loadCore()
  fixture = loadDesktopFixture()
})

beforeEach(async () => {
  violations.length = 0
  events = []
  offline = false
  drive = new FakeDrive()
  seedFromFixture(drive, fixture)
  db = await openWebDb({ factory: new IDBFactory() })
  configureKeysEnv({
    setTimeout: () => 0,
    clearTimeout: () => {},
    emit: (event) => events.push(event),
    document: null,
    window: null,
  })
  configureAuthEnv({
    sleep: async () => {},
    emit: (event) => events.push(event),
    openDb: async () => db,
    loadCore: async () => core,
    oauth: { connect: async () => undefined, getAccessToken: async () => 'tok' },
    driveDeps: () => ({
      getToken: async () => {
        if (offline) throw new ReauthRequiredError()
        return 'tok'
      },
      fetchImpl: drive.fetch,
      sleep: async () => {},
      locks: fakeLocks(drive),
    }),
    onboardDeps: { persist: async () => true },
  })
})

afterEach(() => {
  dispose()
  resetAuthState()
  configureAuthEnv({})
  expect(violations).toEqual([])
})

describe('onboard, reload, unlock (real WASM, desktop fixture)', () => {
  it('starts unset, then onboards, and the device record switches the modes', async () => {
    await expect(route('get_encryption_mode')).resolves.toBe('unset')
    await onboardThenLock()
    await expect(route('get_encryption_mode')).resolves.toBe('password')
    await expect(route('get_startup_mode')).resolves.toBe('password_locked')
    expect(events).toContain('app:unlocked')
    expect(events).toContain('app:locked')
  })

  it('unlocks with the web password using the content list from the Drive', async () => {
    await onboardThenLock()
    await route('initialize_encryption', { password: PASSWORD })
    expect(isUnlocked()).toBe(true)
    expectOpensFixtureEntries()
  })

  it('unlocks offline from the content list cached at onboarding (a reload)', async () => {
    await onboardThenLock()
    offline = true
    await route('initialize_encryption', { password: PASSWORD })
    expect(isUnlocked()).toBe(true)
    expectOpensFixtureEntries()
  })

  it('a transient Drive error with the cache gone fails instead of opening a master-only ring', async () => {
    await onboardThenLock()
    await db.files.delete(CONTENT)
    drive.interceptors.push(() => json({ error: 'x' }, 503))
    await expect(route('initialize_encryption', { password: PASSWORD })).rejects.toThrow(
      /please retry/,
    )
    expect(isUnlocked()).toBe(false)
  })

  it('rejects a wrong password and leaves the vault locked', async () => {
    await onboardThenLock()
    await expect(route('initialize_encryption', { password: 'wrong-password' })).rejects.toThrow(
      'Invalid password',
    )
    expect(isUnlocked()).toBe(false)
  })

  it('writes only the device slot on the Drive across onboard + unlock', async () => {
    await onboardThenLock()
    await route('initialize_encryption', { password: PASSWORD })
    const writes = drive.mutating()
    expect(writes).toHaveLength(1)
    expect(writes[0].method).toBe('POST')
  })
})
