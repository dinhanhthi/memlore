// IndexedDB storage for the web app (`memlore-web` v1).
//
// Only ciphertext is ever stored. The public API takes `Uint8Array` ciphertext (files, blobs) or
// SEALED bytes (drafts, sealed elsewhere in Phase 16), and the runtime guards below refuse any
// other shape. The device record holds the Argon2id/AES-GCM wrapped master blob, never a raw key.
// No module-level side effects: the IDBFactory is injected (default `indexedDB`, resolved lazily).

export const DB_NAME = 'memlore-web'
export const DB_VERSION = 1

export const STORE_FILES = 'files'
export const STORE_DRAFTS = 'drafts'
export const STORE_DEVICE = 'device'
export const STORE_BLOBS = 'blobs'
export const STORE_META = 'meta'

/**
 * Meta keys with this prefix hold the highest-seen lock state of a journal (`journal-seen:<id>`).
 * They are tiny hints, not content, and survive `clearCache()` so a rollback of a journal file on
 * the cloud cannot unlock a journal after the cache was dropped. `clearAll()` wipes them.
 */
export const JOURNAL_SEEN_PREFIX = 'journal-seen:'

/**
 * Meta key of the user's media cache limit in bytes (a number; Phase 11.3). A preference, not
 * cache: it survives `clearCache()`; `clearAll()` wipes it.
 */
export const CACHE_LIMIT_KEY = 'cache-limit-bytes'

/**
 * Meta keys with this prefix hold the intent-retention state of drafts (Phase 16.6.8: first-seen
 * push and refusal times, resolved fields). They belong with the drafts, so they survive
 * `clearCache()` like the drafts do; `clearAll()` wipes them.
 */
export const OUTBOX_META_PREFIX = 'outbox-'
/** Retention's "first seen pushed" times (`<prefix><entryId>`), reset with `drafts.clearPushed`. */
export const OUTBOX_PUSHED_AT_PREFIX = `${OUTBOX_META_PREFIX}pushed-at:`

/** The device store holds a single record under this out-of-line key. */
const DEVICE_KEY = 'self'

/** `wrap_master_local` output: 1 version + 4 m_cost + 1 t_cost + 1 p_cost + 28 AES-GCM(32B) = 67 bytes. */
export const WRAPPED_MASTER_HEX_LEN = 134
/** A raw 32-byte master key as hex. Must never be stored. */
const RAW_KEY_HEX_LEN = 64

const isPreservedMetaKey = (k: string): boolean =>
  k.startsWith(JOURNAL_SEEN_PREFIX) || k.startsWith(OUTBOX_META_PREFIX) || k === CACHE_LIMIT_KEY

export class StorageUnavailableError extends Error {
  constructor(message = 'IndexedDB is unavailable (private mode or blocked)') {
    super(message)
    this.name = 'StorageUnavailableError'
  }
}

export class StorageQuotaError extends Error {
  constructor(message = 'Browser storage quota exceeded') {
    super(message)
    this.name = 'StorageQuotaError'
  }
}

export interface FileRecord {
  path: string
  ciphertext: Uint8Array
  etag: string | null
  modifiedTime: string | null
  lastAccess: number
  pinned: boolean
}

/** Cache accounting row: everything about a cached record except its bytes. */
export interface CacheMeta {
  path: string
  size: number
  lastAccess: number
  pinned: boolean
}

export interface BlobRecord {
  path: string
  bytes: Uint8Array
  size: number
  lastAccess: number
}

/** Blob keys under this prefix are the sealed media of drafts, never cache. */
export const OUTBOX_BLOB_PREFIX = 'outbox/'

/** Deletes every blob row except the drafts' outbox media. */
async function deleteCachedBlobs(blobs: IDBObjectStore): Promise<void> {
  const keys = (await requestToPromise(blobs.getAllKeys())) as IDBValidKey[]
  await Promise.all(
    keys
      .filter((k) => !(typeof k === 'string' && k.startsWith(OUTBOX_BLOB_PREFIX)))
      .map((k) => requestToPromise(blobs.delete(k))),
  )
}

export interface DraftRecord {
  entryId: string
  /** Sealed (encrypted) draft bytes. Sealing happens outside this module. */
  sealed: Uint8Array
  updatedAt: number
  /**
   * SHA-256 hex of the `sealed` bytes last uploaded. Absent (every record written before Phase
   * 16.5) or different from the hash of `sealed`: the draft is unpushed.
   */
  pushedHash?: string
}

