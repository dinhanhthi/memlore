/**
 * Web onboarding: join an existing desktop vault with the 24-word recovery phrase.
 *
 * SAFETY-CRITICAL. This mirrors `onboard_complete_inner` and `onboard_validate_passphrase_inner`
 * (`src-tauri/src/commands/crypto.rs:2389-2431`, `:2441-3075`) step by step, with ONE write: the
 * device slot `.meta/keyring/devices/<id>.json` (README safety contract 1). Desktop's best-effort
 * `_meta.json.updated_at` bump (`:3054-3064`) is deliberately SKIPPED, and no shared file or folder
 * is ever created or touched (`DriveWriter.put` refuses a missing `devices` folder before any write).
 *
 * Order (desktop line in brackets):
 *  1. `control.json`: parse, lease must be None            [:2456-2465]
 *  2. phrase syntax                                         [:2474-2477]
 *  3. `_recovery.json`, unwrap master with the phrase       [:2479-2497]
 *  4. `_meta.json`, `recovery_generation == control`        [:2499-2512]
 *  5. master fingerprint                                    [:2514-2521]
 *  6. `_content.json`: present -> every epoch unwrapped and fingerprint-checked; confirmed absent
 *     -> epoch 1 = master (pre-content-key vault); read error -> retry, never "absent"
 *     [:2564-2676]
 *  7. TOCTOU re-read of `meta` and `control`, abort if changed [:2926-2994]
 *  8. device id, slot write with `localGen = control.recovery_generation`
 *     (`configure_recovery_fence(control.recovery_generation)` at `:2466` and `:3037`) [:3039-3052]
 *  9. wrap the master under the local password (Argon2id FAST in WASM) and store it in IndexedDB
 * 10. `navigator.storage.persist()` (best effort), then the unlocked ring is installed.
 *
 * Deliberate differences from desktop (all fail closed):
 *  - The format guard (unknown `version` in control, `_meta`, `_recovery`, `_content`) fires at the
 *    FIRST read of each file, before any core parser runs, because the core validators would
 *    otherwise reject it with a generic error and mask the read-only-incompatible state. It is
 *    re-applied to the step-7 re-reads. The device slot version needs no guard here: the slot is
 *    built by the core with `KEYRING_V2_VERSION`, and no peer slot is read.
 *  - The phrase unwrap is probed before `_meta.json` is read (a throw-away fingerprint makes the
 *    core report "unwrapped, fingerprint differs" for the right phrase), so a wrong phrase is
 *    reported before a missing `_meta.json`, exactly as desktop. The real ring is built after the
 *    generation check, and a wrong fingerprint is `FingerprintMismatchError`.
 *  - A failed slot write ABORTS: desktop sets `keyring_dirty` and continues, but the web has no
 *    dirty-flag re-upload and never re-uploads a missing slot (README contract 9).
 *  - Desktop compares `master_fingerprint`, `epoch` and `content_epoch` of `_meta.json` on the
 *    re-read; the web also compares `recovery_generation`, and compares the whole canonical
 *    control file (desktop also compares the Drive revision, which the web does not have).
 *  - If the phrase is wrong AND the generation mismatches, the wrong phrase wins (as desktop).
 */

import { loadCore, type Core } from '../../core/core'
import {
  DriveHttpError,
  DriveNotFoundError,
  DriveProtocolError,
  VaultNotReadyError,
  type DriveReader,
  type DriveWriter,
} from '../drive/client'
import { deviceSlotPath, isValidGeneration, isValidOwnId } from '../drive/paths'
import { setKeyRing, type KeyRing } from '../keys'
import type { DeviceRecord, WebDb } from '../storage/idb'

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

/** A recovery lease is active on the cloud vault. UI: "recovery in progress, try later". */
export class RecoveryInProgressError extends Error {
  constructor() {
    super('An authoritative recovery is active on this cloud vault; retry after it finishes')
    this.name = 'RecoveryInProgressError'
  }
}

/** The phrase is not a valid 24-word BIP39 phrase. */
export class InvalidPhraseError extends Error {
  constructor() {
    super('The recovery phrase is not a valid 24-word phrase')
    this.name = 'InvalidPhraseError'
  }
}

/** The phrase is well formed but does not unlock this vault. */
export class WrongPhraseError extends Error {
  constructor() {
    super('Wrong recovery phrase. Check each word and try again.')
    this.name = 'WrongPhraseError'
  }
}

