import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listen } from '../../tauri/event'
import { VaultLockedError } from '../keys'
import {
  MAX_BUDGET_BYTES,
  MIN_BUDGET_OVERRIDE_BYTES,
  configureEvictorEnv,
  getBudgetBytes,
  maybeEvict,
  setStatsListener,
  startEvictor,
} from '../storage/evictor'
import { CACHE_LIMIT_KEY, WRAPPED_MASTER_HEX_LEN, openWebDb, type WebDb } from '../storage/idb'
import {
  MEDIA_CACHE_STATS_EVENT,
  cacheHandlers,
  configureCacheEnv,
  installCacheStatsEmitter,
  type MediaCacheStats,
} from './cache'

const MB = 1024 * 1024
const NOW = 1_800_000_000_000
const DAY = 24 * 60 * 60 * 1000

let factory: IDBFactory
let db: WebDb
let locked: boolean
let quota: number | undefined

const call = <T>(name: string, args: Record<string, unknown> = {}) =>
  cacheHandlers[name](args) as Promise<T>

const bytes = (n: number) => new Uint8Array(n)

function wire(): void {
  configureCacheEnv({
    openDb: () => Promise.resolve(db),
    assertUnlocked: () => {
      if (locked) throw new VaultLockedError()
    },
  })
  configureEvictorEnv({
    now: () => NOW,
    estimate: () => Promise.resolve(quota === undefined ? undefined : { quota }),
    openDb: () => Promise.resolve(db),
  })
}

async function seed(): Promise<void> {
  await db.blobs.put({ path: 'media/m1', bytes: bytes(1000), size: 1000, lastAccess: NOW })
  await db.blobs.put({ path: 'media/m1.thumb', bytes: bytes(10), size: 10, lastAccess: NOW })
  await db.files.put({
    path: 'dev/entries/e1.bin',
    ciphertext: bytes(100),
    etag: null,
    modifiedTime: null,
    lastAccess: NOW,
    pinned: false,
  })
  await db.files.put({
    path: '.meta/_content.json',
    ciphertext: bytes(5),
    etag: null,
    modifiedTime: null,
    lastAccess: NOW,
    pinned: true,
  })
  await db.drafts.put({ entryId: 'd1', sealed: bytes(3), updatedAt: 1 })
  await db.device.put({
    deviceId: 'dev',
    wrappedMasterHex: 'ab'.repeat(WRAPPED_MASTER_HEX_LEN / 2 + 1),
    kekSaltHex: 'cd',
    recoveryGeneration: 0,
    masterFingerprint: 'fp',
    name: 'web',
  })
  await db.meta.put({ key: 'journal-seen:j1', value: '20:1:0' })
}

beforeEach(async () => {
  factory = new IDBFactory()
  db = await openWebDb({ factory })
  locked = false
  quota = 4000 * MB
  wire()
})

afterEach(() => {
  configureCacheEnv({})
  configureEvictorEnv({})
  setStatsListener(null)
  db.close()
})

describe('get_media_cache_stats', () => {
  it('reports usage across files and blobs and the effective budget', async () => {
    await seed()
    expect(await call('get_media_cache_stats')).toEqual({
      usedBytes: 1000 + 10 + 100 + 5,
      maxBytes: MAX_BUDGET_BYTES,
    })
  })

  it('shows the persisted limit while the evictor is not started, without changing its state', async () => {
    await db.meta.put({ key: CACHE_LIMIT_KEY, value: 100 * MB })
    expect((await call<MediaCacheStats>('get_media_cache_stats')).maxBytes).toBe(100 * MB)
    await db.meta.put({ key: CACHE_LIMIT_KEY, value: 70 * MB })
    expect((await call<MediaCacheStats>('get_media_cache_stats')).maxBytes).toBe(70 * MB) // no sticky state
  })

  it('is the quota cap when the quota is small', async () => {
    quota = 100 * MB
    wire()
    expect((await call<MediaCacheStats>('get_media_cache_stats')).maxBytes).toBe(50 * MB)
  })
})