/** No field here can hold raw key bytes: `wrappedMasterHex` is the wrapped blob, `kekSaltHex` is public. */
export interface DeviceRecord {
  deviceId: string
  wrappedMasterHex: string
  kekSaltHex: string
  recoveryGeneration: number
  masterFingerprint: string
  name: string
  nextChangeSeq?: number
}

export interface MetaRecord {
  key: string
  value: string | number | boolean
}

const DEVICE_FIELDS: ReadonlySet<string> = new Set([
  'deviceId',
  'wrappedMasterHex',
  'kekSaltHex',
  'recoveryGeneration',
  'masterFingerprint',
  'name',
  'nextChangeSeq',
])

const HEX_RE = /^(?:[0-9a-fA-F]{2})+$/

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Throws unless `value` is a well-formed device record with a wrapped (not raw) master blob. */
export function assertDeviceRecord(value: unknown): asserts value is DeviceRecord {
  if (!isRecord(value)) throw new TypeError('device record must be an object')
  for (const k of Object.keys(value)) {
    if (!DEVICE_FIELDS.has(k)) throw new TypeError(`device record has unknown field "${k}"`)
  }
  for (const k of ['deviceId', 'wrappedMasterHex', 'kekSaltHex', 'masterFingerprint', 'name']) {
    if (typeof value[k] !== 'string' || value[k] === '') {
      throw new TypeError(`device record field "${k}" must be a non-empty string`)
    }
  }
  const wrapped = value.wrappedMasterHex as string
  if (!HEX_RE.test(wrapped)) throw new TypeError('wrappedMasterHex must be hex')
  if (wrapped.length === RAW_KEY_HEX_LEN) {
    throw new TypeError('wrappedMasterHex looks like a raw 32-byte key; refusing to store')
  }
  if (wrapped.length < WRAPPED_MASTER_HEX_LEN) {
    throw new TypeError('wrappedMasterHex is shorter than a wrapped master blob')
  }
  if (!HEX_RE.test(value.kekSaltHex as string)) throw new TypeError('kekSaltHex must be hex')
  const gen = value.recoveryGeneration
  if (typeof gen !== 'number' || !Number.isInteger(gen) || gen < 0) {
    throw new TypeError('recoveryGeneration must be a non-negative integer')
  }
  if (value.nextChangeSeq !== undefined) {
    const seq = value.nextChangeSeq
    if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 1) {
      throw new TypeError('nextChangeSeq must be a positive integer')
    }
  }
}

function assertBytes(v: unknown, what: string): asserts v is Uint8Array {
  if (!(v instanceof Uint8Array)) throw new TypeError(`${what} must be a Uint8Array of ciphertext`)
  // Structured clone persists the WHOLE backing buffer: a view over a larger one would store hidden
  // bytes that no size accounting (`byteLength`) sees. Callers must pass an exact-size copy.
  if (v.byteOffset !== 0 || v.buffer.byteLength !== v.byteLength) {
    throw new TypeError(`${what} must not be a view over a larger buffer`)
  }
}

function assertString(v: unknown, what: string): void {
  if (typeof v !== 'string' || v === '') throw new TypeError(`${what} must be a non-empty string`)
}

function assertNumber(v: unknown, what: string): void {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new TypeError(`${what} must be a number`)
}

function assertFileRecord(r: FileRecord): void {
  assertString(r.path, 'file path')
  assertBytes(r.ciphertext, 'file ciphertext')
  assertNumber(r.lastAccess, 'file lastAccess')
  if (typeof r.pinned !== 'boolean') throw new TypeError('file pinned must be a boolean')
}

function assertBlobRecord(r: BlobRecord): void {
  assertString(r.path, 'blob path')
  assertBytes(r.bytes, 'blob bytes')
  assertNumber(r.lastAccess, 'blob lastAccess')
  if (r.size !== r.bytes.byteLength) throw new TypeError('blob size must equal bytes length')
}

const SHA256_HEX_RE = /^[0-9a-f]{64}$/

function assertDraftRecord(r: DraftRecord): void {
  assertString(r.entryId, 'draft entryId')
  assertBytes(r.sealed, 'draft sealed bytes')
  assertNumber(r.updatedAt, 'draft updatedAt')
  const hash: unknown = r.pushedHash
  if (hash !== undefined && !(typeof hash === 'string' && SHA256_HEX_RE.test(hash))) {
    throw new TypeError('draft pushedHash must be a SHA-256 hex string')
  }
}

