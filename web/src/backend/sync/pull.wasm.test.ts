import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadCore, type Core } from '../../core/core'
import { DriveReader, DriveWriter } from '../drive/client'
import {
  FOLDER,
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
} from '../drive/fakeDrive'
import { configureKeysEnv, dispose, isUnlocked } from '../keys'
import { openWebDb, type WebDb } from '../storage/idb'
import { FormatUnsupportedError, onboardComplete } from './onboard'
import {
  PullTransientError,
  ReonboardRequiredError,
  Puller,
  clearReonboardReason,
  createPuller,
  getReonboardReason,
  type Limiter,
} from './pull'

const PASSWORD = '12345678'
const OWN_ID = 'cccccccc-1111-4222-8333-dddddddddddd'
const OTHER_DEVICE = 'dddddddd-2222-4333-8444-eeeeeeeeeeee'
const NEWEST = 1791025173

let core: Core
let fixture: DesktopFixture

interface Env {
  drive: FakeDrive
  db: WebDb
  puller: Puller
  desktop: string
  net: { down: boolean; mediaInFlight: number; mediaPeak: number }
  limit?: Limiter
}

const manifestPath = (): string => `generations/g-0/${fixture.device_id}/metadata.json`

async function setup(seed: { omit?: (path: string) => boolean } = {}): Promise<Env> {
  const drive = new FakeDrive()
  seedFromFixture(drive, fixture, seed)
  const net = { down: false, mediaInFlight: 0, mediaPeak: 0 }
  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    if (net.down) throw new TypeError('network down')
    const isMedia = input.includes('alt=media')
    if (!isMedia) return drive.fetch(input, init)
    net.mediaInFlight += 1
    net.mediaPeak = Math.max(net.mediaPeak, net.mediaInFlight)
    try {
      await new Promise((resolve) => setTimeout(resolve, 2))
      return await drive.fetch(input, init)
    } finally {
      net.mediaInFlight -= 1
    }
  }
  const driveDeps = {
    getToken: async () => 'tok',
    fetchImpl,
    sleep: async () => {},
    locks: fakeLocks(drive),
  }
  const reader = new DriveReader(driveDeps)
  const writer = new DriveWriter(reader, driveDeps)
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
  const puller = createPuller({ reader, db, core, now: () => 1_800_000_000_000 })
  return { drive, db, puller, desktop: fixture.device_id, net }
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

/** Memlore-relative paths of every file body downloaded (alt=media GETs), in order. */
function downloads(drive: FakeDrive): string[] {
  return drive.requests
    .filter((r) => r.method === 'GET' && r.url.searchParams.get('alt') === 'media')
    .map((r) => pathOf(drive, /\/files\/([^/]+)$/.exec(r.url.pathname)?.[1] ?? ''))
}

const entryDownloads = (drive: FakeDrive): string[] =>
  downloads(drive).filter((p) => /\/entries\/[^/]+\.bin$/.test(p))

function patchFile(drive: FakeDrive, path: string[], change: (v: Record<string, unknown>) => void) {
  const file = drive.find(['Memlore', ...path])
  if (!file) throw new Error(`no such file ${path.join('/')}`)
  const value = JSON.parse(text(file.content)) as Record<string, unknown>
  change(value)
  file.content = bytes(JSON.stringify(value))
}

function patchManifest(
  drive: FakeDrive,
  device: string,
  change: (v: Record<string, unknown>) => void,
) {
  patchFile(drive, ['generations', 'g-0', device, 'metadata.json'], change)
}

type Row = { entry_id: string; updated_at: number; is_deleted: boolean; local_version: number }