/** The unwrapped master does not match `_meta.json` (the phrase may belong to another vault). */
export class FingerprintMismatchError extends Error {
  constructor() {
    super('Could not verify the cloud vault: the recovery phrase may not match this vault')
    this.name = 'FingerprintMismatchError'
  }
}

/** `_meta.json.recovery_generation` differs from `control.json` (desktop "generation mismatch"). */
export class GenerationMismatchError extends Error {
  constructor(control: number, meta: number) {
    super(`Recovery generation mismatch: control=${control}, keyring_meta=${meta}`)
    this.name = 'GenerationMismatchError'
  }
}

/** A keyring or control file has a version this build does not know: the web stays read-only. */
export class FormatUnsupportedError extends Error {
  readonly path: string
  readonly version: number
  constructor(path: string, version: number) {
    super(`Unsupported format: ${path} has version ${version}; update the app`)
    this.name = 'FormatUnsupportedError'
    this.path = path
    this.version = version
  }
}

/** A shared vault file is missing, malformed or inconsistent (never a read error). */
export class VaultCorruptError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VaultCorruptError'
  }
}

/** `_content.json` could not be read after the bounded retries. Never treated as absent. */
export class TransientReadError extends Error {
  readonly path: string
  constructor(path: string, cause: unknown) {
    super(`Could not read ${path} from the cloud; please retry`, { cause })
    this.name = 'TransientReadError'
    this.path = path
  }
}

/** Control or keyring meta changed between the first read and the re-read (vault rotated). */
export class VaultChangedError extends Error {
  constructor(what: string) {
    super(`The cloud vault changed while onboarding (${what}); retry with the current phrase`)
    this.name = 'VaultChangedError'
  }
}

/**
 * This browser already holds a device record for a DIFFERENT vault and has unsent edits sealed
 * under that vault's master. Replacing the record would make them permanently undecryptable.
 */
export class DeviceRecordConflictError extends Error {
  constructor() {
    super('The device record belongs to a different vault and unsent drafts exist')
    this.name = 'DeviceRecordConflictError'
  }
}

/** The chosen device id is not acceptable to both desktop and the web Drive client. */
export class InvalidDeviceIdError extends Error {
  constructor() {
    super('Device id is not valid for the desktop keyring and the web client')
    this.name = 'InvalidDeviceIdError'
  }
}

// ---------------------------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------------------------

export interface OnboardDeps {
  /** Read-only Drive access (also the reader inside `writer`). */
  reader: DriveReader
  /** Used for exactly one `put`: the device slot. */
  writer: DriveWriter
  db: WebDb
  /** Defaults to `loadCore()`. */
  core?: Core
  /** Unix milliseconds. Default `Date.now`. */
  now?: () => number
  /** Default `crypto.randomUUID`. */
  randomUUID?: () => string
  /** Default `crypto.getRandomValues`. */
  randomBytes?: (length: number) => Uint8Array
  /** Default `navigator.userAgent`. */
  userAgent?: () => string
  /** Default `navigator.storage.persist`. A rejection or false is non-fatal. */
  persist?: () => Promise<boolean>
  /** Default `setTimeout`. */
  sleep?: (ms: number) => Promise<void>
}

export interface OnboardInput {
  /** The 24-word recovery phrase. Never stored. */
  phrase: string
  /** The new web password for this device. Never stored; only the Argon2id-wrapped master is. */
  password: string
}

export interface OnboardResult {
  deviceId: string
  deviceName: string
  /** True when the id of an existing IndexedDB device record was reused. */
  reusedDeviceId: boolean
  /** `control.recovery_generation`: the `g-<N>` generation the outbox will use. */
  recoveryGeneration: number
  masterFingerprint: string
  /** Whether `navigator.storage.persist()` was granted (false when refused or unavailable). */
  persisted: boolean
}

/** Bounded read attempts for `_content.json` (desktop propagates the first error; the web retries). */
export const CONTENT_READ_ATTEMPTS = 3
const CONTENT_RETRY_BASE_MS = 500
const KEK_SALT_BYTES = 16
const FINGERPRINT_MISMATCH = 'master key fingerprint mismatch'
const STORAGE_PROBE_KEY = 'onboard-probe'
const PROBE_FINGERPRINT = '0'.repeat(64)

const CONTROL_PATH = '.meta/control.json'
const META_PATH = '.meta/keyring/_meta.json'
const RECOVERY_PATH = '.meta/keyring/_recovery.json'
export const CONTENT_PATH = '.meta/keyring/_content.json'

