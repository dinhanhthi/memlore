/**
 * Media read commands (Phase 11.1). READ-ONLY: nothing is ever written to Drive.
 *
 * Resolution order: cached ciphertext (`blobs`) -> Drive download -> `openMedia` (WASM; envelope
 * 0x01 or 0x02, the same double HKDF key as entries) -> bytes. Only CIPHERTEXT is stored in IndexedDB
 * (`blobs`, key `media/<id>` and `media/<id>.thumb`, independent of the device so one lookup serves
 * every location); decrypted bytes exist only in the returned value.
 *
 * WIRE SHAPE (desktop parity, src/lib/tauri.ts): `read_media_*` return `number[]`; `resolve_media*`
 * return a path string and `get_media_status` a `MediaStatus`. The web has no files, so the "path"
 * is the synthetic `memlore-web://media/<id>[.thumb]` that the UI only tests for being non-empty.
 * `resolve_media*` download, verify (decrypt) and cache the ciphertext and discard the plaintext.
 *
 * WHERE THE BYTES LIVE: `SyncMediaItem` (memlore-core metadata.rs) has no device id or cloud path.
 * The owning device is the entry's `device_id`; the file is `<device>/media/<id>` (and `.thumb`) in
 * the generation folder, then the flat folder (`DriveReader.readDeviceFile`, desktop precedence).
 * When it is missing there (another device edited the entry last), every OTHER known device (one
 * with a cached manifest) is tried the same way. Media ids are unique UUIDs, so this is safe.
 *
 * OWNER LOOKUP: the entry index has no media ids, so the owner is found among the LOADED visible
 * entries first. Locked, invisible, deleted and excluded-journal entries are stubs without media, so
 * their media is "not found"; the owner is re-checked through `vault.getEntry` before and after every
 * await, and a media id tombstoned in `deleted_media` (desktop `created_at <= deleted_at` rule) is
 * not served either.
 * Phase 16.2 fallback, for an entry the vault does NOT hold (never loaded: the gallery and On this
 * day list media of unloaded entries): the month index rows already read into RAM
 * (`MonthIndexReader.findMedia`, no download). The row must pass the Phase 15 fail-closed rule
 * (winner live, same `updated_at`, journal not excluded); the owner device is the entry-index
 * winner's, then the other-devices fallback below applies. The row is re-checked the same way
 * before and after every await. An entry the vault holds (visible or refused) never uses the index:
 * its loaded copy is authoritative (tombstones, locks). Index rows carry no `deleted_media`; the
 * desktop indexes live, uploaded media only.
 *
 * LIMITS: a full media larger than 200 MB (`SyncMediaItem.file_size`, checked BEFORE any request)
 * is `too_large_for_web`: one AES-GCM envelope must be decrypted whole in RAM. The metadata size is
 * not trusted to bound the download: every request carries a byte cap (declared `Content-Length`
 * refused up front, the stream cancelled the moment it exceeds the cap), so a blob that a party
 * with Drive write access planted cannot be buffered whole. The cap is `file_size` (when valid)
 * or 200 MB, plus the envelope overhead; a `.thumb` is capped at 16 MB. The thumbnail is
 * preferred: `.thumb` is requested first and the full file is the fallback when no usable `.thumb`
 * exists (missing, oversize or corrupt; desktop parity).
 *
 * The heavy modules (WASM core, Drive client, IndexedDB) are reached only through the read session.
 */

import { isPayloadDeviceFolderName, isSafeComponent } from '../drive/paths'
import { VaultLockedError, getKeyRing, type KeyRing } from '../keys'
import type { Handler } from '../router'
import { notifyCacheWrite } from '../storage/evictor'
import type { VaultEntry } from '../vault'
import type { MonthIndexReader } from '../sync/monthIndex'
import { readEnv, type MediaBackend, type VaultApi } from './readSession'

/** Largest full media the web decrypts (the envelope is opened whole in RAM). */
export const MAX_WEB_MEDIA_BYTES = 200 * 1024 * 1024