/** A second desktop folder with a manifest and a copy of one fixture entry file. */
function addSecondDevice(drive: FakeDrive, rows: Row[], entryFileFrom?: string): string {
  const folder = drive.chain('Memlore', 'generations', 'g-0', OTHER_DEVICE)
  drive.addFile(
    'metadata.json',
    folder,
    JSON.stringify({
      device_id: OTHER_DEVICE,
      recovery_generation: 0,
      entries: rows,
      journals: [],
      chats_present: false,
      memory_present: false,
      generated_at: NEWEST,
    }),
  )
  if (entryFileFrom !== undefined) {
    const entries = drive.chain('Memlore', 'generations', 'g-0', OTHER_DEVICE, 'entries')
    for (const row of rows) {
      drive.addFile(
        `${row.entry_id}.bin`,
        entries,
        fixtureBytes(fixture, `generations/g-0/${fixture.device_id}/entries/${entryFileFrom}.bin`),
      )
    }
  }
  return folder
}

function snapshot(drive: FakeDrive): string {
  return JSON.stringify(
    drive.files.map((f) => [f.id, f.name, f.parents, f.version, Array.from(f.content)]),
  )
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
  expect(violations).toEqual([])
})

describe('warmStart', () => {
  it('fetches exactly the 5 newest entry payloads and zero media, with no writes', async () => {
    const env = await setup()
    const before = snapshot(env.drive)
    const ids = await env.puller.warmStart()
    expect(ids).toHaveLength(5)
    const newest = new Set(
      [...(env.puller.index ?? new Map()).values()]
        .filter((e) => e.updatedAt === NEWEST)
        .map((e) => e.entryId),
    )
    expect(new Set(ids)).toEqual(newest)
    const entries = entryDownloads(env.drive)
    expect(entries).toHaveLength(5)
    expect(new Set(entries).size).toBe(5)
    expect(downloads(env.drive).filter((p) => p.includes('/media/'))).toEqual([])
    expect(env.drive.mutating()).toEqual([])
    expect(snapshot(env.drive)).toBe(before)
    // cached, so a second warmStart downloads no entry again
    env.drive.requests.length = 0
    await env.puller.warmStart()
    expect(entryDownloads(env.drive)).toEqual([])
  })

  it('excludes tombstones from warmStart but keeps them in the index', async () => {
    const env = await setup()
    const victim = fixture.expected.entries[0].entry_id
    patchManifest(env.drive, env.desktop, (m) => {
      for (const e of m.entries as Row[]) {
        if (e.entry_id === victim) {
          e.is_deleted = true
          e.updated_at = NEWEST + 100
        }
      }
    })
    const ids = await env.puller.warmStart()
    expect(ids).not.toContain(victim)
    expect(ids).toHaveLength(5)
    expect(env.puller.index?.get(victim)).toMatchObject({
      isDeleted: true,
      updatedAt: NEWEST + 100,
    })
    expect(entryDownloads(env.drive).some((p) => p.includes(victim))).toBe(false)
  })
})