/** Byte-for-byte equality: the one definition of "unchanged" for drafts and sealed payloads. */
export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false
  return true
}

function assertMetaRecord(r: MetaRecord): void {
  assertString(r.key, 'meta key')
  if (!['string', 'number', 'boolean'].includes(typeof r.value)) {
    throw new TypeError('meta value must be a string, number or boolean')
  }
}

function toStorageError(err: unknown): Error {
  if (err instanceof Error && (err.name === 'QuotaExceededError' || /quota/i.test(err.message))) {
    return new StorageQuotaError(err.message)
  }
  return err instanceof Error ? err : new Error(String(err))
}

function requestToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(toStorageError(req.error))
  })
}

export interface OpenOptions {
  /** Defaults to the global `indexedDB`. */
  factory?: IDBFactory
  /** Another connection blocks the upgrade; the open stays pending until it closes. */
  onBlocked?: () => void
  /** The connection was closed because another tab requested a newer version. */
  onVersionChange?: () => void
}

function upgrade(db: IDBDatabase): void {
  const files = db.createObjectStore(STORE_FILES, { keyPath: 'path' })
  files.createIndex('lastAccess', 'lastAccess')
  const blobs = db.createObjectStore(STORE_BLOBS, { keyPath: 'path' })
  blobs.createIndex('lastAccess', 'lastAccess')
  db.createObjectStore(STORE_DRAFTS, { keyPath: 'entryId' })
  db.createObjectStore(STORE_DEVICE)
  db.createObjectStore(STORE_META, { keyPath: 'key' })
}

export function openWebDb(options: OpenOptions = {}): Promise<WebDb> {
  let factory: IDBFactory | undefined
  try {
    factory = options.factory ?? (typeof indexedDB === 'undefined' ? undefined : indexedDB)
  } catch {
    factory = undefined
  }
  if (!factory) return Promise.reject(new StorageUnavailableError())
  const idb = factory
  return new Promise((resolve, reject) => {
    let req: IDBOpenDBRequest
    try {
      req = idb.open(DB_NAME, DB_VERSION)
    } catch (e) {
      reject(new StorageUnavailableError(e instanceof Error ? e.message : undefined))
      return
    }
    req.onupgradeneeded = () => upgrade(req.result)
    req.onblocked = () => options.onBlocked?.()
    req.onerror = () => reject(new StorageUnavailableError(req.error?.message))
    req.onsuccess = () => {
      const db = req.result
      db.onversionchange = () => {
        db.close()
        options.onVersionChange?.()
      }
      resolve(new WebDb(db))
    }
  })
}

type Mode = 'readonly' | 'readwrite'

export class WebDb {
  private readonly db: IDBDatabase

  constructor(db: IDBDatabase) {
    this.db = db
  }

  close(): void {
    this.db.close()
  }

