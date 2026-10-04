import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  DB_NAME,
  CACHE_LIMIT_KEY,
  JOURNAL_SEEN_PREFIX,
  StorageQuotaError,
  StorageUnavailableError,
  WRAPPED_MASTER_HEX_LEN,
  assertDeviceRecord,
  openWebDb,
  type DeviceRecord,
  type WebDb,
} from './idb'

const MARKER = 'PLAINTEXT-MARKER-journal-secret'
const STORES = ['files', 'drafts', 'device', 'blobs', 'meta']

const device = (over: Partial<Record<keyof DeviceRecord, unknown>> = {}): DeviceRecord =>
  ({
    deviceId: 'web-1234',
    wrappedMasterHex: 'ab'.repeat(WRAPPED_MASTER_HEX_LEN / 2),
    kekSaltHex: 'cd'.repeat(16),
    recoveryGeneration: 1,
    masterFingerprint: 'fp-1',
    name: 'Memlore Web (Chrome)',
    ...over,
  }) as DeviceRecord

const bytes = (n: number, fill = 7) => new Uint8Array(n).fill(fill)

let factory: IDBFactory
let db: WebDb

beforeEach(async () => {
  factory = new IDBFactory()
  db = await openWebDb({ factory })
})

describe('openWebDb', () => {
  it('creates the five stores at v1', async () => {
    db.close()
    const raw = await rawOpen()
    expect(raw.version).toBe(1)
    expect([...raw.objectStoreNames].sort()).toEqual([...STORES].sort())
    raw.close()
  })

  it('reports unavailable IndexedDB', async () => {
    const broken = {
      open: () => {
        throw new Error('denied')
      },
    } as unknown as IDBFactory
    await expect(openWebDb({ factory: broken })).rejects.toBeInstanceOf(StorageUnavailableError)
  })

  it('closes on versionchange so another tab can upgrade', async () => {
    let fired = false
    db.close()
    db = await openWebDb({ factory, onVersionChange: () => (fired = true) })
    const upgraded = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = factory.open(DB_NAME, 2)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    expect(fired).toBe(true)
    upgraded.close()
  })
})

describe('files', () => {
  it('round-trips, lists, touches and deletes', async () => {
    const rec = {
      path: 'a/b',
      ciphertext: bytes(4),
      etag: 'e',
      modifiedTime: 't',
      lastAccess: 1,
      pinned: false,
    }
    await db.files.put(rec)
    expect(await db.files.get('a/b')).toEqual(rec)
    expect(await db.files.touch('a/b', 99)).toBe(true)
    expect((await db.files.get('a/b'))?.lastAccess).toBe(99)
    expect(await db.files.touch('missing')).toBe(false)
    expect(await db.files.list()).toHaveLength(1)
    await db.files.delete('a/b')
    expect(await db.files.get('a/b')).toBeUndefined()
  })
})

describe('blobs', () => {
  it('touch bumps lastAccess and keeps the bytes; a missing blob resolves false', async () => {
    await db.blobs.put({ path: 'x', bytes: bytes(10), size: 10, lastAccess: 5 })
    expect(await db.blobs.touch('x', 99)).toBe(true)
    const rec = await db.blobs.get('x')
    expect(rec).toEqual({ path: 'x', bytes: bytes(10), size: 10, lastAccess: 99 })
    expect(await db.blobs.touch('missing')).toBe(false)
  })

  it('sums size and lists oldest access first', async () => {
    await db.blobs.put({ path: 'x', bytes: bytes(10), size: 10, lastAccess: 5 })
    await db.blobs.put({ path: 'y', bytes: bytes(20), size: 20, lastAccess: 1 })
    expect(await db.blobs.totalSize()).toBe(30)
    expect((await db.blobs.listByLastAccess()).map((b) => b.path)).toEqual(['y', 'x'])
    await db.blobs.delete('y')
    expect(await db.blobs.totalSize()).toBe(10)
  })
})

describe('drafts and meta', () => {
  it('round-trips sealed drafts and meta', async () => {
    await db.drafts.put({ entryId: 'e1', sealed: bytes(8), updatedAt: 1 })
    expect(await db.drafts.list()).toHaveLength(1)
    expect((await db.drafts.get('e1'))?.sealed).toEqual(bytes(8))
    await db.drafts.delete('e1')
    expect(await db.drafts.get('e1')).toBeUndefined()
    await db.meta.put({ key: 'cacheBytes', value: 5 })
    expect(await db.meta.get('cacheBytes')).toEqual({ key: 'cacheBytes', value: 5 })
  })
})