describe('refresh', () => {
  it('caches manifests, acks, journals, tags and templates; never settings or media', async () => {
    const env = await setup()
    const folder = env.drive.find(['Memlore', 'generations', 'g-0', env.desktop])
    if (!folder) throw new Error('no desktop folder')
    env.drive.addFile('outbox-acks.bin', folder.id, 'ACKS')
    const result = await env.puller.refresh()
    expect(result.devices).toEqual([env.desktop])
    expect(result.stale).toHaveLength(7)
    const cached = (await env.db.files.list()).map((f) => f.path).sort()
    expect(cached).toEqual(
      [
        `${env.desktop}/metadata.json`,
        `${env.desktop}/outbox-acks.bin`,
        `${env.desktop}/tags.bin`,
        `${env.desktop}/templates.bin`,
        `${env.desktop}/journals/4fd64221-d0eb-4bc0-84c9-810bce934d16.bin`,
        `${env.desktop}/journals/efd3b558-3fa2-4b35-b31d-e16a918e98cc.bin`,
        '.meta/keyring/_content.json',
      ].sort(),
    )
    expect(
      downloads(env.drive).some((p) => p.includes('settings.bin') || p.includes('/media/')),
    ).toBe(false)
    expect(env.drive.mutating()).toEqual([])
  })

  it('computes the stale set against the cached manifest and drops stale entry ciphertext', async () => {
    const env = await setup()
    const [changed] = await env.puller.warmStart()
    const cachedPath = `${env.desktop}/entries/${changed}.bin`
    expect(await env.db.files.get(cachedPath)).toBeDefined()
    expect((await env.puller.refresh()).stale).toEqual([])
    patchManifest(env.drive, env.desktop, (m) => {
      for (const e of m.entries as Row[]) if (e.entry_id === changed) e.updated_at = NEWEST + 5
    })
    expect((await env.puller.refresh()).stale).toEqual([changed])
    expect(await env.db.files.get(cachedPath)).toBeUndefined()
  })

  it('skips the web own folder (no manifest) and a device without a manifest', async () => {
    const env = await setup()
    env.drive.chain('Memlore', 'generations', 'g-0', OWN_ID, 'outbox')
    env.drive.chain('Memlore', 'generations', 'g-0', OTHER_DEVICE)
    const result = await env.puller.refresh()
    expect(result.devices).toEqual([env.desktop])
    expect(result.warnings).toEqual([])
    expect(env.drive.mutating()).toEqual([])
  })

  it('lists the entries of a vault with only legacy flat device folders', async () => {
    const env = await setup()
    const memlore = env.drive.find(['Memlore'])
    const deviceFolder = env.drive.find(['Memlore', 'generations', 'g-0', env.desktop])
    if (!memlore || !deviceFolder) throw new Error('layout')
    deviceFolder.parents = [memlore.id]
    const ids = await env.puller.warmStart()
    expect(ids).toHaveLength(5)
    expect(env.puller.index?.size).toBe(7)
    expect(entryDownloads(env.drive)).toHaveLength(5)
    expect(env.drive.mutating()).toEqual([])
  })

  it('picks the newest updated_at across two devices', async () => {
    const env = await setup()
    const [first, second] = fixture.expected.entries
    addSecondDevice(
      env.drive,
      [
        { entry_id: first.entry_id, updated_at: NEWEST + 50, is_deleted: false, local_version: 9 },
        { entry_id: second.entry_id, updated_at: 5, is_deleted: false, local_version: 1 },
      ],
      first.entry_id,
    )
    await env.puller.refresh()
    expect(env.puller.index?.get(first.entry_id)).toMatchObject({ authorDevice: OTHER_DEVICE })
    expect(env.puller.index?.get(second.entry_id)?.authorDevice).toBe(env.desktop)
    await env.puller.fetchEntries([first.entry_id])
    expect(entryDownloads(env.drive)).toEqual([
      `generations/g-0/${OTHER_DEVICE}/entries/${first.entry_id}.bin`,
    ])
  })
})

describe('fetchEntries', () => {
  it('downloads one id once when requested concurrently', async () => {
    const env = await setup()
    await env.puller.refresh()
    const id = fixture.expected.entries[0].entry_id
    const [a, b] = await Promise.all([
      env.puller.fetchEntries([id]),
      env.puller.fetchEntries([id, id]),
    ])
    expect(entryDownloads(env.drive)).toHaveLength(1)
    expect(a.get(id)).toEqual(b.get(id))
    expect(a.get(id)?.length).toBeGreaterThan(0)
  })

  it('never has more than 4 downloads in flight', async () => {
    const env = await setup()
    await env.puller.refresh()
    const all = fixture.expected.entries.map((e) => e.entry_id)
    const got = await env.puller.fetchEntries(all)
    expect(got.size).toBe(7)
    expect(env.net.mediaPeak).toBeGreaterThan(1)
    expect(env.net.mediaPeak).toBeLessThanOrEqual(4)
  })

  it('omits unknown ids and requires a prior refresh', async () => {
    const env = await setup()
    await expect(env.puller.fetchEntries(['x'])).rejects.toThrow('refresh')
    await env.puller.refresh()
    expect((await env.puller.fetchEntries(['not-an-entry'])).size).toBe(0)
  })
})