/** Desktop `is_safe_device_id` (`sync/safety.rs:18-23`). */
const DESKTOP_SAFE_ID = /^[A-Za-z0-9_-]{4,64}$/

/** An id both desktop (`is_safe_device_id`) and the web Drive client (`isValidOwnId`) accept. */
export function isAcceptableDeviceId(value: unknown): value is string {
  return typeof value === 'string' && DESKTOP_SAFE_ID.test(value) && isValidOwnId(value)
}

// ---------------------------------------------------------------------------------------------
// Shared file reads (format guard first, then the core parser)
// ---------------------------------------------------------------------------------------------

export interface Versions {
  keyring: number
  control: number
  content: number
}

export function readVersions(core: Core): Versions {
  const v = JSON.parse(core.knownVersions()) as Record<string, unknown>
  const num = (key: string): number => {
    const value = v[key]
    if (typeof value !== 'number') throw new VaultCorruptError(`core did not report ${key}`)
    return value
  }
  return {
    keyring: num('keyring_version'),
    control: num('sync_control_version'),
    content: num('content_list_version'),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function decodeText(path: string, bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new VaultCorruptError(`${path} is not valid UTF-8`)
  }
}

/**
 * Format guard: the file's top-level `version` must equal `expected`. A missing or non-numeric
 * version is left to the core parser (a corrupt file, not a newer format).
 */
export function assertKnownVersion(path: string, text: string, expected: number): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new VaultCorruptError(`${path} is not valid JSON`)
  }
  if (isRecord(parsed) && typeof parsed.version === 'number' && parsed.version !== expected) {
    throw new FormatUnsupportedError(path, parsed.version)
  }
}

async function readText(reader: DriveReader, path: string): Promise<string> {
  return decodeText(path, await reader.readSharedFile(path))
}

/** Like `readText`, but a confirmed NotFound becomes `onMissing` (a typed error). */
async function readRequired(
  reader: DriveReader,
  path: string,
  onMissing: () => Error,
): Promise<string> {
  try {
    return await readText(reader, path)
  } catch (error) {
    if (error instanceof DriveNotFoundError) throw onMissing()
    throw error
  }
}

interface ControlState {
  recoveryGeneration: number
  leaseActive: boolean
  /** Canonical JSON from the core, for exact change detection. */
  canonical: string
}

async function readControl(reader: DriveReader, core: Core, v: Versions): Promise<ControlState> {
  const text = await readRequired(reader, CONTROL_PATH, () => new VaultNotReadyError(CONTROL_PATH))
  assertKnownVersion(CONTROL_PATH, text, v.control)
  let canonical: string
  try {
    canonical = core.parseSyncControl(text)
  } catch (error) {
    throw new VaultCorruptError(`${CONTROL_PATH}: ${errorMessage(error)}`)
  }
  const parsed = JSON.parse(canonical) as Record<string, unknown>
  const generation = parsed.recovery_generation
  if (typeof generation !== 'number' || !isValidGeneration(generation)) {
    throw new VaultCorruptError(`${CONTROL_PATH}: bad recovery_generation`)
  }
  return {
    recoveryGeneration: generation,
    leaseActive: parsed.recovery_lease !== null && parsed.recovery_lease !== undefined,
    canonical,
  }
}

export interface MetaState {
  masterFingerprint: string
  epoch: number
  contentEpoch: number
  recoveryGeneration: number
}

export async function readMeta(reader: DriveReader, core: Core, v: Versions): Promise<MetaState> {
  const text = await readRequired(
    reader,
    META_PATH,
    () => new VaultCorruptError('Cloud vault _meta.json is missing'),
  )
  assertKnownVersion(META_PATH, text, v.keyring)
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(core.parseKeyringMeta(text)) as Record<string, unknown>
  } catch (error) {
    throw new VaultCorruptError(`${META_PATH}: ${errorMessage(error)}`)
  }
  const { master_fingerprint: fp, epoch, content_epoch: contentEpoch } = parsed
  const generation = parsed.recovery_generation
  if (
    typeof fp !== 'string' ||
    typeof epoch !== 'number' ||
    typeof contentEpoch !== 'number' ||
    typeof generation !== 'number'
  ) {
    throw new VaultCorruptError(`${META_PATH}: unexpected shape`)
  }
  return { masterFingerprint: fp, epoch, contentEpoch, recoveryGeneration: generation }
}

