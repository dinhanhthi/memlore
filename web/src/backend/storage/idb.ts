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

/** The device store holds a single record under this out-of-line key. */
const DEVICE_KEY = 'self'

/** `wrap_master_local` output: 1 version + 4 m_cost + 1 t_cost + 1 p_cost + 28 AES-GCM(32B) = 67 bytes. */
export const WRAPPED_MASTER_HEX_LEN = 134
/** A raw 32-byte master key as hex. Must never be stored. */
const RAW_KEY_HEX_LEN = 64

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

export interface BlobRecord {
  path: string
  bytes: Uint8Array
  size: number
  lastAccess: number
}

export interface DraftRecord {
  entryId: string
  /** Sealed (encrypted) draft bytes. Sealing happens outside this module. */
  sealed: Uint8Array
  updatedAt: number
}

/** No field here can hold raw key bytes: `wrappedMasterHex` is the wrapped blob, `kekSaltHex` is public. */
export interface DeviceRecord {
  deviceId: string
  wrappedMasterHex: string
  kekSaltHex: string
  recoveryGeneration: number
  masterFingerprint: string
  name: string
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
}

function assertBytes(v: unknown, what: string): asserts v is Uint8Array {
  if (!(v instanceof Uint8Array)) throw new TypeError(`${what} must be a Uint8Array of ciphertext`)
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

function assertDraftRecord(r: DraftRecord): void {
  assertString(r.entryId, 'draft entryId')
  assertBytes(r.sealed, 'draft sealed bytes')
  assertNumber(r.updatedAt, 'draft updatedAt')
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
    delete: (path: string) => this.del(STORE_FILES, path),
    list: () => this.all<FileRecord>(STORE_FILES),
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
    totalSize: async (): Promise<number> =>
      (await this.all<BlobRecord>(STORE_BLOBS)).reduce((sum, b) => sum + b.size, 0),
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
  }

  readonly device = {
    get: () => this.get<DeviceRecord>(STORE_DEVICE, DEVICE_KEY),
    put: (record: DeviceRecord) => {
      assertDeviceRecord(record)
      return this.put(STORE_DEVICE, record, DEVICE_KEY)
    },
    clear: () => this.del(STORE_DEVICE, DEVICE_KEY),
  }

  readonly meta = {
    get: (key: string) => this.get<MetaRecord>(STORE_META, key),
    put: (record: MetaRecord) => {
      assertMetaRecord(record)
      return this.put(STORE_META, record)
    },
    delete: (key: string) => this.del(STORE_META, key),
  }

  /** Drops cached ciphertext (files, blobs, meta). KEEPS unpushed drafts and the device record. */
  clearCache(): Promise<void> {
    return this.clearStores([STORE_FILES, STORE_BLOBS, STORE_META])
  }

  /** Wipes every store, including drafts and the device record. */
  clearAll(): Promise<void> {
    return this.clearStores([STORE_FILES, STORE_BLOBS, STORE_META, STORE_DRAFTS, STORE_DEVICE])
  }
}