/**
 * Bytes an envelope adds to the plaintext. Real overhead (memlore-core media_sync.rs, 0x02):
 * 1 version + 4 epoch + 12 nonce + 16 GCM tag = 33; 64 leaves slack and is still a tiny margin.
 */
export const ENVELOPE_OVERHEAD_BYTES = 64

/** Desktop thumbnails are small JPEGs; a larger `.thumb` is not one. */
export const MAX_THUMB_BYTES = 16 * 1024 * 1024

/**
 * `read_media_bytes` returns `number[]` (`Array.from` of a Uint8Array costs 4-8 bytes per element),
 * so 200 MB would need up to ~1.6 GB of JS heap. Beyond this the same `too_large_for_web` error is
 * returned. Phase 12 changes the transport; `resolve_media*` keep the 200 MB cap.
 */
export const TOO_LARGE_FOR_NUMBER_ARRAY = 32 * 1024 * 1024

/** `lastAccess` of a cached blob is refreshed at most this often (a touch rewrites the whole blob). */
export const TOUCH_INTERVAL_MS = 60 * 60 * 1000

export const WEB_MEDIA_PATH_PREFIX = 'memlore-web://media/'

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

/** The media is larger than `MAX_WEB_MEDIA_BYTES`. UI (Phase 12): "Open on desktop". */
export class TooLargeForWebError extends Error {
  readonly code = 'too_large_for_web'
  constructor() {
    super('too_large_for_web: this file is too large to open in the browser; open it on desktop')
    this.name = 'TooLargeForWebError'
  }
}

/**
 * The file on Drive is larger than the size recorded in the entry (a stale or wrong `file_size`).
 * Fail closed, but this is NOT "too large": the UI (Phase 12) must not claim that.
 */
export class MediaSizeMismatchError extends Error {
  readonly code = 'media_size_mismatch'
  constructor() {
    super(
      'The media size recorded in the entry does not match the file; open it on the desktop app',
    )
    this.name = 'MediaSizeMismatchError'
  }
}

/** Unknown media id, or media of an entry the web does not serve, or a deleted media. */
export class MediaNotFoundError extends Error {
  readonly code = 'media_not_found'
  constructor(mediaId: string) {
    super(`Media not found: ${mediaId.slice(0, 64)}`)
    this.name = 'MediaNotFoundError'
  }
}

/** The ciphertext does not open (corrupt, tampered, wrong envelope or key). Never echoes bytes. */
export class MediaCorruptError extends Error {
  readonly code = 'media_corrupt'
  constructor(cause?: unknown) {
    super('This media file could not be decrypted (corrupt or tampered)', { cause })
    this.name = 'MediaCorruptError'
  }
}

/** A network, 5xx or 401 failure. Nothing was cached; retry later. */
export class MediaTransientError extends Error {
  readonly code = 'media_transient'
  readonly retryable = true
  constructor(cause?: unknown) {
    super('Could not download this media from the cloud; retry later', { cause })
    this.name = 'MediaTransientError'
  }
}

const TOO_LARGE_NAME = 'DriveTooLargeError'

const TRANSIENT_NAMES: ReadonlySet<string> = new Set([
  'DriveHttpError',
  'DriveAuthError',
  'DriveProtocolError',
  'VaultNotReadyError',
])

// ---------------------------------------------------------------------------------------------
// Env (test seam)
// ---------------------------------------------------------------------------------------------

export interface MediaEnv {
  /** Unix milliseconds for `lastAccess`. */
  now: () => number
  /**
   * Phase 16.2 hook point: the sealed envelope of web media that is still in the outbox
   * (`outbox/m-<id>`), or null. Consulted only for ids the synced metadata does not know.
   */
  pendingMediaResolver: ((mediaId: string, thumb: boolean) => Promise<Uint8Array | null>) | null
  /** Size cap in bytes. */
  maxBytes: number
  /** The current key ring; throws `VaultLockedError` when locked. */
  keyRing: () => KeyRing
}