async function readRecoveryWrapped(
  reader: DriveReader,
  v: Versions,
  missingMessage: string,
): Promise<string> {
  const text = await readRequired(
    reader,
    RECOVERY_PATH,
    () => new VaultCorruptError(missingMessage),
  )
  assertKnownVersion(RECOVERY_PATH, text, v.keyring)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new VaultCorruptError(`${RECOVERY_PATH} is not valid JSON`)
  }
  const wrapped = isRecord(parsed) ? parsed.wrapped_master : undefined
  if (typeof wrapped !== 'string' || !/^[0-9a-fA-F]{120}$/.test(wrapped)) {
    throw new VaultCorruptError(`${RECOVERY_PATH}: wrapped_master is malformed`)
  }
  return wrapped
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ---------------------------------------------------------------------------------------------
// Phrase -> master
// ---------------------------------------------------------------------------------------------

function assertPhraseSyntax(core: Core, phrase: string): void {
  if (!core.validateMnemonic(phrase)) throw new InvalidPhraseError()
}

/**
 * Desktop unwraps the master BEFORE reading `_meta.json`. The core fuses unwrap and fingerprint,
 * so probe with an impossible fingerprint: a right phrase fails with a fingerprint mismatch (the
 * unwrap succeeded; no ring is ever created), a wrong phrase fails differently.
 */
function probePhrase(core: Core, phrase: string, wrappedMasterHex: string): void {
  try {
    core.KeyRing.fromRecovery(phrase, wrappedMasterHex, PROBE_FINGERPRINT).lock()
  } catch (error) {
    if (errorMessage(error).includes(FINGERPRINT_MISMATCH)) return
    throw new WrongPhraseError()
  }
}

function openRing(
  core: Core,
  phrase: string,
  wrappedMasterHex: string,
  fingerprint: string,
): KeyRing {
  try {
    return core.KeyRing.fromRecovery(phrase, wrappedMasterHex, fingerprint)
  } catch (error) {
    if (errorMessage(error).includes(FINGERPRINT_MISMATCH)) throw new FingerprintMismatchError()
    throw new WrongPhraseError()
  }
}

/**
 * `onboard_validate_passphrase` (`commands/crypto.rs:2389-2431`): syntax, `_recovery.json`,
 * unwrap, `_meta.json`, fingerprint. Read-only: it does NOT read `control.json` or check the
 * generation (desktop does neither here), writes nothing and keeps no key.
 */
export async function validatePassphrase(
  reader: DriveReader,
  phrase: string,
  options: { core?: Core } = {},
): Promise<void> {
  const core = options.core ?? (await loadCore())
  const v = readVersions(core)
  assertPhraseSyntax(core, phrase)
  const wrapped = await readRecoveryWrapped(
    reader,
    v,
    'Cloud vault is missing the recovery slot; vault may be corrupted',
  )
  probePhrase(core, phrase, wrapped)
  const meta = await readMeta(reader, core, v)
  openRing(core, phrase, wrapped, meta.masterFingerprint).lock()
}

// ---------------------------------------------------------------------------------------------
// _content.json: three-way handling (desktop `commands/crypto.rs:2564-2676`)
// ---------------------------------------------------------------------------------------------

/**
 * The file text when present, `null` ONLY on a confirmed NotFound (a successful listing without
 * the file, or a GET 404). Transport and protocol errors are retried a bounded number of times and
 * then raised as `TransientReadError`: an error is NEVER "absent" (v1 = master on a vault with a
 * random content key would "succeed" with the wrong key). An auth error is not retried.
 */
export async function readContentFile(
  reader: DriveReader,
  sleep: (ms: number) => Promise<void>,
  options: { failFastOnTransport?: boolean } = {},
): Promise<string | null> {
  let last: unknown
  for (let attempt = 1; attempt <= CONTENT_READ_ATTEMPTS; attempt++) {
    try {
      return await readText(reader, CONTENT_PATH)
    } catch (error) {
      if (error instanceof DriveNotFoundError) return null
      if (!(error instanceof DriveHttpError || error instanceof DriveProtocolError)) throw error
      last = error
      // Unlock only: a transport failure (status 0, offline) answers from the cache at once.
      if (options.failFastOnTransport && error instanceof DriveHttpError && error.status === 0) {
        break
      }
      if (attempt < CONTENT_READ_ATTEMPTS) await sleep(CONTENT_RETRY_BASE_MS * attempt)
    }
  }
  throw new TransientReadError(CONTENT_PATH, last)
}

