/**
 * Guarded Google Drive client for the web app (appDataFolder, scope drive.appdata).
 *
 * SAFETY-CRITICAL: the web must never damage a desktop vault. The module is split in two:
 *
 *  - `DriveReader`: read-only (list, get, path resolution, desktop-compatible device reads).
 *  - `DriveWriter`: the ONLY mutating surface. Every write is checked against the allowlist in
 *    `paths.ts` BEFORE any network call, runs under one cross-tab lock, updates in place with
 *    `If-Match`, creates a file only when none exists, and may create only `<ownId>` and
 *    `<ownId>/outbox` under an existing `generations/g-<localGen>`.
 *
 * There is deliberately no delete, trash, move or rename anywhere in this module: no method for
 * it exists, and no request it builds can carry such an operation (only GET, POST of a new
 * object, and PATCH of the media bytes of an existing file).
 *
 * Only `safeUpload.ts` (Phase 15.4) and `onboard.ts` (Phase 9) may import `DriveWriter`
 * (an ESLint rule is added in 15.4). Everything else imports `DriveReader` only.
 *
 * Mirrors `src-tauri/src/sync/gdrive_provider.rs`: `spaces=appDataFolder`, root folder
 * `Memlore`, multipart upload, ETag / If-Match, 4 attempts with 400 ms base backoff capped at
 * 5 s, `Retry-After` honoured (capped at 10 s like desktop). Differences from desktop are
 * called out where they matter (list paging; duplicate-folder choice; write retries).
 */

import {
  APPDATA_PARENT,
  DEVICE_SLOT_FOLDERS,
  GENERATIONS_FOLDER,
  OUTBOX_FOLDER,
  ROOT_FOLDER_NAME,
  generationFolderName,
  isAllowedSharedReadPath,
  isAllowedWritePath,
  isPayloadDeviceFolderName,
  isSafeComponent,
  isValidGeneration,
  isValidOwnId,
  parseLogicalPath,
  splitPath,
} from './paths'
import { updateClockOffset } from '../clock'

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

/** A write targeted a path outside the allowlist (or identity is unset). Thrown before any fetch. */
export class ForbiddenWriteError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ForbiddenWriteError'
  }
}

/**
 * A shared ancestor the desktop owns is missing. UI: "open the desktop app once to finish
 * setting up sync". The web never creates shared folders.
 */
export class VaultNotReadyError extends Error {
  readonly missing: string
  constructor(missing: string) {
    super(
      `Vault not ready: ${missing} is missing; open the desktop app once to finish setting up sync`,
    )
    this.name = 'VaultNotReadyError'
    this.missing = missing
  }
}

/** 401: the access token is not accepted. Not retried; the caller refreshes the token. */
export class DriveAuthError extends Error {
  constructor() {
    super('Drive rejected the access token')
    this.name = 'DriveAuthError'
  }
}

/** 404 on a direct file request. */
export class DriveNotFoundError extends Error {
  constructor(what: string) {
    super(`Drive file not found: ${what}`)
    this.name = 'DriveNotFoundError'
  }
}

/** 412 on an If-Match update: the file changed under us. Never overwritten blindly. */
export class DriveConflictError extends Error {
  constructor() {
    super('Drive file changed since it was read (If-Match failed)')
    this.name = 'DriveConflictError'
  }
}

/** Any other non-success status, or a transport failure (status 0). */
export class DriveHttpError extends Error {
  readonly status: number
  constructor(status: number, message?: string) {
    super(message ?? `Drive request failed (${status})`)
    this.name = 'DriveHttpError'
    this.status = status
  }
}

/** The API answered with an unexpected shape (missing id/etag, bad JSON). Fail closed. */
export class DriveProtocolError extends Error {
  constructor(message: string) {
    super(`Unexpected Drive response: ${message}`)
    this.name = 'DriveProtocolError'
  }
}

/** A download is larger than the caller's `maxBytes`; the body was not (fully) read. */
export class DriveTooLargeError extends Error {
  readonly maxBytes: number
  constructor(maxBytes: number) {
    super(`Drive file is larger than ${maxBytes} bytes`)
    this.name = 'DriveTooLargeError'
    this.maxBytes = maxBytes
  }
}