let injected: Partial<MediaEnv> = {}

export const mediaEnv = (): MediaEnv => ({
  now: () => Date.now(),
  pendingMediaResolver: null,
  maxBytes: MAX_WEB_MEDIA_BYTES,
  keyRing: getKeyRing,
  ...injected,
})

/** Test seam: override injected pieces. Pass `{}` to restore the defaults. */
export function configureMediaEnv(partial: Partial<MediaEnv>): void {
  injected = partial
}

// ---------------------------------------------------------------------------------------------
// Owner lookup
// ---------------------------------------------------------------------------------------------

interface Owner {
  entryId: string
  deviceId: string
  fileType: string
  fileSize: number | null
  width: number | null
  height: number | null
  isOutbox?: boolean
  /** For web media: the web device whose `outbox/` holds it (it may not own the entry). */
  outboxDevice?: string
  /** Found in a month index row (the entry is not loaded): re-checked through the index. */
  fromIndex?: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** Media ids end up in a Drive path: same rule as the puller's entry ids. */
export const isSafeMediaId = (id: string): boolean =>
  isSafeComponent(id) && !id.startsWith('.') && id !== '__proto__'

function tombstonedAt(entry: VaultEntry, mediaId: string): number | null {
  const list = entry.metadata.deleted_media
  if (!Array.isArray(list)) return null
  for (const row of list as unknown[]) {
    if (isRecord(row) && row.id === mediaId) return num(row.deleted_at)
  }
  return null
}

function ownerIn(entry: VaultEntry, mediaId: string): Owner | null {
  const list = entry.metadata.media
  if (!Array.isArray(list)) return null
  for (const row of list as unknown[]) {
    if (!isRecord(row) || row.id !== mediaId) continue
    const deletedAt = tombstonedAt(entry, mediaId)
    const createdAt = num(row.created_at)
    if (deletedAt !== null && (createdAt === null || createdAt <= deletedAt)) return null
    return {
      entryId: entry.metadata.entry_id,
      deviceId: entry.metadata.device_id,
      fileType: typeof row.file_type === 'string' ? row.file_type : '',
      fileSize: num(row.file_size),
      width: num(row.width),
      height: num(row.height),
      isOutbox: row.is_outbox === true,
      ...(typeof row.outbox_device === 'string' ? { outboxDevice: row.outbox_device } : {}),
    }
  }
  return null
}

type IndexLookup = Pick<MonthIndexReader, 'findMedia'> | null

/** A visible index row of an entry the vault does not hold; null otherwise. */
function indexOwner(vault: VaultApi, index: IndexLookup, mediaId: string): Owner | null {
  const found = index?.findMedia(mediaId) ?? null
  if (found === null || found.media.id !== mediaId) return null
  if (vault.status(found.entryId) !== 'not-loaded') return null
  return {
    entryId: found.entryId,
    deviceId: found.authorDevice,
    fileType: found.media.file_type,
    fileSize: found.media.file_size,
    width: found.media.width,
    height: found.media.height,
    fromIndex: true,
  }
}

/** The loaded copy still carries the media, not tombstoned: media.ts would serve it. */
export const hasLiveMedia = (entry: VaultEntry, mediaId: string): boolean =>
  ownerIn(entry, mediaId) !== null

function findOwner(vault: VaultApi, mediaId: string, index: IndexLookup = null): Owner | null {
  for (const entry of vault.listLoaded()) {
    const owner = ownerIn(entry, mediaId)
    if (owner !== null) return owner
  }
  return indexOwner(vault, index, mediaId)
}

/** The owning entry must still be visible: it may have been locked or unloaded while we awaited. */
function assertServable(
  vault: VaultApi,
  owner: Owner,
  mediaId: string,
  index: IndexLookup = null,
): void {
  if (!readEnv().isUnlocked()) throw new VaultLockedError()
  if (owner.fromIndex === true) {
    // Still a visible row of the same entry, and the vault still does not hold that entry: a copy
    // loaded meanwhile is authoritative (it may have dropped the media), a refused one hides it.
    const found = index?.findMedia(mediaId) ?? null
    if (found?.entryId !== owner.entryId || vault.status(owner.entryId) !== 'not-loaded') {
      throw new MediaNotFoundError(mediaId)
    }
    return
  }
  try {
    vault.getEntry(owner.entryId)
  } catch {
    throw new MediaNotFoundError(mediaId)
  }
}

// ---------------------------------------------------------------------------------------------
// Download and cache (ciphertext only)
// ---------------------------------------------------------------------------------------------

const cacheKey = (mediaId: string, thumb: boolean): string =>
  `media/${mediaId}${thumb ? '.thumb' : ''}`

const inflight = new Map<string, Promise<Fetched | null>>()

function isMissing(error: unknown): boolean {
  return (
    error instanceof RangeError || (error instanceof Error && error.name === 'DriveNotFoundError')
  )
}

/** Known device folders (those with a cached manifest) other than `device`, sorted. */
async function otherDevices(backend: MediaBackend, device: string): Promise<string[]> {
  const found = new Set<string>()
  for (const path of await backend.db.files.paths()) {
    const m = /^([^/]+)\/metadata\.json$/.exec(path)
    if (m !== null && m[1] !== device && isPayloadDeviceFolderName(m[1])) found.add(m[1])
  }
  return [...found].sort()
}

/** Ciphertext of one file from Drive, or null when no candidate device folder has it. */
async function downloadCiphertext(
  backend: MediaBackend,
  owner: Owner,
  mediaId: string,
  thumb: boolean,
  maxBytes: number,
  oversize: () => Error,
): Promise<Uint8Array | null> {
  const record = await backend.db.device.get()
  if (record === undefined) throw new Error('This browser is not enrolled')
  const generation = record.recoveryGeneration
  const name = `${mediaId}${thumb ? '.thumb' : ''}`
  const devices = isPayloadDeviceFolderName(owner.deviceId) ? [owner.deviceId] : []
  // Web media lives in the outbox of the browser that added it, which is not the entry's owner when
  // another browser added it to a desktop entry: try that folder first.
  if (owner.outboxDevice !== undefined && isPayloadDeviceFolderName(owner.outboxDevice)) {
    devices.unshift(owner.outboxDevice)
  }
  devices.push(...(await otherDevices(backend, owner.deviceId)).filter((d) => !devices.includes(d)))
  let mismatch: Error | null = null // a stale copy on one device must not hide a good one elsewhere
  for (const device of devices) {
    const candidatePath = owner.isOutbox ? `${device}/outbox/m-${name}` : `${device}/media/${name}`
    try {
      const bytes = await backend.reader.readDeviceFile(generation, candidatePath, maxBytes)
      if (bytes.length > maxBytes) throw oversize()
      return bytes
    } catch (error) {
      const tooBig =
        error instanceof TooLargeForWebError ||
        error instanceof MediaSizeMismatchError ||
        (error instanceof Error && error.name === TOO_LARGE_NAME)
      if (tooBig) {
        if (thumb) continue // not a genuine thumbnail: treated as missing
        const failure = oversize()
        if (!(failure instanceof MediaSizeMismatchError)) throw failure // too large: final
        mismatch = failure
        continue
      }
      if (isMissing(error)) continue
      if (error instanceof Error && TRANSIENT_NAMES.has(error.name)) {
        throw new MediaTransientError(error)
      }
      throw error
    }
  }
  if (mismatch !== null) throw mismatch
  return null
}

interface Fetched {
  cipher: Uint8Array
  /** What `verify` produced from `cipher`; reused so a read decrypts once. */
  plain: Uint8Array
}

/**
 * Ciphertext from the cache or Drive, with the plaintext the verification produced. Opens it once
 * (`openMedia`) BEFORE it is cached, so a tampered or half-downloaded file is never stored; a body
 * over `maxBytes` is never buffered nor stored. One download per key and cap in flight, under the
 * shared concurrency limiter.
 */
function fetchCiphertext(
  backend: MediaBackend,
  owner: Owner,
  mediaId: string,
  thumb: boolean,
  verify: (bytes: Uint8Array) => Uint8Array,
  maxBytes: number,
  oversize: () => Error = () => new TooLargeForWebError(),
): Promise<Fetched | null> {
  const key = cacheKey(mediaId, thumb)
  const flight = `${key}:${maxBytes}:${oversize().name}`
  const pending = inflight.get(flight)
  if (pending !== undefined) return pending
  const task = (async (): Promise<Fetched | null> => {
    let cached = await backend.db.blobs.get(key)
    if (cached === undefined && owner.isOutbox) {
      const outboxKey = `outbox/m-${mediaId}${thumb ? '.thumb' : ''}`
      cached = await backend.db.blobs.get(outboxKey)
    }
    if (cached !== undefined) {
      try {
        const plain = verify(cached.bytes)
        const now = mediaEnv().now()
        if (now - cached.lastAccess >= TOUCH_INTERVAL_MS) {
          await backend.db.blobs.touch(key, now).catch(() => undefined)
        }
        return { cipher: cached.bytes, plain }
      } catch (error) {
        if (!(error instanceof MediaCorruptError)) throw error
        await backend.db.blobs.delete(key) // damaged local copy: drop it and download again
      }
    }
    const bytes = await backend.limit(() =>
      downloadCiphertext(backend, owner, mediaId, thumb, maxBytes, oversize),
    )
    if (bytes === null) return null
    const plain = verify(bytes) // throws MediaCorruptError: nothing is stored
    if (readEnv().isUnlocked()) {
      // Best effort: a full store must not fail the read.
      await backend.db.blobs
        .put({ path: key, bytes, size: bytes.length, lastAccess: mediaEnv().now() })
        .then(notifyCacheWrite, () => undefined)
    }
    return { cipher: bytes, plain }
  })().finally(() => {
    inflight.delete(flight)
  })
  inflight.set(flight, task)
  return task
}

// ---------------------------------------------------------------------------------------------
// Core flow
// ---------------------------------------------------------------------------------------------

interface Opened {
  backend: MediaBackend
  vault: VaultApi
  index: IndexLookup
}

async function open(): Promise<Opened> {
  const env = readEnv()
  if (!env.isUnlocked()) throw new VaultLockedError()
  const session = await env.session()
  await session.ready()
  if (session.media === undefined) throw new Error('media backend is not available')
  return { backend: session.media, vault: session.vault, index: session.monthIndex ?? null }
}

function mediaIdArg(args: Record<string, unknown>): string {
  return typeof args.mediaId === 'string' ? args.mediaId : ''
}

function ownerOrThrow(vault: VaultApi, mediaId: string, index: IndexLookup): Owner {
  const owner = isSafeMediaId(mediaId) ? findOwner(vault, mediaId, index) : null
  if (owner === null) throw new MediaNotFoundError(mediaId)
  return owner
}

/** Opens one envelope with the current ring; any failure is a typed `MediaCorruptError`. */
function opener(backend: MediaBackend): (bytes: Uint8Array) => Uint8Array {
  return (bytes) => {
    const ring = mediaEnv().keyRing() // VaultLockedError propagates untouched
    try {
      return backend.core.openMedia(ring, bytes)
    } catch (error) {
      throw new MediaCorruptError(error)
    }
  }
}

/**
 * The recorded size when it is usable. 0, negative and non-finite values are UNKNOWN: desktop
 * stores 0 when it cannot read the file metadata, so 0 must not become a 64-byte cap.
 */
function declaredSize(owner: Owner): number | null {
  const size = owner.fileSize
  return size !== null && Number.isFinite(size) && size > 0 ? size : null
}

/** Ciphertext cap of a full media: the (valid) metadata size, never above the plaintext cap. */
function fullCipherCap(owner: Owner, plainCap: number): number {
  return Math.min(declaredSize(owner) ?? plainCap, plainCap) + ENVELOPE_OVERHEAD_BYTES
}

/**
 * Plaintext of the full media, or of its thumbnail (falling back to the full file when the
 * thumbnail is missing, oversize or corrupt). `plainCap` is the largest plaintext served.
 */
async function readPlain(
  mediaId: string,
  wantThumb: boolean,
  plainCap: number = mediaEnv().maxBytes,
): Promise<Uint8Array> {
  const { backend, vault, index } = await open()
  const env = mediaEnv()
  const cap = Math.min(plainCap, env.maxBytes)
  const owner = isSafeMediaId(mediaId) ? findOwner(vault, mediaId, index) : null
  if (owner === null) {
    // Not in the synced metadata: only a pending web upload can still resolve.
    const pending = isSafeMediaId(mediaId)
      ? await env.pendingMediaResolver?.(mediaId, wantThumb)
      : null
    if (pending === undefined || pending === null) throw new MediaNotFoundError(mediaId)
    return opener(backend)(pending)
  }
  assertServable(vault, owner, mediaId, index) // before any request
  const verify = opener(backend)
  if (wantThumb) {
    try {
      const thumb = await fetchCiphertext(
        backend,
        owner,
        mediaId,
        true,
        verify,
        MAX_THUMB_BYTES + ENVELOPE_OVERHEAD_BYTES,
      )
      if (thumb !== null) {
        assertServable(vault, owner, mediaId, index)
        return thumb.plain
      }
    } catch (error) {
      if (!(error instanceof MediaCorruptError)) throw error // corrupt: use the full file
    }
  }
  const declared = declaredSize(owner)
  if (declared !== null && declared > cap) throw new TooLargeForWebError()
  const full = await fetchCiphertext(
    backend,
    owner,
    mediaId,
    false,
    verify,
    fullCipherCap(owner, cap),
    // A body above a declared size (smaller than the cap) means the metadata is wrong, not "huge".
    declared !== null && declared < cap
      ? () => new MediaSizeMismatchError()
      : () => new TooLargeForWebError(),
  )
  if (full === null) throw new MediaNotFoundError(mediaId)
  assertServable(vault, owner, mediaId, index)
  if (full.plain.length > cap) throw new TooLargeForWebError()
  return full.plain
}

const readBytes =
  (thumb: boolean): Handler =>
  async (args) =>
    Array.from(await readPlain(mediaIdArg(args), thumb, TOO_LARGE_FOR_NUMBER_ARRAY))

const resolve =
  (thumb: boolean): Handler =>
  async (args) => {
    const mediaId = mediaIdArg(args)
    await readPlain(mediaId, thumb) // downloads, verifies and caches; the plaintext is dropped
    return `${WEB_MEDIA_PATH_PREFIX}${mediaId}${thumb ? '.thumb' : ''}`
  }

/** Desktop `MediaStatus`: everything is reported available; no request is made. */
const getMediaStatus: Handler = async (args) => {
  const mediaId = mediaIdArg(args)
  const { vault, index } = await open()
  const owner = ownerOrThrow(vault, mediaId, index)
  assertServable(vault, owner, mediaId, index)
  const hasThumb = owner.fileType.startsWith('image/') || owner.fileType.startsWith('video/')
  return {
    mediaId,
    cachedLocally: true,
    hasCloudCopy: true,
    localPath: `${WEB_MEDIA_PATH_PREFIX}${mediaId}`,
    thumbnailPath: hasThumb ? `${WEB_MEDIA_PATH_PREFIX}${mediaId}.thumb` : null,
    fileType: owner.fileType,
    fileSize: owner.fileSize,
    compressed: false,
    width: owner.width,
    height: owner.height,
  }
}

export const mediaHandlers: Record<string, Handler> = {
  read_media_bytes: readBytes(false),
  read_media_thumbnail_bytes: readBytes(true),
  resolve_media: resolve(false),
  resolve_media_thumbnail: resolve(true),
  get_media_status: getMediaStatus,
}
