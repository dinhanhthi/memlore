import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  DB_NAME,
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
    expect(() => assertDeviceRecord(null)).toThrow(/object/)
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