describe('authority checks', () => {
  async function seedCache(env: Env): Promise<void> {
    await env.puller.warmStart()
    await env.db.drafts.put({ entryId: 'draft-1', sealed: new Uint8Array([1, 2, 3]), updatedAt: 1 })
    await env.db.meta.put({ key: 'k', value: 'v' })
  }

  async function expectDropped(env: Env, reason: string): Promise<void> {
    await expect(env.puller.refresh()).rejects.toMatchObject({
      name: 'ReonboardRequiredError',
      reason,
    })
    expect(await env.db.files.list()).toEqual([])
    expect(await env.db.meta.get('k')).toBeUndefined()
    expect(await env.db.drafts.get('draft-1')).toBeDefined()
    expect((await env.db.device.get())?.deviceId).toBe(OWN_ID)
    expect(isUnlocked()).toBe(false)
    expect(getReonboardReason()).toBe(reason)
    expect(env.puller.index).toBeNull()
    expect(env.drive.mutating()).toEqual([])
  }

  it('a listed-and-missing own slot drops ciphertext and locks, keeping drafts and the device', async () => {
    const env = await setup()
    await seedCache(env)
    const slot = env.drive.find(['Memlore', '.meta', 'keyring', 'devices', `${OWN_ID}.json`])
    if (!slot) throw new Error('no slot')
    env.drive.files = env.drive.files.filter((f) => f.id !== slot.id)
    await expectDropped(env, 'slot-missing')
  })

  it('a recovery generation change drops ciphertext and routes to onboarding', async () => {
    const env = await setup()
    await seedCache(env)
    patchFile(env.drive, ['.meta', 'control.json'], (v) => {
      v.recovery_generation = 1
    })
    await expectDropped(env, 'generation-changed')
  })

  it('a master fingerprint change drops ciphertext and routes to onboarding', async () => {
    const env = await setup()
    await seedCache(env)
    patchFile(env.drive, ['.meta', 'keyring', '_meta.json'], (v) => {
      v.master_fingerprint = 'ab'.repeat(32)
    })
    await expectDropped(env, 'fingerprint-changed')
  })

  for (const failure of ['503', '401', 'network'] as const) {
    it(`a ${failure} on the slot listing is transient: nothing dropped, still unlocked`, async () => {
      const env = await setup()
      await seedCache(env)
      const devices = env.drive.find(['Memlore', '.meta', 'keyring', 'devices'])
      if (!devices) throw new Error('no devices folder')
      const before = (await env.db.files.list()).length
      if (failure === 'network') {
        env.net.down = true
      } else {
        env.drive.interceptors.push((req) =>
          (req.url.searchParams.get('q') ?? '').includes(`'${devices.id}' in parents`)
            ? json({ error: 'x' }, Number(failure))
            : undefined,
        )
      }
      await expect(env.puller.refresh()).rejects.toBeInstanceOf(PullTransientError)
      expect((await env.db.files.list()).length).toBe(before)
      expect(await env.db.drafts.get('draft-1')).toBeDefined()
      expect(await env.db.meta.get('k')).toBeDefined()
      expect(isUnlocked()).toBe(true)
      expect(getReonboardReason()).toBeNull()
      expect(env.puller.index).not.toBeNull()
      expect(env.drive.mutating()).toEqual([])
    })
  }

  it('a missing devices folder is not proof the slot is gone', async () => {
    const env = await setup()
    await seedCache(env)
    const devices = env.drive.find(['Memlore', '.meta', 'keyring', 'devices'])
    env.drive.files = env.drive.files.filter(
      (f) => f.id !== devices?.id && f.parents[0] !== devices?.id,
    )
    await expect(env.puller.refresh()).rejects.toBeInstanceOf(PullTransientError)
    expect(isUnlocked()).toBe(true)
    expect((await env.db.files.list()).length).toBeGreaterThan(0)
  })

  it('an unknown control or keyring version aborts as incompatible without dropping', async () => {
    for (const path of [
      ['.meta', 'control.json'],
      ['.meta', 'keyring', '_meta.json'],
    ]) {
      const env = await setup()
      await seedCache(env)
      patchFile(env.drive, path, (v) => {
        v.version = 99
      })
      await expect(env.puller.refresh()).rejects.toBeInstanceOf(FormatUnsupportedError)
      expect((await env.db.files.list()).length).toBeGreaterThan(0)
      expect(await env.db.drafts.get('draft-1')).toBeDefined()
      expect(isUnlocked()).toBe(true)
      expect(getReonboardReason()).toBeNull()
      dispose()
    }
  })

  it('an unknown manifest schema_version aborts as incompatible without dropping', async () => {
    const env = await setup()
    await seedCache(env)
    patchManifest(env.drive, env.desktop, (m) => {
      m.schema_version = 99
    })
    await expect(env.puller.refresh()).rejects.toBeInstanceOf(FormatUnsupportedError)
    expect((await env.db.files.list()).length).toBeGreaterThan(0)
    expect(isUnlocked()).toBe(true)
  })

  it('a transient manifest read error aborts the pull (no partial index) without dropping', async () => {
    const env = await setup()
    await env.puller.refresh()
    const manifest = env.drive.find(['Memlore', ...manifestPath().split('/')])
    env.drive.interceptors.push((req) =>
      req.url.pathname === `/drive/v3/files/${manifest?.id}` &&
      req.url.searchParams.get('alt') === 'media'
        ? json({ error: 'x' }, 503)
        : undefined,
    )
    await expect(env.puller.refresh()).rejects.toBeInstanceOf(PullTransientError)
    expect(env.puller.index?.size).toBe(7)
    expect(isUnlocked()).toBe(true)
  })

  it('refresh never creates the slot folder or file (zero mutating requests)', async () => {
    const env = await setup()
    await env.puller.refresh()
    await env.puller.warmStart()
    expect(env.drive.mutating()).toEqual([])
    expect(env.drive.files.some((f) => f.mimeType === FOLDER && f.name === 'outbox')).toBe(false)
  })
})