/**
 * Load the content keys from the file text (`null` = confirmed absent: master only). Shared with
 * unlock, which may read the same text from the IndexedDB cache.
 */
export function applyContentText(ring: KeyRing, text: string | null, v: Versions): void {
  if (text === null) {
    ring.loadMasterOnly()
    return
  }
  assertKnownVersion(CONTENT_PATH, text, v.content)
  try {
    ring.loadContentList(text)
  } catch (error) {
    throw new VaultCorruptError(`${CONTENT_PATH}: ${errorMessage(error)}`)
  }
}

/**
 * Cache the `_content.json` text (wrapped key material, safe ciphertext) in the `files` store under
 * its Drive path so a reload can unlock offline. Pinned: it must never be evicted as cache.
 */
export async function cacheContentText(db: WebDb, text: string, now: number): Promise<void> {
  await db.files.put({
    path: CONTENT_PATH,
    ciphertext: new TextEncoder().encode(text),
    etag: null,
    modifiedTime: null,
    lastAccess: now,
    pinned: true,
  })
}

async function loadContentKeys(
  ring: KeyRing,
  reader: DriveReader,
  v: Versions,
  sleep: (ms: number) => Promise<void>,
): Promise<string | null> {
  const text = await readContentFile(reader, sleep)
  applyContentText(ring, text, v)
  return text
}

// ---------------------------------------------------------------------------------------------
// Device identity
// ---------------------------------------------------------------------------------------------