describe('set_media_cache_limit', () => {
  it('lowers the budget, persists it and returns the new stats', async () => {
    const stats = await call<MediaCacheStats>('set_media_cache_limit', { bytes: 100 * MB })
    expect(stats.maxBytes).toBe(100 * MB)
    expect((await db.meta.get(CACHE_LIMIT_KEY))?.value).toBe(100 * MB)
  })

  it('is re-applied after a reload (new handlers over the same database)', async () => {
    await call('set_media_cache_limit', { bytes: 100 * MB })
    configureEvictorEnv({}) // drop the evictor instance: nothing is in memory any more
    wire()
    startEvictor() // on unlock the evictor re-reads the persisted limit
    await new Promise((r) => setTimeout(r, 20))
    expect((await call<MediaCacheStats>('get_media_cache_stats')).maxBytes).toBe(100 * MB)
  })

  it('does not set the limit on a stopped evictor when the vault locks during the write', async () => {
    const put = db.meta.put.bind(db.meta)
    db.meta.put = async (record) => {
      await put(record)
      locked = true // the lock lands between the persist and the in-memory limit
    }
    await expect(call('set_media_cache_limit', { bytes: 100 * MB })).rejects.toBeInstanceOf(
      VaultLockedError,
    )
    locked = false
    expect(await getBudgetBytes()).toBe(MAX_BUDGET_BYTES) // the evictor's own state is untouched
    // the stats display the persisted limit read-only, so the value is already right for the UI
    expect((await call<MediaCacheStats>('get_media_cache_stats')).maxBytes).toBe(100 * MB)
  })

  it('can lower but never raise the computed cap', async () => {
    quota = 200 * MB // cap 100 MB
    wire()
    const stats = await call<MediaCacheStats>('set_media_cache_limit', { bytes: 400 * MB })
    expect(stats.maxBytes).toBe(100 * MB)
    const tiny = await call<MediaCacheStats>('set_media_cache_limit', { bytes: 1 })
    expect(tiny.maxBytes).toBe(MIN_BUDGET_OVERRIDE_BYTES)
  })

  it('clamps a huge limit and rejects invalid input without touching the stored limit', async () => {
    const huge = await call<MediaCacheStats>('set_media_cache_limit', { bytes: 1e300 })
    expect(huge.maxBytes).toBe(MAX_BUDGET_BYTES)
    await call('set_media_cache_limit', { bytes: 100 * MB })
    for (const bad of [-1, Number.NaN, Infinity, '100', null, undefined, {}]) {
      await expect(
        call('set_media_cache_limit', { bytes: bad }),
        String(bad),
      ).rejects.toBeInstanceOf(TypeError)
    }
    expect((await db.meta.get(CACHE_LIMIT_KEY))?.value).toBe(100 * MB)
  })

  it('evicts immediately when the new budget is below usage', async () => {
    await db.blobs.put({
      path: 'media/big',
      bytes: bytes(60 * MB),
      size: 60 * MB,
      lastAccess: NOW,
    })
    const stats = await call<MediaCacheStats>('set_media_cache_limit', { bytes: 50 * MB })
    expect(stats.usedBytes).toBe(0)
  })
})

describe('clear_media_cache', () => {
  it('removes only the blobs and keeps every other store untouched', async () => {
    await seed()
    await db.meta.put({ key: CACHE_LIMIT_KEY, value: 100 * MB })
    const before = {
      files: await db.files.list(),
      drafts: await db.drafts.list(),
      device: await db.device.get(),
      meta: await db.meta.listByPrefix(''),
    }
    const stats = await call<MediaCacheStats>('clear_media_cache')
    expect(await db.blobs.listByLastAccess()).toEqual([])
    expect(stats.usedBytes).toBe(105)
    expect(await db.files.list()).toEqual(before.files)
    expect(await db.drafts.list()).toEqual(before.drafts)
    expect(await db.device.get()).toEqual(before.device)
    expect(await db.meta.listByPrefix('')).toEqual(before.meta)
  })
})

describe('locked', () => {
  it('rejects every handler and changes nothing', async () => {
    await seed()
    locked = true
    for (const name of Object.keys(cacheHandlers)) {
      await expect(call(name, { bytes: 1 * MB }), name).rejects.toBeInstanceOf(VaultLockedError)
    }
    expect(await db.blobs.listByLastAccess()).toHaveLength(2)
    expect(await db.meta.get(CACHE_LIMIT_KEY)).toBeUndefined()
  })
})

describe('media-cache:stats-changed', () => {
  async function collect(): Promise<{ events: MediaCacheStats[]; stop: () => void }> {
    const events: MediaCacheStats[] = []
    const stop = await listen<MediaCacheStats>(MEDIA_CACHE_STATS_EVENT, (e) =>
      events.push(e.payload),
    )
    return { events, stop }
  }
  const flush = () => new Promise((r) => setTimeout(r, 20))

  it('is emitted after a limit change and after a clear', async () => {
    await seed()
    const { events, stop } = await collect()
    await call('set_media_cache_limit', { bytes: 100 * MB })
    expect(events).toEqual([{ usedBytes: 1115, maxBytes: 100 * MB }])
    await call('clear_media_cache')
    expect(events).toHaveLength(2)
    expect(events[1]).toEqual({ usedBytes: 105, maxBytes: 100 * MB })
    stop()
  })

  it('is emitted after an eviction run and after a write-triggered run', async () => {
    installCacheStatsEmitter()
    await db.blobs.put({
      path: 'media/old',
      bytes: bytes(10),
      size: 10,
      lastAccess: NOW - 40 * DAY,
    })
    const { events, stop } = await collect()
    await maybeEvict('interval')
    await flush()
    expect(events).toEqual([{ usedBytes: 0, maxBytes: MAX_BUDGET_BYTES }])
    await maybeEvict('interval') // nothing evicted: no event
    await flush()
    expect(events).toHaveLength(1)
    await maybeEvict('write')
    await flush()
    expect(events).toHaveLength(2)
    stop()
  })
})