describe('no-op sanity', () => {
  it('a fixture entry file is unchanged by pulling', async () => {
    const env = await setup()
    const id = fixture.expected.entries[0].entry_id
    await env.puller.refresh()
    const got = await env.puller.fetchEntries([id])
    expect(Array.from(got.get(id) ?? [])).toEqual(
      Array.from(fixtureBytes(fixture, `generations/g-0/${env.desktop}/entries/${id}.bin`)),
    )
    expect(ReonboardRequiredError).toBeDefined()
  })
})

describe('untrusted manifest content', () => {
  const POISON = ['a/b', '.hidden', 'q"uote', '__proto__', 'with space', '../x']

  it('drops rows with an unsafe id or an absurd timestamp; warmStart, ready and list still work', async () => {
    const env = await setup()
    patchManifest(env.drive, env.desktop, (m) => {
      const rows = m.entries as Row[]
      for (const id of POISON) {
        rows.push({ entry_id: id, updated_at: NEWEST + 100, is_deleted: false, local_version: 1 })
      }
      rows.push({ entry_id: 'huge-time', updated_at: 9e15, is_deleted: false, local_version: 1 })
    })
    const result = await env.puller.refresh()
    expect(result.warnings).toEqual([
      `${env.desktop}: ${POISON.length + 1} manifest row(s) with an unsafe id or time ignored`,
    ])
    expect(env.puller.index?.size).toBe(7)
    for (const id of [...POISON, 'huge-time']) expect(env.puller.index?.has(id)).toBe(false)
    const ids = await env.puller.warmStart()
    expect(ids).toHaveLength(5)
    expect(env.drive.mutating()).toEqual([])
  })

  it('a path error for one id omits it and never rejects the batch', async () => {
    const env = await setup()
    await env.puller.refresh()
    const [bad, good] = fixture.expected.entries.map((e) => e.entry_id)
    const real = DriveReader.prototype.readDeviceFile
    const spy = vi.spyOn(DriveReader.prototype, 'readDeviceFile').mockImplementation(function (
      this: DriveReader,
      generation,
      path,
    ) {
      if (path.includes(bad)) throw new RangeError('invalid logical path')
      return real.call(this, generation, path)
    })
    try {
      const got = await env.puller.fetchEntries([bad, good])
      expect([...got.keys()]).toEqual([good])
    } finally {
      spy.mockRestore()
    }
  })
})