/** Writes need the Web Locks API; without it they fail closed instead of running unlocked. */
export class LockUnavailableError extends Error {
  constructor(
    message = 'navigator.locks is unavailable; refusing to write without the single-writer lock',
  ) {
    super(message)
    this.name = 'LockUnavailableError'
  }
}

// ---------------------------------------------------------------------------------------------
// Transport (shared by reader and writer)
// ---------------------------------------------------------------------------------------------

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface LockManagerLike {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>
}

export interface DriveDeps {
  /** Bearer token provider (oauth.ts getAccessToken); called per attempt. */
  getToken: () => Promise<string>
  fetchImpl?: FetchLike
  sleep?: (ms: number) => Promise<void>
  /** Default `https://www.googleapis.com`. */
  apiBase?: string
  /** Default `https://www.googleapis.com/upload`. */
  uploadBase?: string
}

/** Total attempts per request (1 initial + 3 retries), as desktop `RETRY_MAX_ATTEMPTS`. */
export const RETRY_MAX_ATTEMPTS = 4
export const RETRY_BASE_MS = 400
export const RETRY_CAP_MS = 5_000
/** Server-requested Retry-After is capped, as desktop `RETRY_AFTER_CAP_SECS`. */
export const RETRY_AFTER_CAP_SECS = 10

const FOLDER_MIME = 'application/vnd.google-apps.folder'
const MAX_PAGES = 1_000

interface Transport {
  readonly getToken: () => Promise<string>
  readonly fetchImpl: FetchLike
  readonly sleep: (ms: number) => Promise<void>
  readonly apiBase: string
  readonly uploadBase: string
}

function makeTransport(deps: DriveDeps): Transport {
  return {
    getToken: deps.getToken,
    fetchImpl: deps.fetchImpl ?? ((input, init) => globalThis.fetch(input, init)),
    sleep: deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
    apiBase: deps.apiBase ?? 'https://www.googleapis.com',
    uploadBase: deps.uploadBase ?? 'https://www.googleapis.com/upload',
  }
}

function retryDelayMs(response: Response, attempt: number): number {
  const header = response.headers.get('retry-after')
  if (header !== null && /^\d+$/.test(header.trim())) {
    return Math.min(Number(header.trim()), RETRY_AFTER_CAP_SECS) * 1_000
  }
  return Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_CAP_MS)
}

/**
 * Send one request with bearer auth. Reads (`idempotent`) retry on 429 and 5xx; writes retry on
 * 429 only (the request was not processed), because desktop never retries a write after a 5xx
 * (the first attempt may have succeeded and a second create would duplicate the file).
 * 401 is never retried. Transport errors are surfaced immediately. Returns the final response,
 * which the caller classifies with `ensureOk`.
 */