describe('device', () => {
  it('stores a single wrapped record and clears it', async () => {
    expect(await db.device.get()).toBeUndefined()
    await db.device.put(device())
    expect(await db.device.get()).toEqual(device())
    await db.device.clear()
    expect(await db.device.get()).toBeUndefined()
  })

  it('refuses a raw 32-byte master key hex', async () => {
    const raw = device({ wrappedMasterHex: 'ab'.repeat(32) })
    expect(() => assertDeviceRecord(raw)).toThrow(/raw/)
    await expect(Promise.resolve().then(() => db.device.put(raw))).rejects.toThrow(/raw/)
    expect(await db.device.get()).toBeUndefined()
  })

  it('refuses unknown fields and wrong shapes', () => {
    expect(() => assertDeviceRecord({ ...device(), masterKey: 'ab'.repeat(32) })).toThrow(
      /unknown field/,
    )
    expect(() => assertDeviceRecord(device({ wrappedMasterHex: 'zz'.repeat(70) }))).toThrow(/hex/)
    expect(() => assertDeviceRecord(device({ wrappedMasterHex: 'ab'.repeat(10) }))).toThrow(
      /shorter/,
    )
    expect(() => assertDeviceRecord(device({ recoveryGeneration: '1' }))).toThrow(/integer/)
    expect(() => assertDeviceRecord(device({ nextChangeSeq: 0 }))).toThrow(/positive integer/)
    expect(() => assertDeviceRecord(device({ nextChangeSeq: -5 }))).toThrow(/positive integer/)
    expect(() => assertDeviceRecord(device({ nextChangeSeq: 1.5 }))).toThrow(/positive integer/)
    expect(() => assertDeviceRecord(device({ nextChangeSeq: '1' }))).toThrow(/positive integer/)
    expect(() => assertDeviceRecord(device({ nextChangeSeq: 1 }))).not.toThrow()
    expect(() => assertDeviceRecord(null)).toThrow(/object/)
  })

  it('allocates monotonically increasing change_seq starting at 1', async () => {
    await db.device.put(device())
    const seq1 = await db.device.allocateChangeSeq()
    expect(seq1).toBe(1)
    const seq2 = await db.device.allocateChangeSeq()
    expect(seq2).toBe(2)
    const rec = await db.device.get()
    expect(rec?.nextChangeSeq).toBe(3)

    // Survives clearCache
    await db.clearCache()
    const seq3 = await db.device.allocateChangeSeq()
    expect(seq3).toBe(3)
  })

  it('allocateChangeSeq throws when device record is missing', async () => {
    await expect(db.device.allocateChangeSeq()).rejects.toThrow(/Device record missing/)
  })
})

describe('clearCache / clearAll', () => {
  beforeEach(async () => {
    await db.files.put({
      path: 'f',
      ciphertext: bytes(1),
      etag: null,
      modifiedTime: null,
      lastAccess: 1,
      pinned: true,
    })
    await db.blobs.put({ path: 'b', bytes: bytes(1), size: 1, lastAccess: 1 })
    await db.meta.put({ key: 'k', value: 1 })
    await db.drafts.put({ entryId: 'd', sealed: bytes(1), updatedAt: 1 })
    await db.device.put(device())
  })

  it('clearCache keeps drafts and device', async () => {
    await db.clearCache()
    expect(await db.files.list()).toEqual([])
    expect(await db.blobs.listByLastAccess()).toEqual([])
    expect(await db.meta.get('k')).toBeUndefined()
    expect(await db.drafts.list()).toHaveLength(1)
    expect(await db.device.get()).toBeDefined()
  })

  it('clearCache keeps the journal-seen lock hints and clearAll wipes them', async () => {
    await db.meta.put({ key: `${JOURNAL_SEEN_PREFIX}j1`, value: '20:1:0' })
    await db.clearCache()
    expect(await db.meta.listByPrefix(JOURNAL_SEEN_PREFIX)).toEqual([
      { key: `${JOURNAL_SEEN_PREFIX}j1`, value: '20:1:0' },
    ])
    expect(await db.meta.get('k')).toBeUndefined()
    await db.clearAll()
    expect(await db.meta.listByPrefix(JOURNAL_SEEN_PREFIX)).toEqual([])
  })

  it('clearCache keeps the cache limit preference and clearAll wipes it', async () => {
    await db.meta.put({ key: CACHE_LIMIT_KEY, value: 123 })
    await db.clearCache()
    expect((await db.meta.get(CACHE_LIMIT_KEY))?.value).toBe(123)
    await db.clearAll()
    expect(await db.meta.get(CACHE_LIMIT_KEY)).toBeUndefined()
  })

  it('blobs.clear drops only blobs', async () => {
    await db.blobs.clear()
    expect(await db.blobs.listByLastAccess()).toEqual([])
    expect(await db.files.list()).toHaveLength(1)
    expect(await db.meta.get('k')).toBeDefined()
    expect(await db.drafts.list()).toHaveLength(1)
    expect(await db.device.get()).toBeDefined()
  })

  it('clearAll wipes everything', async () => {
    await db.clearAll()
    expect(await db.drafts.list()).toEqual([])
    expect(await db.device.get()).toBeUndefined()
  })
})

