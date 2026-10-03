import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Entry, SearchResult } from '../../../../src/types/entry'
import type { PagedResult } from '../../../../src/types/pagination'
import { loadCore, type Core } from '../../core/core'
import { DriveReader, DriveWriter } from '../drive/client'
import {
  FakeDrive,
  fakeLocks,
  fixtureBytes,
  loadDesktopFixture,
  seedFromFixture,
  violations,
  type DesktopFixture,
} from '../drive/fakeDrive'
import { configureKeysEnv, dispose, lock } from '../keys'
import { openWebDb, type WebDb } from '../storage/idb'
import { onboardComplete } from '../sync/onboard'
import { clearReonboardReason } from '../sync/pull'
import { entryHandlers } from './entries'
import { MediaCorruptError, TOUCH_INTERVAL_MS, configureMediaEnv, mediaHandlers } from './media'
import { configureReadEnv, createReadSession } from './readSession'
import { cancelSearchScan, searchHandlers, whenSearchScanSettled } from './search'
import { VaultLockedError } from '../keys'

const PASSWORD = '12345678'
const OWN_ID = 'cccccccc-1111-4222-8333-dddddddddddd'
const OTHER_DEVICE = 'dddddddd-2222-4333-8444-eeeeeeeeeeee'
const SHA1_NOTE = 'fixture is read-only'

interface FixtureMedia {
  media_id: string
  entry_index: number
  bytes_b64: string
  thumb_b64: string
}

let core: Core
let fixture: DesktopFixture
const media = (): FixtureMedia =>
  (fixture.expected as unknown as { media: FixtureMedia[] }).media[0]
const imageEntryId = (): string => fixture.expected.entries[media().entry_index].entry_id
const base = (): string => `generations/g-0/${fixture.device_id}`

const handlers = { ...entryHandlers, ...searchHandlers, ...mediaHandlers }
const call = <T>(name: string, args: Record<string, unknown> = {}): Promise<T> =>
  Promise.resolve(handlers[name](args)) as Promise<T>
const b64 = (bytes: number[]): string => Buffer.from(bytes).toString('base64')

interface Env {
  drive: FakeDrive
  db: WebDb
  clock: { now: number }
}

interface SetupOptions {
  /** Drop the fixture media files from the generation folder. */
  omitMedia?: boolean
  overrides?: Record<string, string | Uint8Array>
  /** Add a second desktop with a manifest (no entries) and this media folder content. */
  otherDeviceMedia?: Record<string, Uint8Array>
  /** Put the fixture media in the legacy flat `Memlore/<device>/media`. */
  legacyFlat?: boolean
}

async function setup(options: SetupOptions = {}): Promise<Env> {
  const drive = new FakeDrive()
  seedFromFixture(drive, fixture, {
    omit: options.omitMedia === true ? (p) => p.includes('/media/') : undefined,
    overrides: options.overrides,
  })
  if (options.legacyFlat === true) {
    const folder = drive.chain('Memlore', fixture.device_id, 'media')
    const path = `${base()}/media/${media().media_id}`
    drive.addFile(media().media_id, folder, fixtureBytes(fixture, path))
    drive.addFile(`${media().media_id}.thumb`, folder, fixtureBytes(fixture, `${path}.thumb`))
  }
  if (options.otherDeviceMedia !== undefined) {
    const folder = drive.chain('Memlore', 'generations', 'g-0', OTHER_DEVICE)
    drive.addFile(
      'metadata.json',
      folder,
      JSON.stringify({
        device_id: OTHER_DEVICE,
        recovery_generation: 0,
        entries: [],
        journals: [],
        chats_present: false,
        memory_present: false,
        generated_at: 1,
      }),
    )
    const mediaFolder = drive.chain('Memlore', 'generations', 'g-0', OTHER_DEVICE, 'media')
    for (const [name, bytes] of Object.entries(options.otherDeviceMedia)) {
      drive.addFile(name, mediaFolder, bytes)
    }
  }
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
  configureReadEnv({ session: async () => session, emit: () => undefined })
  const clock = { now: 1_000 }
  configureMediaEnv({ now: () => clock.now })
  return { drive, db, clock }
}

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

const downloads = (drive: FakeDrive): string[] =>
  drive.requests
    .filter((r) => r.method === 'GET' && r.url.searchParams.get('alt') === 'media')
    .map((r) => pathOf(drive, /\/files\/([^/]+)$/.exec(r.url.pathname)?.[1] ?? ''))

const mediaDownloads = (drive: FakeDrive): string[] =>
  downloads(drive).filter((p) => p.includes('/media/'))

const PAGE_ARGS = {
  sort: 'newest',
  range: 'all',
  fromTs: null,
  toTs: null,
  firstDayOfWeek: 1,
  lockedView: 'revealed',
  activeVaultId: null,
  lockFilter: 'all',
}