async function send(
  t: Transport,
  url: string,
  init: RequestInit,
  idempotent: boolean,
): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    const token = await t.getToken()
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${token}`)
    let response: Response
    try {
      response = await t.fetchImpl(url, { ...init, headers })
    } catch (error) {
      throw new DriveHttpError(0, error instanceof Error ? error.message : 'network error')
    }
    const dateHeader = response.headers.get('date')
    if (dateHeader) updateClockOffset(dateHeader)
    const retryable = response.status === 429 || (idempotent && response.status >= 500)
    if (!retryable || attempt >= RETRY_MAX_ATTEMPTS) return response
    await t.sleep(retryDelayMs(response, attempt))
  }
}

function ensureOk(response: Response, what: string): void {
  if (response.ok) return
  if (response.status === 401) throw new DriveAuthError()
  if (response.status === 404) throw new DriveNotFoundError(what)
  if (response.status === 412) throw new DriveConflictError()
  throw new DriveHttpError(response.status)
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    throw new DriveProtocolError('response body is not JSON')
  }
}

/**
 * Default cap of a download without an explicit `maxBytes`: far above any entry payload (33 MiB
 * at the WASM layer), manifest or journal, far below what could crash the tab. Media passes its
 * own, larger, cap.
 */
export const DEFAULT_MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024

const PREALLOC_CAP_BYTES = 8 * 1024 * 1024
const MIN_GROW_BYTES = 64 * 1024

/**
 * The body bytes, never more than `maxBytes`: a declared `Content-Length` over the cap is refused
 * before the body is read, and the stream is cancelled the moment the running count exceeds it.
 *
 * Memory: one growing buffer the chunks are written straight into. A valid `Content-Length`
 * (<= the cap) preallocates at most `PREALLOC_CAP_BYTES` of it, and the buffer doubles (up to the
 * cap, copying) beyond that, so a lying header cannot force a huge zeroed allocation. The running
 * count enforces the cap whatever the header says. The result is ALWAYS exactly `total` bytes
 * backed by an `ArrayBuffer` of exactly `total` bytes (a copy when the buffer was larger): a view
 * over a bigger buffer would let structured clone persist the hidden tail and hide it from size
 * accounting.
 */
async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = response.headers.get('content-length')
  const length = declared !== null && /^\d+$/.test(declared.trim()) ? Number(declared) : null
  if (length !== null && length > maxBytes) {
    await response.body?.cancel().catch(() => undefined)
    throw new DriveTooLargeError(maxBytes)
  }
  const stream = response.body
  if (stream === null) return new Uint8Array(0)
  const reader = stream.getReader()
  let buffer = new Uint8Array(length === null ? 0 : Math.min(length, PREALLOC_CAP_BYTES))
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    const end = total + value.byteLength
    if (end > maxBytes) {
      await reader.cancel().catch(() => undefined)
      throw new DriveTooLargeError(maxBytes)
    }
    if (end > buffer.byteLength) {
      const grown = new Uint8Array(
        Math.min(maxBytes, Math.max(end, buffer.byteLength * 2, MIN_GROW_BYTES)),
      )
      grown.set(buffer.subarray(0, total))
      buffer = grown
    }
    buffer.set(value, total)
    total = end
  }
  return total === buffer.byteLength ? buffer : buffer.slice(0, total)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Drive ids are opaque but url-safe; refuse anything else before it enters a URL or query. */
function assertDriveId(id: unknown, what: string): string {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new DriveProtocolError(`${what} id is missing or malformed`)
  }
  return id
}

function escapeQuery(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

export interface DriveFile {
  id: string
  name: string
  createdTime: string | null
}

/**
 * Canonical choice among same-named objects: earliest createdTime, then id ascending (a
 * deterministic tie-break). NOTE: desktop does "earliest-created wins" only for the root
 * `Memlore` folder; for every other folder it takes the first `find_folder` result with no
 * orderBy. The web uses earliest-created everywhere because it is deterministic and safe; that
 * is NOT desktop parity. Duplicates are never deleted or merged. With several candidates a
 * missing or unparsable createdTime is ambiguity and throws.
 */
function canonicalOrder(files: DriveFile[]): DriveFile[] {
  if (files.length < 2) return files
  const keyed = files.map((file) => {
    const time = file.createdTime === null ? Number.NaN : Date.parse(file.createdTime)
    if (Number.isNaN(time)) throw new DriveProtocolError('duplicate names without a createdTime')
    return { file, time }
  })
  keyed.sort(
    (a, b) => a.time - b.time || (a.file.id < b.file.id ? -1 : a.file.id > b.file.id ? 1 : 0),
  )
  return keyed.map((entry) => entry.file)
}

// ---------------------------------------------------------------------------------------------
// DriveReader
// ---------------------------------------------------------------------------------------------

export interface FileMeta {
  id: string
  name: string
  /** `ETag` response header, or null when Drive omitted it (the writer then refuses to update). */
  etag: string | null
}

export interface ResolvedFile {
  id: string
  parentId: string
}

export class DriveReader {
  readonly #t: Transport

  constructor(deps: DriveDeps) {
    this.#t = makeTransport(deps)
  }

  /**
   * One query, all pages (`nextPageToken`). Desktop does not page its lists; the web does so a
   * large device folder cannot hide files. Returns files in the server's order.
   */
  async #list(q: string, orderBy?: string): Promise<DriveFile[]> {
    const out: DriveFile[] = []
    let pageToken: string | null = null
    for (let page = 0; page < MAX_PAGES; page++) {
      const params = new URLSearchParams({
        q,
        fields: 'nextPageToken,files(id,name,createdTime)',
        spaces: APPDATA_PARENT,
        pageSize: '1000',
      })
      if (orderBy) params.set('orderBy', orderBy)
      if (pageToken !== null) params.set('pageToken', pageToken)
      const response = await send(
        this.#t,
        `${this.#t.apiBase}/drive/v3/files?${params.toString()}`,
        { method: 'GET' },
        true,
      )
      ensureOk(response, 'list')
      const body = await readJson(response)
      if (!isRecord(body) || !Array.isArray(body.files)) {
        throw new DriveProtocolError('list response has no files array')
      }
      for (const item of body.files) {
        if (!isRecord(item) || typeof item.name !== 'string') {
          throw new DriveProtocolError('list entry has no name')
        }
        out.push({
          id: assertDriveId(item.id, 'listed file'),
          name: item.name,
          createdTime: typeof item.createdTime === 'string' ? item.createdTime : null,
        })
      }
      const next = body.nextPageToken
      if (next === undefined || next === null || next === '') return out
      if (typeof next !== 'string' || next === pageToken) {
        throw new DriveProtocolError('bad nextPageToken')
      }
      pageToken = next
    }
    throw new DriveProtocolError('too many pages')
  }

  /** Canonical-first candidates for a folder name under a parent. */
  async findFolders(name: string, parentId: string): Promise<DriveFile[]> {
    assertDriveId(parentId, 'parent')
    const q = `name = '${escapeQuery(name)}' and mimeType = '${FOLDER_MIME}' and '${parentId}' in parents and trashed = false`
    return canonicalOrder(await this.#list(q, 'createdTime'))
  }

  /** Canonical-first candidates for a non-folder file name under a parent. */
  async findFiles(name: string, parentId: string): Promise<DriveFile[]> {
    assertDriveId(parentId, 'parent')
    const q = `name = '${escapeQuery(name)}' and mimeType != '${FOLDER_MIME}' and '${parentId}' in parents and trashed = false`
    return canonicalOrder(await this.#list(q, 'createdTime'))
  }

  async findFolder(name: string, parentId: string): Promise<string | null> {
    return (await this.findFolders(name, parentId))[0]?.id ?? null
  }

  async findFile(name: string, parentId: string): Promise<DriveFile | null> {
    return (await this.findFiles(name, parentId))[0] ?? null
  }

  /** The earliest-created `Memlore` folder directly under appDataFolder, or null. */
  async findRootId(): Promise<string | null> {
    return this.findFolder(ROOT_FOLDER_NAME, APPDATA_PARENT)
  }

  /** Walk folder segments from the Memlore root. Null when the root or any segment is missing. */
  async findFolderPath(segments: readonly string[]): Promise<string | null> {
    let current = await this.findRootId()
    for (const segment of segments) {
      if (current === null) return null
      current = await this.findFolder(segment, current)
    }
    return current
  }

  /** Child entries of a folder: sub-folders or non-folder files. */
  async listFolder(parentId: string, kind: 'files' | 'folders'): Promise<DriveFile[]> {
    assertDriveId(parentId, 'parent')
    const op = kind === 'folders' ? '=' : '!='
    const q = `mimeType ${op} '${FOLDER_MIME}' and '${parentId}' in parents and trashed = false`
    return this.#list(q)
  }

  /**
   * Resolve a Memlore-relative physical path (e.g. `.meta/keyring/devices/x.json`) to the
   * canonical file id and its parent folder. Null when any folder or the file is missing.
   * Never creates anything.
   */
  async resolvePath(path: string): Promise<ResolvedFile | null> {
    const split = splitPath(path)
    if (split === null) throw new RangeError(`unsafe path: ${JSON.stringify(path)}`)
    const parentId = await this.findFolderPath(split.folders)
    if (parentId === null) return null
    const file = await this.findFile(split.name, parentId)
    return file === null ? null : { id: file.id, parentId }
  }

  /** Metadata GET (never `fields=etag`, which 400s on Drive v3); the ETag is a response header. */
  async getMeta(fileId: string): Promise<FileMeta> {
    assertDriveId(fileId, 'file')
    const response = await send(
      this.#t,
      `${this.#t.apiBase}/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name`,
      { method: 'GET' },
      true,
    )
    ensureOk(response, fileId)
    const body = await readJson(response)
    if (!isRecord(body) || typeof body.name !== 'string') {
      throw new DriveProtocolError('metadata has no name')
    }
    const etag = response.headers.get('etag')
    return {
      id: assertDriveId(body.id, 'metadata'),
      name: body.name,
      etag: etag !== null && etag !== '' ? etag : null,
    }
  }

  /**
   * Download a file's bytes (`alt=media`), at most `maxBytes` (default 64 MiB): a larger body
   * throws `DriveTooLargeError` without being buffered whole.
   */
  async getFile(
    fileId: string,
    maxBytes: number = DEFAULT_MAX_DOWNLOAD_BYTES,
  ): Promise<Uint8Array> {
    assertDriveId(fileId, 'file')
    const response = await send(
      this.#t,
      `${this.#t.apiBase}/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`,
      { method: 'GET' },
      true,
    )
    ensureOk(response, fileId)
    const bytes = await readCapped(response, maxBytes)
    if (bytes.length > maxBytes) throw new DriveTooLargeError(maxBytes)
    return bytes
  }

  /** Read an allowlisted shared file (control.json, keyring files, device slots). */
  async readSharedFile(path: string): Promise<Uint8Array> {
    if (!isAllowedSharedReadPath(path)) throw new RangeError(`not a shared path: ${path}`)
    const resolved = await this.resolvePath(path)
    if (resolved === null) throw new DriveNotFoundError(path)
    return this.getFile(resolved.id)
  }

  /** `generations/g-<N>` folder id, or null when `generations` or `g-<N>` is missing. */
  async findGenerationRoot(rootId: string, generation: number): Promise<string | null> {
    const generations = await this.findFolder(GENERATIONS_FOLDER, rootId)
    if (generations === null) return null
    return this.findFolder(generationFolderName(generation), generations)
  }

  async #deviceNamesUnder(parentId: string): Promise<string[]> {
    const folders = await this.listFolder(parentId, 'folders')
    return folders.map((f) => f.name).filter(isPayloadDeviceFolderName)
  }

  /**
   * Device ids, desktop `list_devices` rule: the generation folder's devices, plus the flat
   * root's devices (legacy layout); with no `generations/g-<N>` only the flat root. Sorted.
   */
  async listDevices(generation: number): Promise<string[]> {
    const rootId = await this.findRootId()
    if (rootId === null) return []
    const names = new Set<string>()
    const genRoot = await this.findGenerationRoot(rootId, generation)
    if (genRoot !== null) {
      for (const name of await this.#deviceNamesUnder(genRoot)) names.add(name)
    }
    for (const name of await this.#deviceNamesUnder(rootId)) names.add(name)
    return [...names].sort()
  }

  /**
   * Device folders to READ, desktop `resolve_device_folders_for_read`: the generation device
   * folder first (if it exists), then the flat `Memlore/<device>` folder. Without a
   * `generations/g-<N>` folder only the flat one. An empty generation folder does not hide
   * flat files.
   */
  async #deviceFoldersForRead(
    rootId: string,
    generation: number,
    device: string,
  ): Promise<string[]> {
    const folders: string[] = []
    const genRoot = await this.findGenerationRoot(rootId, generation)
    if (genRoot !== null) {
      const inGen = await this.findFolder(device, genRoot)
      if (inGen !== null) folders.push(inGen)
    }
    const flat = await this.findFolder(device, rootId)
    if (flat !== null && !folders.includes(flat)) folders.push(flat)
    return folders
  }

  /**
   * File names of one device channel. `subfolder` null is the device root: the generation
   * folder ONLY (no flat fallback, desktop DeviceRoot rule). Otherwise generation and flat
   * folders are merged, the same name keeping its generation copy. Sorted, files only.
   */
  async listDeviceFiles(
    generation: number,
    device: string,
    subfolder: string | null,
  ): Promise<string[]> {
    if (!isSafeComponent(device) || (subfolder !== null && !isSafeComponent(subfolder))) {
      throw new RangeError('unsafe device or subfolder')
    }
    const rootId = await this.findRootId()
    if (rootId === null) return []
    const names = new Set<string>()
    if (subfolder === null) {
      const genRoot = await this.findGenerationRoot(rootId, generation)
      const deviceFolder = genRoot === null ? null : await this.findFolder(device, genRoot)
      if (deviceFolder !== null) {
        for (const f of await this.listFolder(deviceFolder, 'files')) names.add(f.name)
      }
    } else {
      for (const folder of await this.#deviceFoldersForRead(rootId, generation, device)) {
        const sub = await this.findFolder(subfolder, folder)
        if (sub === null) continue
        for (const f of await this.listFolder(sub, 'files')) names.add(f.name)
      }
    }
    return [...names].sort()
  }

  /**
   * Read a logical `<device>/[<subfolder>/]<file>`: the generation folder first, then the flat
   * one; the first folder containing the file wins. Throws DriveNotFoundError when absent.
   */
  async readDeviceFile(
    generation: number,
    path: string,
    maxBytes: number = DEFAULT_MAX_DOWNLOAD_BYTES,
  ): Promise<Uint8Array> {
    const parsed = parseLogicalPath(path)
    if (parsed === null) throw new RangeError(`invalid logical path: ${JSON.stringify(path)}`)
    const rootId = await this.findRootId()
    if (rootId === null) throw new DriveNotFoundError(path)
    for (const folder of await this.#deviceFoldersForRead(rootId, generation, parsed.device)) {
      const parent =
        parsed.subfolder === null ? folder : await this.findFolder(parsed.subfolder, folder)
      if (parent === null) continue
      const file = await this.findFile(parsed.filename, parent)
      if (file !== null) return this.getFile(file.id, maxBytes)
    }
    throw new DriveNotFoundError(path)
  }
}

// ---------------------------------------------------------------------------------------------
// DriveWriter (ONLY safeUpload.ts and onboard.ts may import this; see header)
// ---------------------------------------------------------------------------------------------

export interface WriterIdentity {
  ownId: string
  localGen: number
}

export interface PutResult {
  fileId: string
  /** True when no file existed and we created one. */
  created: boolean
  /**
   * True when a file we just created was NOT the earliest of its name: the earlier one is the
   * canonical file and our copy stays untouched (never deleted). Put again to update the canonical.
   */
  adoptedOther: boolean
}

export interface EnsureFolderResult {
  deviceFolderId: string
  outboxFolderId: string
}

/**
 * Writes available to a `withLock` task. They run under the lock the task already holds and do
 * not re-acquire it; they refuse once the task has settled (the lock is released).
 */
export interface WriterLockHandle {
  put(path: string, bytes: Uint8Array): Promise<PutResult>
  ensureFolder(): Promise<EnsureFolderResult>
}

export interface DriveWriterDeps extends DriveDeps {
  /**
   * Lock manager. Omitted: `navigator.locks` is read at call time. `null`, or no
   * `navigator.locks`: writes fail closed with LockUnavailableError.
   */
  locks?: LockManagerLike | null
}

export const WRITER_LOCK_NAME = 'memlore-web-writer'

function randomBoundary(): string {
  const raw = new Uint8Array(16)
  globalThis.crypto.getRandomValues(raw)
  return `memlore_${Array.from(raw, (b) => b.toString(16).padStart(2, '0')).join('')}`
}

function multipartBody(
  boundary: string,
  metadata: { name: string; parents: string[] },
  contentType: string,
  data: Uint8Array,
): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder()
  const head = encoder.encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`,
  )
  const tail = encoder.encode(`\r\n--${boundary}--`)
  const body = new Uint8Array(head.length + data.length + tail.length)
  body.set(head, 0)
  body.set(data, head.length)
  body.set(tail, head.length + data.length)
  return body
}

interface CheckedWritePath {
  folders: readonly string[]
  name: string
  contentType: string
}

export class DriveWriter {
  readonly #reader: DriveReader
  readonly #t: Transport
  readonly #locks: LockManagerLike | null | undefined
  #identity: WriterIdentity | null = null

  constructor(reader: DriveReader, deps: DriveWriterDeps) {
    this.#reader = reader
    this.#t = makeTransport(deps)
    this.#locks = deps.locks
  }

  /**
   * Set once after onboarding. A second call with the same values is a no-op; different values
   * throw. `ownId` must be a valid desktop-style device id (8-64 hex/`-`, no dots or slashes).
   */
  setIdentity(identity: WriterIdentity): void {
    if (!isValidOwnId(identity.ownId)) throw new ForbiddenWriteError('invalid ownId')
    if (!isValidGeneration(identity.localGen)) throw new ForbiddenWriteError('invalid localGen')
    const current = this.#identity
    if (current !== null) {
      if (current.ownId === identity.ownId && current.localGen === identity.localGen) return
      throw new ForbiddenWriteError('identity is already set and cannot change')
    }
    this.#identity = { ownId: identity.ownId, localGen: identity.localGen }
  }

  #requireIdentity(): WriterIdentity {
    if (this.#identity === null) throw new ForbiddenWriteError('identity is not set')
    return this.#identity
  }

  /**
   * Acquire the single-writer lock for `task`. Every call requests the lock, so concurrent calls in
   * the same tab are serialized like calls from other tabs. Writes inside `task` must go through
   * the handle it receives: calling the public `put` / `ensureFolder` there would wait on the lock
   * the task holds.
   */
  async withLock<T>(
    task: (handle: WriterLockHandle) => Promise<T>,
    overrideLocks?: LockManagerLike | null,
  ): Promise<T> {
    const locks =
      overrideLocks !== undefined
        ? overrideLocks
        : this.#locks === undefined
          ? (globalThis.navigator as { locks?: LockManagerLike } | undefined)?.locks
          : this.#locks
    if (!locks) throw new LockUnavailableError()
    return locks.request(WRITER_LOCK_NAME, async () => {
      let held = true
      const requireHeld = (): void => {
        if (!held) throw new LockUnavailableError('writer lock handle used after release')
      }
      const handle: WriterLockHandle = {
        put: async (path, bytes) => {
          requireHeld()
          return this.#putUnlocked(path, bytes)
        },
        ensureFolder: async () => {
          requireHeld()
          return this.#ensureFolderUnlocked()
        },
      }
      try {
        return await task(handle)
      } finally {
        held = false
      }
    })
  }

  /** Throws unless every ancestor in `chain` exists (shared ancestors are never created). */
  async #requireChain(chain: readonly string[]): Promise<string> {
    let current = await this.#reader.findRootId()
    if (current === null) throw new VaultNotReadyError(ROOT_FOLDER_NAME)
    for (let i = 0; i < chain.length; i++) {
      const next: string | null = await this.#reader.findFolder(chain[i], current)
      if (next === null) throw new VaultNotReadyError(chain.slice(0, i + 1).join('/'))
      current = next
    }
    return current
  }

  async #createFolder(name: string, parentId: string): Promise<string> {
    const response = await send(
      this.#t,
      `${this.#t.apiBase}/drive/v3/files`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
      },
      false,
    )
    ensureOk(response, name)
    const body = await readJson(response)
    const created = assertDriveId(isRecord(body) ? body.id : undefined, 'created folder')
    // Adopt the earliest folder of that name, never delete ours (single writer makes this rare).
    return (await this.#reader.findFolder(name, parentId)) ?? created
  }

  /**
   * Create `<ownId>` and `<ownId>/outbox` under an EXISTING `generations/g-<localGen>`.
   * Any missing shared ancestor (Memlore, .meta, keyring, devices, generations, g-N) throws
   * VaultNotReadyError before any create call. Idempotent.
   */
  async ensureFolder(): Promise<EnsureFolderResult> {
    this.#requireIdentity()
    return this.withLock(() => this.#ensureFolderUnlocked())
  }

  /** ensureFolder's body; the caller holds the writer lock. */
  async #ensureFolderUnlocked(): Promise<EnsureFolderResult> {
    const { ownId, localGen } = this.#requireIdentity()
    await this.#requireChain(DEVICE_SLOT_FOLDERS)
    const genRoot = await this.#requireChain([GENERATIONS_FOLDER, generationFolderName(localGen)])
    const deviceFolderId =
      (await this.#reader.findFolder(ownId, genRoot)) ?? (await this.#createFolder(ownId, genRoot))
    const outboxFolderId =
      (await this.#reader.findFolder(OUTBOX_FOLDER, deviceFolderId)) ??
      (await this.#createFolder(OUTBOX_FOLDER, deviceFolderId))
    return { deviceFolderId, outboxFolderId }
  }

  /**
   * Write `bytes` at an allowlisted path: update in place with If-Match when the file exists,
   * create it (multipart) only when none exists. The path is checked first, before any network
   * call. The identity is immutable once set (setIdentity refuses changes), so one check before
   * taking the lock suffices.
   */
  async put(path: string, bytes: Uint8Array): Promise<PutResult> {
    const target = this.#checkWritePath(path)
    return this.withLock(() => this.#writeChecked(target, bytes))
  }

  /** put's body; the caller holds the writer lock. Runs the same path checks first. */
  async #putUnlocked(path: string, bytes: Uint8Array): Promise<PutResult> {
    return this.#writeChecked(this.#checkWritePath(path), bytes)
  }

  /** Identity, allowlist and split checks, before any network call. */
  #checkWritePath(path: string): CheckedWritePath {
    const { ownId, localGen } = this.#requireIdentity()
    if (!isAllowedWritePath(path, ownId, localGen)) {
      throw new ForbiddenWriteError(`write not allowed: ${JSON.stringify(path)}`)
    }
    const split = splitPath(path)
    if (split === null) throw new ForbiddenWriteError(`write not allowed: ${JSON.stringify(path)}`)
    const contentType = path.endsWith('.json') ? 'application/json' : 'application/octet-stream'
    return { folders: split.folders, name: split.name, contentType }
  }

  async #writeChecked(target: CheckedWritePath, bytes: Uint8Array): Promise<PutResult> {
    // Parent folders must already exist: the slot's shared chain, or ensureFolder's outbox.
    const parentId = await this.#requireChain(target.folders)
    const existing = await this.#reader.findFile(target.name, parentId)
    if (existing !== null) {
      await this.#update(existing.id, bytes, target.contentType)
      return { fileId: existing.id, created: false, adoptedOther: false }
    }
    return this.#createAndAdopt(target.name, parentId, bytes, target.contentType)
  }

  async #update(fileId: string, bytes: Uint8Array, contentType: string): Promise<void> {
    const meta = await this.#reader.getMeta(fileId)
    if (meta.etag === null) throw new DriveProtocolError('no ETag for the file to update')
    const body = new Uint8Array(bytes)
    const response = await send(
      this.#t,
      `${this.#t.uploadBase}/drive/v3/files/${encodeURIComponent(fileId)}?uploadType=media`,
      { method: 'PATCH', headers: { 'Content-Type': contentType, 'If-Match': meta.etag }, body },
      false,
    )
    ensureOk(response, fileId)
  }

  async #createAndAdopt(
    name: string,
    parentId: string,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<PutResult> {
    const boundary = randomBoundary()
    const response = await send(
      this.#t,
      `${this.#t.uploadBase}/drive/v3/files?uploadType=multipart`,
      {
        method: 'POST',
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        body: multipartBody(boundary, { name, parents: [parentId] }, contentType, bytes),
      },
      false,
    )
    ensureOk(response, name)
    const body = await readJson(response)
    const createdId = assertDriveId(isRecord(body) ? body.id : undefined, 'created file')
    const candidates = await this.#reader.findFiles(name, parentId)
    // Eventual consistency: the re-list may not show our file yet. It exists, so report it as
    // created rather than failing (a retry would create a duplicate). Nothing is ever deleted.
    if (candidates.length === 0) {
      return { fileId: createdId, created: true, adoptedOther: false }
    }
    const canonical = candidates[0]
    return { fileId: canonical.id, created: true, adoptedOther: canonical.id !== createdId }
  }
}