describe('errors', () => {
  it('surfaces quota errors as StorageQuotaError', async () => {
    const quota = new DOMException('full', 'QuotaExceededError')
    const fake = {
      transaction: () => {
        throw quota
      },
      close: () => undefined,
    } as unknown as IDBDatabase
    const { WebDb: Ctor } = await import('./idb')
    await expect(new Ctor(fake).files.list()).rejects.toBeInstanceOf(StorageQuotaError)
  })
})

describe('ciphertext only', () => {
  it('refuses plaintext inputs at runtime', () => {
    expect(() =>
      db.files.put({
        path: 'p',
        ciphertext: MARKER as unknown as Uint8Array,
        etag: null,
        modifiedTime: null,
        lastAccess: 1,
        pinned: false,
      }),
    ).toThrow(/Uint8Array/)
    expect(() =>
      db.blobs.put({ path: 'p', bytes: MARKER as unknown as Uint8Array, size: 1, lastAccess: 1 }),
    ).toThrow(/Uint8Array/)
    expect(() =>
      db.drafts.put({ entryId: 'p', sealed: MARKER as unknown as Uint8Array, updatedAt: 1 }),
    ).toThrow(/Uint8Array/)
  })

  it('never leaves the plaintext marker in any raw stored value', async () => {
    // Plaintext-free ciphertext in every store.
    await db.files.put({
      path: 'f',
      ciphertext: bytes(32, 0xaa),
      etag: 'e',
      modifiedTime: 't',
      lastAccess: 1,
      pinned: false,
    })
    await db.blobs.put({ path: 'b', bytes: bytes(32, 0xbb), size: 32, lastAccess: 1 })
    await db.drafts.put({ entryId: 'd', sealed: bytes(32, 0xcc), updatedAt: 1 })
    await db.device.put(device())
    await db.meta.put({ key: 'cacheBytes', value: 64 })
    // Attempts to smuggle plaintext are refused and leave nothing behind.
    expect(() =>
      db.drafts.put({ entryId: MARKER, sealed: MARKER as unknown as Uint8Array, updatedAt: 1 }),
    ).toThrow()
    expect(() => assertDeviceRecord({ ...device(), plaintext: MARKER })).toThrow()
    db.close()

    const raw = await rawOpen()
    let walked = 0
    for (const name of STORES) {
      const values = await new Promise<unknown[]>((resolve, reject) => {
        const req = raw.transaction(name).objectStore(name).getAll()
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
      walked += values.length
      for (const v of values) expect(containsMarker(v)).toBe(false)
    }
    expect(walked).toBe(5)
    raw.close()
    // Sanity: the walker does detect the marker in strings, typed arrays and nested objects.
    expect(containsMarker({ a: [{ b: `x${MARKER}` }] })).toBe(true)
    expect(containsMarker(new TextEncoder().encode(MARKER))).toBe(true)
  })
})

function rawOpen(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = factory.open(DB_NAME)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function containsMarker(v: unknown): boolean {
  if (typeof v === 'string') return v.includes(MARKER)
  if (v instanceof Uint8Array) return new TextDecoder('latin1').decode(v).includes(MARKER)
  if (Array.isArray(v)) return v.some(containsMarker)
  if (typeof v === 'object' && v !== null) {
    return Object.entries(v).some(([k, x]) => k.includes(MARKER) || containsMarker(x))
  }
  return false
}

describe('cache metadata helpers', () => {
  const file = (
    path: string,
    n: number,
    extra: Partial<{ pinned: boolean; lastAccess: number }> = {},
  ) => ({
    path,
    ciphertext: bytes(n),
    etag: null,
    modifiedTime: null,
    lastAccess: extra.lastAccess ?? 1,
    pinned: extra.pinned ?? false,
  })

  it('files.sizes lists path, size, lastAccess and pinned without the ciphertext', async () => {
    await db.files.put(file('a/entries/1.bin', 5, { pinned: true, lastAccess: 9 }))
    await db.files.put(file('b/x.bin', 3))
    const sizes = (await db.files.sizes()).sort((x, y) => x.path.localeCompare(y.path))
    expect(sizes).toEqual([
      { path: 'a/entries/1.bin', size: 5, lastAccess: 9, pinned: true },
      { path: 'b/x.bin', size: 3, lastAccess: 1, pinned: false },
    ])
    expect(sizes[0]).not.toHaveProperty('ciphertext')
  })

  it('measures a record written by an older build that has no pinned or size field', async () => {
    const raw = await new Promise<IDBDatabase>((resolve) => {
      const req = factory.open(DB_NAME)
      req.onsuccess = () => resolve(req.result)
    })
    await new Promise<void>((resolve) => {
      const t = raw.transaction('files', 'readwrite')
      t.objectStore('files').put({ path: 'old/entries/1.bin', ciphertext: bytes(4), lastAccess: 2 })
      t.oncomplete = () => resolve()
    })
    raw.close()
    expect(await db.files.sizes()).toEqual([
      { path: 'old/entries/1.bin', size: 4, lastAccess: 2, pinned: false },
    ])
  })

  it('blobs.sizes lists size and lastAccess; setPinned flips only cached files', async () => {
    await db.blobs.put({ path: 'media/m1', bytes: bytes(6), size: 6, lastAccess: 4 })
    expect(await db.blobs.sizes()).toEqual([
      { path: 'media/m1', size: 6, lastAccess: 4, pinned: false },
    ])
    await db.files.put(file('a/entries/1.bin', 2))
    expect(await db.files.setPinned('a/entries/1.bin', true)).toBe(true)
    expect((await db.files.get('a/entries/1.bin'))?.pinned).toBe(true)
    expect(await db.files.setPinned('missing', true)).toBe(false)
  })

  it('files.putPreservingPin keeps a pin set concurrently and never unpins', async () => {
    const path = 'a/entries/1.bin'
    await db.files.put(file(path, 2))
    // setPinned lands while the put is in flight: neither order may lose the pin
    await Promise.all([
      db.files.putPreservingPin({ ...file(path, 3), pinned: false }),
      db.files.setPinned(path, true),
    ])
    const stored = await db.files.get(path)
    expect(stored?.pinned).toBe(true)
    expect(stored?.ciphertext.byteLength).toBe(3)
    await db.files.putPreservingPin({ ...file(path, 4), pinned: false })
    expect((await db.files.get(path))?.pinned).toBe(true)
    await db.files.putPreservingPin({ ...file('b/entries/2.bin', 1), pinned: false })
    expect((await db.files.get('b/entries/2.bin'))?.pinned).toBe(false)
  })
})

describe('exact-size ciphertext', () => {
  it('refuses a view over a larger buffer in files, blobs and drafts (hidden bytes)', async () => {
    const big = new Uint8Array(1000).fill(9)
    const view = big.subarray(0, 10)
    const offset = big.subarray(990)
    const file = { etag: null, modifiedTime: null, lastAccess: 1, pinned: false }
    for (const v of [view, offset]) {
      expect(() => db.files.put({ path: 'a', ciphertext: v, ...file })).toThrow(TypeError)
      expect(() => db.files.putPreservingPin({ path: 'a', ciphertext: v, ...file })).toThrow(
        TypeError,
      )
      expect(() =>
        db.blobs.put({ path: 'media/a', bytes: v, size: v.length, lastAccess: 1 }),
      ).toThrow(TypeError)
      expect(() => db.drafts.put({ entryId: 'd', sealed: v, updatedAt: 1 })).toThrow(TypeError)
    }
    expect(await db.files.paths()).toEqual([])
    // a copy is accepted and its stored size is its own length
    await db.blobs.put({ path: 'media/a', bytes: view.slice(), size: 10, lastAccess: 1 })
    expect((await db.blobs.sizes()).map((m) => m.size)).toEqual([10])
  })
})