  /** Runs `fn` in one transaction and resolves with its result once the transaction commits. */
  private tx<T>(
    names: string[],
    mode: Mode,
    fn: (stores: IDBObjectStore[]) => Promise<T> | T,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let t: IDBTransaction
      try {
        t = this.db.transaction(names, mode)
      } catch (e) {
        reject(toStorageError(e))
        return
      }
      let result: T
      t.oncomplete = () => resolve(result)
      t.onerror = () => reject(toStorageError(t.error))
      t.onabort = () => reject(toStorageError(t.error))
      try {
        const stores = names.map((n) => t.objectStore(n))
        Promise.resolve(fn(stores)).then(
          (r) => {
            result = r
          },
          (e: unknown) => {
            reject(toStorageError(e))
            try {
              t.abort()
            } catch {
              // already finished
            }
          },
        )
      } catch (e) {
        reject(toStorageError(e))
        try {
          t.abort()
        } catch {
          // already finished
        }
      }
    })
  }

  private get<T>(store: string, key: IDBValidKey): Promise<T | undefined> {
    return this.tx(
      [store],
      'readonly',
      ([s]) => requestToPromise(s.get(key)) as Promise<T | undefined>,
    )
  }

  private put(store: string, value: unknown, key?: IDBValidKey): Promise<void> {
    return this.tx([store], 'readwrite', async ([s]) => {
      await requestToPromise(key === undefined ? s.put(value) : s.put(value, key))
    })
  }

  private del(store: string, key: IDBValidKey): Promise<void> {
    return this.tx([store], 'readwrite', async ([s]) => {
      await requestToPromise(s.delete(key))
    })
  }

  private all<T>(store: string, index?: string): Promise<T[]> {
    return this.tx([store], 'readonly', ([s]) => {
      const source = index ? s.index(index) : s
      return requestToPromise(source.getAll()) as Promise<T[]>
    })
  }

  /**
   * Walks a store with a cursor and keeps only the metadata, so at most one record's bytes are
   * alive at a time (IndexedDB cannot read part of a record). The size is always derived from the
   * stored bytes, so records written by any earlier build are measured the same way.
   */
  private cacheMetas(store: string, measure: (value: Record<string, unknown>) => CacheMeta) {
    return this.tx(
      [store],
      'readonly',
      ([s]) =>
        new Promise<CacheMeta[]>((resolve, reject) => {
          const out: CacheMeta[] = []
          const req = s.openCursor()
          req.onerror = () => reject(toStorageError(req.error))
          req.onsuccess = () => {
            const cursor = req.result
            if (cursor === null) {
              resolve(out)
              return
            }
            out.push(measure(cursor.value as Record<string, unknown>))
            cursor.continue()
          }
        }),
    )
  }

  private clearStores(names: string[]): Promise<void> {
    return this.tx(names, 'readwrite', async (stores) => {
      await Promise.all(stores.map((s) => requestToPromise(s.clear())))
    })
  }

  readonly files = {
    get: (path: string) => this.get<FileRecord>(STORE_FILES, path),
    put: (record: FileRecord) => {
      assertFileRecord(record)
      return this.put(STORE_FILES, record)
    },
    /**
     * Put that keeps an existing `pinned: true`, read and written in ONE transaction so a
     * concurrent `setPinned(true)` is never overwritten by a stale `false`.
     */
    putPreservingPin: (record: FileRecord): Promise<void> => {
      assertFileRecord(record)
      return this.tx([STORE_FILES], 'readwrite', async ([s]) => {
        const rec = (await requestToPromise(s.get(record.path))) as FileRecord | undefined
        await requestToPromise(s.put({ ...record, pinned: record.pinned || rec?.pinned === true }))
      })
    },
    delete: (path: string) => this.del(STORE_FILES, path),
    list: () => this.all<FileRecord>(STORE_FILES),
    /** Every cached path, without reading the ciphertext. */
    paths: () =>
      this.tx(
        [STORE_FILES],
        'readonly',
        ([s]) => requestToPromise(s.getAllKeys()) as Promise<string[]>,
      ),
    /** Path, size, lastAccess and pinned of every cached file, without keeping the ciphertext. */
    sizes: () =>
      this.cacheMetas(STORE_FILES, (v) => ({
        path: v.path as string,
        size: (v.ciphertext as Uint8Array).byteLength,
        lastAccess: v.lastAccess as number,
        pinned: v.pinned === true,
      })),
    /** Sets `pinned`; resolves false when the file is not cached. */
    setPinned: (path: string, pinned: boolean): Promise<boolean> =>
      this.tx([STORE_FILES], 'readwrite', async ([s]) => {
        const rec = (await requestToPromise(s.get(path))) as FileRecord | undefined
        if (!rec) return false
        if (rec.pinned !== pinned) await requestToPromise(s.put({ ...rec, pinned }))
        return true
      }),
    /** Bumps `lastAccess`; resolves false when the file is not cached. */
    touch: (path: string, now: number = Date.now()): Promise<boolean> =>
      this.tx([STORE_FILES], 'readwrite', async ([s]) => {
        const rec = (await requestToPromise(s.get(path))) as FileRecord | undefined
        if (!rec) return false
        await requestToPromise(s.put({ ...rec, lastAccess: now }))
        return true
      }),
  }

  readonly blobs = {
    get: (path: string) => this.get<BlobRecord>(STORE_BLOBS, path),
    put: (record: BlobRecord) => {
      assertBlobRecord(record)
      return this.put(STORE_BLOBS, record)
    },
    delete: (path: string) => this.del(STORE_BLOBS, path),
    /**
     * Bumps `lastAccess`; resolves false when the blob is not cached. IndexedDB cannot patch a
     * field, so this rewrites the whole record (up to 200 MB): callers throttle it.
     */
    touch: (path: string, now: number = Date.now()): Promise<boolean> =>
      this.tx([STORE_BLOBS], 'readwrite', async ([s]) => {
        const rec = (await requestToPromise(s.get(path))) as BlobRecord | undefined
        if (!rec) return false
        await requestToPromise(s.put({ ...rec, lastAccess: now }))
        return true
      }),
    /**
     * Drops every cached media row (the Settings "Clear cache"); no other store is opened. Keeps
     * the sealed outbox media of drafts (`outbox/…`): it is not cache and has no other copy.
     */
    clear: () =>
      this.tx([STORE_BLOBS], 'readwrite', async ([blobs]) => {
        await deleteCachedBlobs(blobs)
      }),
    totalSize: async (): Promise<number> =>
      (await this.all<BlobRecord>(STORE_BLOBS)).reduce((sum, b) => sum + b.size, 0),
    /** Path, size, lastAccess of every cached blob, without keeping the bytes. */
    sizes: () =>
      this.cacheMetas(STORE_BLOBS, (v) => ({
        path: v.path as string,
        size: v.size as number,
        lastAccess: v.lastAccess as number,
        pinned: false,
      })),
    /** Oldest access first (LRU eviction order). */
    listByLastAccess: () => this.all<BlobRecord>(STORE_BLOBS, 'lastAccess'),
  }

  readonly drafts = {
    get: (entryId: string) => this.get<DraftRecord>(STORE_DRAFTS, entryId),
    put: (record: DraftRecord) => {
      assertDraftRecord(record)
      return this.put(STORE_DRAFTS, record)
    },
    delete: (entryId: string) => this.del(STORE_DRAFTS, entryId),
    list: () => this.all<DraftRecord>(STORE_DRAFTS),
    /**
     * Sets `pushedHash` in ONE transaction, only while the stored `sealed` bytes are still the
     * `uploaded` ones (a draft saved again during the upload stays unpushed). Compares bytes, not
     * hashes: hashing is async and would let the transaction auto-commit. Resolves false when the
     * draft is missing or changed.
     */
    markPushed: (entryId: string, uploaded: Uint8Array, pushedHash: string): Promise<boolean> =>
      this.tx([STORE_DRAFTS], 'readwrite', async ([s]) => {
        const rec = (await requestToPromise(s.get(entryId))) as DraftRecord | undefined
        if (!rec || !(rec.sealed instanceof Uint8Array) || !sameBytes(rec.sealed, uploaded)) {
          return false
        }
        const updated: DraftRecord = { ...rec, pushedHash }
        assertDraftRecord(updated)
        await requestToPromise(s.put(updated))
        return true
      }),
    /**
     * Deletes a PUSHED draft and its outbox media `blobPaths` in ONE transaction, only while the
     * stored bytes are still `sealed` and marked pushed with `pushedHash` (a draft saved again
     * meanwhile is unpushed and stays). Resolves false when nothing was deleted.
     */
    dropPushed: (
      entryId: string,
      sealed: Uint8Array,
      pushedHash: string,
      blobPaths: readonly string[],
    ): Promise<boolean> =>
      this.tx([STORE_DRAFTS, STORE_BLOBS], 'readwrite', async ([s, blobs]) => {
        const rec = (await requestToPromise(s.get(entryId))) as DraftRecord | undefined
        if (
          !rec ||
          !(rec.sealed instanceof Uint8Array) ||
          !sameBytes(rec.sealed, sealed) ||
          rec.pushedHash !== pushedHash
        ) {
          return false
        }
        await requestToPromise(s.delete(entryId))
        await Promise.all(blobPaths.map((p) => requestToPromise(blobs.delete(p))))
        return true
      }),
    /**
     * Web-clock seconds this draft revision was first seen pushed, in ONE transaction with the
     * draft read: the stored time when the `OUTBOX_PUSHED_AT_PREFIX` key already holds `hash`,
     * else `now` (recorded as `<hash>:<now>`). Resolves null and writes nothing when the draft is
     * missing or not pushed with `hash` (any more), so a retention pass racing `clearPushed`
     * cannot restore a time it just forgot.
     */
    recordPushedAt: (entryId: string, hash: string, now: number): Promise<number | null> =>
      this.tx([STORE_DRAFTS, STORE_META], 'readwrite', async ([s, meta]) => {
        const rec = (await requestToPromise(s.get(entryId))) as DraftRecord | undefined
        if (!rec || rec.pushedHash !== hash) return null
        const key = `${OUTBOX_PUSHED_AT_PREFIX}${entryId}`
        const value = ((await requestToPromise(meta.get(key))) as MetaRecord | undefined)?.value
        const m = typeof value === 'string' ? /^([0-9a-f]{64}):(\d+)$/.exec(value) : null
        if (m !== null && m[1] === hash) return Number(m[2])
        const record: MetaRecord = { key, value: `${hash}:${now}` }
        assertMetaRecord(record)
        await requestToPromise(meta.put(record))
        return now
      }),
    /**
     * Drops `pushedHash` from every draft in ONE transaction, so each is uploaded again (a
     * re-onboard: the outbox it was pushed to may be gone), and forgets when each was first seen
     * pushed. Keeps the bytes and the outbox media.
     */
    clearPushed: (): Promise<void> =>
      this.tx([STORE_DRAFTS, STORE_META], 'readwrite', async ([s, meta]) => {
        const all = (await requestToPromise(s.getAll())) as DraftRecord[]
        // The retention grace windows restart with the re-push, in the new outbox.
        const keys = (await requestToPromise(meta.getAllKeys())) as IDBValidKey[]
        await Promise.all([
          ...all
            .filter((rec) => rec.pushedHash !== undefined)
            .map(({ pushedHash: _pushed, ...rec }) => {
              assertDraftRecord(rec)
              return requestToPromise(s.put(rec))
            }),
          ...keys
            .filter((k) => typeof k === 'string' && k.startsWith(OUTBOX_PUSHED_AT_PREFIX))
            .map((k) => requestToPromise(meta.delete(k))),
        ])
      }),
  }

  readonly device = {
    get: () => this.get<DeviceRecord>(STORE_DEVICE, DEVICE_KEY),
    put: (record: DeviceRecord) => {
      assertDeviceRecord(record)
      return this.put(STORE_DEVICE, record, DEVICE_KEY)
    },
    allocateChangeSeq: (): Promise<number> =>
      this.tx([STORE_DEVICE], 'readwrite', async ([s]) => {
        const rec = (await requestToPromise(s.get(DEVICE_KEY))) as DeviceRecord | undefined
        if (!rec) {
          throw new Error('Device record missing while allocating change_seq')
        }
        const current = rec.nextChangeSeq ?? 1
        const updated: DeviceRecord = { ...rec, nextChangeSeq: current + 1 }
        assertDeviceRecord(updated)
        await requestToPromise(s.put(updated, DEVICE_KEY))
        return current
      }),
    clear: () => this.del(STORE_DEVICE, DEVICE_KEY),
  }

  readonly meta = {
    get: (key: string) => this.get<MetaRecord>(STORE_META, key),
    put: (record: MetaRecord) => {
      assertMetaRecord(record)
      return this.put(STORE_META, record)
    },
    delete: (key: string) => this.del(STORE_META, key),
    /** Every record whose key starts with `prefix`. */
    listByPrefix: (prefix: string): Promise<MetaRecord[]> =>
      this.tx([STORE_META], 'readonly', async ([s]) =>
        ((await requestToPromise(s.getAll())) as MetaRecord[]).filter((r) =>
          r.key.startsWith(prefix),
        ),
      ),
  }

  /**
   * Drops cached ciphertext (files, blobs, meta). KEEPS unpushed drafts and their `outbox/` media, the device record, the
   * `journal-seen:` lock-state hints (see `JOURNAL_SEEN_PREFIX`), the drafts' `outbox-` retention
   * state and the `CACHE_LIMIT_KEY` preference.
   */
  clearCache(): Promise<void> {
    return this.tx([STORE_FILES, STORE_BLOBS, STORE_META], 'readwrite', async (stores) => {
      const [files, blobs, meta] = stores
      const keys = (await requestToPromise(meta.getAllKeys())) as IDBValidKey[]
      await Promise.all([
        requestToPromise(files.clear()),
        deleteCachedBlobs(blobs),
        ...keys
          .filter((k) => !(typeof k === 'string' && isPreservedMetaKey(k)))
          .map((k) => requestToPromise(meta.delete(k))),
      ])
    })
  }

  /** Wipes every store, including drafts and the device record. */
  clearAll(): Promise<void> {
    return this.clearStores([STORE_FILES, STORE_BLOBS, STORE_META, STORE_DRAFTS, STORE_DEVICE])
  }
}