/** Loads the image entry the way the UI does before it asks for its media. */
const openImageEntry = (): Promise<Entry | null> => call('get_entry', { id: imageEntryId() })

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
  cancelSearchScan()
  configureReadEnv({})
  configureMediaEnv({})
  dispose()
  expect(violations, SHA1_NOTE).toEqual([])
})

describe('media with the desktop fixture', () => {
  it('fetches no media until read_media_* is called', async () => {
    const { drive } = await setup()
    await call<PagedResult<Entry>>('list_all_entries_paged', { ...PAGE_ARGS, page: 1 })
    await call<SearchResult[]>('search_entries', {
      query: 'golden',
      filters: undefined,
      lockedView: 'revealed',
      activeVaultId: null,
      mentionMode: true,
    })
    await whenSearchScanSettled()
    const entry = await openImageEntry()
    expect(entry?.media_count).toBe(1)
    await call('get_media_status', { mediaId: media().media_id })
    expect(mediaDownloads(drive)).toEqual([])
  })

  it('serves the thumbnail first and the full media only on demand, byte for byte', async () => {
    const { drive } = await setup()
    await openImageEntry()
    const thumb = await call<number[]>('read_media_thumbnail_bytes', {
      mediaId: media().media_id,
    })
    expect(b64(thumb)).toBe(media().thumb_b64)
    expect(mediaDownloads(drive)).toEqual([`${base()}/media/${media().media_id}.thumb`])

    const full = await call<number[]>('read_media_bytes', { mediaId: media().media_id })
    expect(b64(full)).toBe(media().bytes_b64)
    expect(mediaDownloads(drive)).toEqual([
      `${base()}/media/${media().media_id}.thumb`,
      `${base()}/media/${media().media_id}`,
    ])
  })

  it('stores only ciphertext in blobs and serves the second read from it', async () => {
    const { drive, db, clock } = await setup()
    await openImageEntry()
    await call('read_media_bytes', { mediaId: media().media_id })
    const sealed = fixtureBytes(fixture, `${base()}/media/${media().media_id}`)
    const stored = await db.blobs.listByLastAccess()
    expect(stored.map((b) => b.path)).toEqual([`media/${media().media_id}`])
    expect(stored[0].bytes).toEqual(sealed)
    expect(stored[0].lastAccess).toBe(1_000)
    const plain = Buffer.from(media().bytes_b64, 'base64')
    expect(Buffer.from(stored[0].bytes).includes(plain)).toBe(false)

    const before = drive.requests.length
    clock.now = 1_000 + TOUCH_INTERVAL_MS + 8_000
    const again = await call<number[]>('read_media_bytes', { mediaId: media().media_id })
    expect(b64(again)).toBe(media().bytes_b64)
    expect(drive.requests.length).toBe(before)
    expect((await db.blobs.get(`media/${media().media_id}`))?.lastAccess).toBe(clock.now)
  })

  it('reads the legacy flat device folder', async () => {
    const { drive } = await setup({ omitMedia: true, legacyFlat: true })
    await openImageEntry()
    const full = await call<number[]>('read_media_bytes', { mediaId: media().media_id })
    expect(b64(full)).toBe(media().bytes_b64)
    expect(mediaDownloads(drive)).toEqual([`${fixture.device_id}/media/${media().media_id}`])
  })

  it("falls back to another known device's media folder", async () => {
    const id = media().media_id
    const path = `${base()}/media/${id}`
    const { drive } = await setup({
      omitMedia: true,
      otherDeviceMedia: { [id]: fixtureBytes(fixture, path) },
    })
    await openImageEntry()
    const full = await call<number[]>('read_media_bytes', { mediaId: id })
    expect(b64(full)).toBe(media().bytes_b64)
    expect(mediaDownloads(drive)).toEqual([`generations/g-0/${OTHER_DEVICE}/media/${id}`])
  })

  it('rejects a tampered file with a typed error and does not cache it', async () => {
    const id = media().media_id
    const path = `${base()}/media/${id}`
    const tampered = fixtureBytes(fixture, path).slice()
    tampered[tampered.length - 1] ^= 0x01
    const { db } = await setup({ overrides: { [path]: tampered } })
    await openImageEntry()
    await expect(call('read_media_bytes', { mediaId: id })).rejects.toBeInstanceOf(
      MediaCorruptError,
    )
    expect(await db.blobs.listByLastAccess()).toEqual([])
  })

  it('rejects every handler once the vault is locked', async () => {
    const { drive } = await setup()
    await openImageEntry()
    lock('manual')
    drive.requests.length = 0
    for (const name of Object.keys(mediaHandlers)) {
      await expect(call(name, { mediaId: media().media_id }), name).rejects.toBeInstanceOf(
        VaultLockedError,
      )
    }
    expect(drive.requests).toEqual([])
  })

  it('reports an unknown media id as not found without a media request', async () => {
    const { drive } = await setup()
    await expect(
      call('read_media_bytes', { mediaId: '00000000-0000-4000-8000-000000000000' }),
    ).rejects.toThrow('Media not found')
    expect(mediaDownloads(drive)).toEqual([])
  })
})