describe('refresh hardening', () => {
  it('keeps the cached manifest of a listed device whose manifest vanished or broke', async () => {
    const env = await setup()
    const folder = addSecondDevice(env.drive, [
      { entry_id: 'second-entry', updated_at: NEWEST + 50, is_deleted: false, local_version: 1 },
    ])
    await env.puller.refresh()
    expect(env.puller.index?.has('second-entry')).toBe(true)
    const manifest = env.drive.files.find(
      (f) => f.parents[0] === folder && f.name === 'metadata.json',
    )
    if (!manifest) throw new Error('no second manifest')

    manifest.content = bytes('not json')
    manifest.version += 1
    let result = await env.puller.refresh()
    expect(env.puller.index?.has('second-entry')).toBe(true)
    expect(result.warnings.some((w) => w.includes('using the cached copy'))).toBe(true)

    env.drive.files = env.drive.files.filter((f) => f.id !== manifest.id)
    result = await env.puller.refresh()
    expect(env.puller.index?.has('second-entry')).toBe(true)
    expect(result.warnings).toContain(
      `${OTHER_DEVICE}: manifest unavailable, using the cached copy`,
    )
  })

  it('a refresh on a locked session makes no request', async () => {
    const env = await setup()
    dispose()
    await expect(env.puller.refresh()).rejects.toMatchObject({ name: 'VaultLockedError' })
    expect(env.drive.requests).toEqual([])
  })

  it('still raises ReonboardRequiredError when dropping the cache fails, keeping the cause', async () => {
    const env = await setup()
    await env.puller.warmStart()
    patchFile(env.drive, ['.meta', 'control.json'], (v) => {
      v.recovery_generation = 1
    })
    const boom = new Error('disk full')
    vi.spyOn(env.db, 'clearCache').mockRejectedValue(boom)
    const error = await env.puller.refresh().then(
      () => null,
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(ReonboardRequiredError)
    expect((error as Error).cause).toBe(boom)
    expect(isUnlocked()).toBe(false)
    expect(getReonboardReason()).toBe('generation-changed')
  })

  it('a download that finishes after a revoke does not re-cache ciphertext', async () => {
    const env = await setup()
    await env.puller.refresh()
    const id = fixture.expected.entries[0].entry_id
    let open: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      open = resolve
    })
    const real = DriveReader.prototype.readDeviceFile
    const spy = vi
      .spyOn(DriveReader.prototype, 'readDeviceFile')
      .mockImplementation(async function (this: DriveReader, generation, path) {
        if (path.includes(`/entries/${id}.bin`)) await gate
        return real.call(this, generation, path)
      })
    try {
      const pending = env.puller.fetchEntries([id])
      await new Promise((resolve) => setTimeout(resolve, 5))
      patchFile(env.drive, ['.meta', 'control.json'], (v) => {
        v.recovery_generation = 1
      })
      await expect(env.puller.refresh()).rejects.toBeInstanceOf(ReonboardRequiredError)
      open()
      await pending
      expect(await env.db.files.list()).toEqual([])
    } finally {
      spy.mockRestore()
    }
  })
})