/** "Chrome", "Edge", ... from a user agent. Short ASCII only; "Browser" when unknown. */
export function browserName(userAgent: string): string {
  const ua = userAgent.slice(0, 512)
  if (/\bEdg(?:e|A|iOS)?\//.test(ua)) return 'Edge'
  if (/\bOPR\//.test(ua) || /\bOpera\b/.test(ua)) return 'Opera'
  if (/\b(?:Firefox|FxiOS)\//.test(ua)) return 'Firefox'
  if (/\b(?:Chrome|CriOS|Chromium)\//.test(ua)) return 'Chrome'
  if (/\bVersion\/[\d.]+.*\bSafari\//.test(ua)) return 'Safari'
  return 'Browser'
}

async function pickDeviceId(
  db: WebDb,
  masterFingerprint: string,
  generate: () => string,
): Promise<{ deviceId: string; reused: boolean }> {
  const existing = await db.device.get()
  if (
    existing !== undefined &&
    existing.masterFingerprint === masterFingerprint &&
    isAcceptableDeviceId(existing.deviceId)
  ) {
    return { deviceId: existing.deviceId, reused: true }
  }
  const fresh = generate()
  if (!isAcceptableDeviceId(fresh)) throw new InvalidDeviceIdError()
  return { deviceId: fresh, reused: false }
}

function defaultRandomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length)
  globalThis.crypto.getRandomValues(out)
  return out
}

async function defaultPersist(): Promise<boolean> {
  const storage = (globalThis.navigator as { storage?: { persist?: () => Promise<boolean> } })
    ?.storage
  return storage?.persist ? storage.persist() : false
}

// ---------------------------------------------------------------------------------------------
// onboard_complete
// ---------------------------------------------------------------------------------------------

/**
 * Join the vault. Resolves with the key LEFT LOADED in `keys.ts` (desktop `onboard_complete`
 * leaves the app unlocked). On any failure the ring is zeroized and nothing is installed; the
 * only possible cloud write is the single device slot, and it happens after every vault check.
 */
export async function onboardComplete(
  deps: OnboardDeps,
  input: OnboardInput,
): Promise<OnboardResult> {
  const core = deps.core ?? (await loadCore())
  const { reader, writer, db } = deps
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const v = readVersions(core)
  if (typeof input.password !== 'string' || input.password === '') {
    throw new RangeError('a non-empty web password is required')
  }

  // 1. control: lease must be None.
  const control = await readControl(reader, core, v)
  if (control.leaseActive) throw new RecoveryInProgressError()

  // 2-3. phrase syntax, recovery slot, unwrap.
  assertPhraseSyntax(core, input.phrase)
  const wrapped = await readRecoveryWrapped(reader, v, 'Cloud vault is missing the recovery slot')
  probePhrase(core, input.phrase, wrapped)

  // 4. meta + generation.
  const meta = await readMeta(reader, core, v)
  if (meta.recoveryGeneration !== control.recoveryGeneration) {
    throw new GenerationMismatchError(control.recoveryGeneration, meta.recoveryGeneration)
  }

  // 5. master fingerprint (ring creation).
  const ring = openRing(core, input.phrase, wrapped, meta.masterFingerprint)
  try {
    // 6. content keys (+ format guard on each file as it is read).
    const contentText = await loadContentKeys(ring, reader, v, sleep)

    // 7. TOCTOU re-read.
    const control2 = await readControl(reader, core, v)
    if (control2.leaseActive) throw new RecoveryInProgressError()
    if (control2.canonical !== control.canonical) throw new VaultChangedError('control')
    const meta2 = await readMeta(reader, core, v)
    if (
      meta2.masterFingerprint !== meta.masterFingerprint ||
      meta2.epoch !== meta.epoch ||
      meta2.contentEpoch !== meta.contentEpoch ||
      meta2.recoveryGeneration !== meta.recoveryGeneration
    ) {
      throw new VaultChangedError('keyring meta')
    }

    // 8a. Local KEK wrap (before any cloud write, as desktop wraps before the slot).
    const salt = (deps.randomBytes ?? defaultRandomBytes)(KEK_SALT_BYTES)
    if (salt.length !== KEK_SALT_BYTES) throw new RangeError('KEK salt must be 16 bytes')
    const wrappedMasterHex = ring.wrapLocal(input.password, salt)

    // 8b. Existing device record: a different vault's record may only be replaced when no unsent
    // drafts (sealed under the old master) would be orphaned. Checked before ANY write.
    const existing = await db.device.get()
    const replacesOtherVault =
      existing !== undefined && existing.masterFingerprint !== meta.masterFingerprint
    if (replacesOtherVault && (await db.drafts.list()).length > 0) {
      throw new DeviceRecordConflictError()
    }
    // IndexedDB must accept writes BEFORE the cloud slot is written, or a storage failure would
    // leave an orphan slot (the retry generates a new id).
    await db.meta.put({ key: STORAGE_PROBE_KEY, value: true })
    await db.meta.delete(STORAGE_PROBE_KEY)
    // The old vault's cached ciphertext must never mix with the new vault.
    if (replacesOtherVault) await db.clearAll()

    // Device id, then the ONE cloud write: the device slot.
    const { deviceId, reused } = await pickDeviceId(
      db,
      meta.masterFingerprint,
      deps.randomUUID ?? (() => globalThis.crypto.randomUUID()),
    )
    const deviceName = `Memlore Web (${browserName(
      deps.userAgent?.() ??
        (globalThis.navigator as { userAgent?: string } | undefined)?.userAgent ??
        '',
    )})`
    const nowSeconds = Math.floor((deps.now ?? Date.now)() / 1000)
    const slot = core.buildDeviceSlot(deviceId, deviceName, nowSeconds, nowSeconds)
    writer.setIdentity({ ownId: deviceId, localGen: control.recoveryGeneration })
    await writer.put(deviceSlotPath(deviceId), new TextEncoder().encode(slot))

    // 9. Persist the wrapped master (never a raw key, never the phrase).
    const record: DeviceRecord = {
      deviceId,
      wrappedMasterHex,
      kekSaltHex: Array.from(salt, (b) => b.toString(16).padStart(2, '0')).join(''),
      recoveryGeneration: control.recoveryGeneration,
      masterFingerprint: meta.masterFingerprint,
      name: deviceName,
    }
    await db.device.put(record)
    // Best effort: a full or blocked store must not fail an otherwise complete onboarding, but a
    // stale cached copy from an older state must not survive either (absence was verified above).
    const dropCache = () => db.files.delete(CONTENT_PATH).catch(() => undefined)
    if (contentText !== null) {
      await cacheContentText(db, contentText, (deps.now ?? Date.now)()).catch(dropCache)
    } else {
      await dropCache()
    }

    // 10. Ask for durable storage; a failure is not fatal.
    let persisted = false
    try {
      persisted = (await (deps.persist ?? defaultPersist)()) === true
    } catch {
      persisted = false
    }

    setKeyRing(ring)
    return {
      deviceId,
      deviceName,
      reusedDeviceId: reused,
      recoveryGeneration: control.recoveryGeneration,
      masterFingerprint: meta.masterFingerprint,
      persisted,
    }
  } catch (error) {
    ring.lock()
    throw error
  }
}
