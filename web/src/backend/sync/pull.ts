/**
 * Lazy READ-ONLY pull (Phase 10.1). Uses `DriveReader` only: it never writes to Drive and never
 * re-uploads the device slot (README contract 9).
 *
 * `refresh()`:
 *  1. Always re-reads `control.json`, `_meta.json` and the own device slot FIRST. Every read of
 *     these three completes before any decision, so a transient error can never half-apply.
 *     - recovery generation or master fingerprint differs from the device record, or the slot
 *       listing SUCCEEDED and lacks `<ownId>.json` (removed on desktop): drop cached ciphertext
 *       (`clearCache`: files + blobs + meta; drafts and the device record are KEPT), lock with
 *       reason "revoked", raise the re-onboard flag and throw `ReonboardRequiredError`.
 *     - a network, 5xx or 401 error is NEVER "missing": `PullTransientError`, nothing dropped.
 *     - an unknown control/keyring `version` is `FormatUnsupportedError`, nothing dropped.
 *     - an unknown field or version in the own slot LATCHES the format guard (writes refused for
 *       the session, `formatGuard.ts`); the read goes on.
 *  2. Lists devices and reads each from the generation folder and the legacy flat folder with the
 *     reader's desktop precedence. A device without `metadata.json` (the web's own outbox folder, a
 *     half-created peer) is skipped. Manifest failures other than NotFound abort the whole pull
 *     (a partial manifest set would make the LWW winners wrong). A manifest with an unknown field,
 *     row shape or `schema_version` latches the format guard and keeps the previously cached
 *     manifest for that device (degraded `manifest-format`); the pull still serves. Per-device
 *     reads run concurrently through the shared limiter; results are folded in device-list order.
 *  3. Per desktop: caches `outbox-acks.bin` (Phase 16), `journals/*.bin`, `tags.bin`,
 *     `templates.bin` and `streak.bin` ciphertext (also concurrent per-device reads through the
 *     shared limiter, folded in device-list order). `settings.bin` is skipped (nothing in Phase 10
 *     needs it); `chats.bin` and `memory.bin` are never pulled here, only on demand
 *     (`readDeviceBin`, used by `commands/deviceBins.ts`).
 *  4. `computeDiff` (WASM) against the previously cached manifest gives the stale set; cached entry
 *     ciphertext of stale ids is dropped so a changed entry is never served from the cache, and an
 *     in-flight download of a stale path is detached: it never caches, and later callers start a
 *     fresh download instead of joining it.
 *  5. Builds the global entry index (LWW, see entryIndex.ts).
 *  6. Other web devices (Phase 16.2): a listed device with a slot and NO manifest (never this
 *     browser's own folder, which is not listed) is another browser of the vault. Its
 *     `outbox/<entryId>.bin` intents are downloaded (limiter, default size cap) and cached as
 *     ciphertext under `<device>/outbox/<entryId>.bin`; cached intents that left the cloud are
 *     dropped. Its media is not fetched here. `foreignIntents` exposes the cached set: the read
 *     session opens and validates them for the read-only overlay. Like the other small files they
 *     are re-downloaded on every pull (the listing carries no change marker).
 *  7. A cached `metadata.json` of a device that is no longer listed is pruned: a ghost device's
 *     stale rows must not survive into `primeFromCache`.
 *  8. Desktop capabilities (Phase 15.1), from the optional manifest flags: `v2Desktops` lists the
 *     desktops that still hold a device slot and import outbox v2 intents (`outbox_versions`
 *     contains 2); `indexSource` is the slotted desktop with `index_present` whose manifest was
 *     read FRESH this pull (a keep-previous copy cannot vouch that the index is still current)
 *     with the newest `generated_at` (tie: greater device id).
 *
 * `primeFromCache()` rebuilds the index straight from the cached manifests — IndexedDB only, no
 * Drive reads — so a reload can paint the list while `refresh()` revalidates in the background
 * (stale-while-revalidate). It is deliberately narrower: no slot data, no foreign intents, no
 * degraded flags.
 *
 * `fetchEntries` / `warmStart` download entry ciphertext on demand (deduplicated, concurrency 4).
 * An entry payload with an unknown envelope version latches the format guard and is still returned.
 * Cached ciphertext lives in the `files` store under its logical path `<device>/<...>`.
 */

import { loadCore, type Core } from '../../core/core'
import {
  DriveAuthError,
  DriveHttpError,
  DriveNotFoundError,
  DriveProtocolError,
  DriveTooLargeError,
  VaultNotReadyError,
  type DriveReader,
} from '../drive/client'
import type { RetentionDesktops } from './retention'
import { DEVICE_SLOT_FOLDERS, deviceSlotPath, isSafeComponent } from '../drive/paths'
import { ERROR_NAMES } from '../errorNames'
import { VaultLockedError, isUnlocked, lock, type LockReason } from '../keys'
import { notifyCacheWrite } from '../storage/evictor'
import type { WebDb } from '../storage/idb'
import { buildEntryIndex, newestLive, type IndexEntry, type ManifestEntryRow } from './entryIndex'
import {
  checkDeviceManifest,
  checkDeviceSlot,
  checkEnvelopeBytes,
  passesFormatGuard,
} from './formatGuard'
import { VaultCorruptError, readControl, readMeta, readVersions, type Versions } from './onboard'

/** Entries fetched by `warmStart` (user requirement: the 5 most recently updated). */
export const WARM_START_ENTRIES = 5
/** Maximum concurrent entry downloads. */
export const FETCH_CONCURRENCY = 4

// ---------------------------------------------------------------------------------------------
// Errors and the re-onboard flag
// ---------------------------------------------------------------------------------------------

export type ReonboardReason =
  | 'generation-changed'
  | 'fingerprint-changed'
  | 'slot-missing'
  | 'not-enrolled'

/** The vault no longer matches this browser's enrolment. UI (Phase 12): route to onboarding. */
export class ReonboardRequiredError extends Error {
  readonly reason: ReonboardReason
  constructor(reason: ReonboardReason, cause?: unknown) {
    super(
      `This browser must be re-enrolled (${reason}). Your unsent drafts are kept; enter the recovery phrase again.`,
      { cause },
    )
    this.name = ERROR_NAMES.reonboardRequired
    this.reason = reason
  }
}

/** A network, 5xx, 401 or other transient failure. Nothing was dropped; retry later. */
export class PullTransientError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause })
    this.name = ERROR_NAMES.pullTransient
  }
}

let reonboardReason: ReonboardReason | null = null

/** State flag for the router and commands: why the web must go back to onboarding, or null. */
export const getReonboardReason = (): ReonboardReason | null => reonboardReason

/** Cleared by the onboarding flow (Phase 12) once the browser is enrolled again. */
export function clearReonboardReason(): void {
  reonboardReason = null
}

function asTransient(error: unknown, what: string): unknown {
  if (
    error instanceof DriveHttpError ||
    error instanceof DriveAuthError ||
    error instanceof DriveProtocolError ||
    error instanceof VaultNotReadyError
  ) {
    return new PullTransientError(`Could not read ${what} from the cloud; retry later`, error)
  }
  return error
}

async function guarded<T>(what: string, task: () => Promise<T>): Promise<T> {
  try {
    return await task()
  } catch (error) {
    throw asTransient(error, what)
  }
}

// ---------------------------------------------------------------------------------------------
// Concurrency limiter
// ---------------------------------------------------------------------------------------------

export type Limiter = <T>(task: () => Promise<T>) => Promise<T>

/** At most `max` tasks run at once; the rest wait in FIFO order. */
export function createLimiter(max: number): Limiter {
  if (!Number.isInteger(max) || max < 1) throw new RangeError('limiter max must be an integer >= 1')
  let active = 0
  const waiting: Array<() => void> = []
  const release = (): void => {
    active -= 1
    waiting.shift()?.()
  }
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve))
    active += 1
    try {
      return await task()
    } finally {
      release()
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Pull
// ---------------------------------------------------------------------------------------------

export interface PullDeps {
  /** Read-only Drive access. */
  reader: DriveReader
  db: WebDb
  /** Defaults to `loadCore()`. */
  core?: Core
  /** Defaults to the key holder's `lock`. */
  lockKeys?: (reason: LockReason) => void
  /** Unix milliseconds for `lastAccess`. Default `Date.now`. */
  now?: () => number
  /** Entry download limiter. Default `createLimiter(FETCH_CONCURRENCY)`. */
  limit?: Limiter
  /** Defaults to the key holder's `isUnlocked`: a locked session stops using the network. */
  isUnlocked?: () => boolean
  /** Called after an entry payload was cached (the evictor's debounced check). Default `notifyCacheWrite`. */
  onCacheWrite?: () => void
}

/** Why a device's manifest could not be read fresh in the last pull. */
export type DegradedReason =
  | 'manifest-oversize'
  | 'manifest-unreadable'
  | 'manifest-missing'
  | 'manifest-format'

export interface DegradedDevice {
  device: string
  reason: DegradedReason
}

export interface PullResult {
  generation: number
  /** Devices that have a manifest (desktops), sorted. */
  devices: string[]
  /** Entry ids whose manifest row changed since the previous pull (`computeDiff`). */
  stale: string[]
  /** Non-fatal per-device warnings (unreadable manifest JSON). */
  warnings: string[]
}

interface Manifest {
  /** Normalized manifest JSON from the core (what is cached for the next `computeDiff`). */
  text: string
  entries: ManifestEntryRow[]
  /** `outbox_versions` (desktop v0.3.0+); empty when absent or malformed. */
  outboxVersions: readonly number[]
  /** `index_present` is exactly `true`. */
  indexPresent: boolean
  /** `generated_at`, or 0 when it is not a number. */
  generatedAt: number
}

/** One device's manifest-read result, folded into the pull in `devices` order. */
interface DeviceManifestRead {
  device: string
  manifest: Manifest | null
  warnings: string[]
  degraded: DegradedDevice | undefined
  webPeer: boolean
}

const ACKS_FILE = 'outbox-acks.bin'
/** A cached intent of another web device: `<device>/outbox/<entryId>.bin`. */
const FOREIGN_INTENT = /^([^/]+)\/outbox\/([^/]+)\.bin$/
/** A v2 intent file stem (`[jtpd]-<id>`): another browser's journal / tag / template / trash. */
const V2_INTENT_STEM = /^[jtpd]-/
/** A cached manifest: `<device>/metadata.json` (capture 1 is the device id). */
const CACHED_MANIFEST = /^([^/]+)\/metadata\.json$/

/** One intent file of another web device, as ciphertext (opened by the read session). */
export interface ForeignIntentFile {
  device: string
  entryId: string
  bytes: Uint8Array
}
const ENTRY_PAYLOAD = /^[^/]+\/entries\/[^/]+\.bin$/
const encoder = new TextEncoder()
const decoder = new TextDecoder()

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Year 2100 in Unix seconds: a manifest timestamp beyond it is garbage, not a clock skew. */
const MAX_UPDATED_AT = 4_102_444_800

/**
 * `metadata.json` is plaintext and unauthenticated, so a row id is untrusted free text: it ends up
 * in a Drive path. Only safe path components qualify (desktop ids are UUIDs); a leading dot and
 * `__proto__` are refused too.
 */
function isSafeEntryId(id: string): boolean {
  return isSafeComponent(id) && !id.startsWith('.') && id !== '__proto__'
}

const isSaneTimestamp = (n: number): boolean => Number.isFinite(n) && n >= 0 && n <= MAX_UPDATED_AT

/**
 * Typed rows of a manifest. A structurally wrong row is corruption (throws); a well-typed row with
 * an unsafe id or an absurd timestamp is dropped and only COUNTED (`dropped`), so one poisoned row
 * cannot take the whole read path down. Ids are never logged.
 */
function entryRows(manifest: unknown): { rows: ManifestEntryRow[]; dropped: number } {
  const entries = isRecord(manifest) ? manifest.entries : undefined
  if (!Array.isArray(entries)) throw new VaultCorruptError('manifest has no entries array')
  const rows: ManifestEntryRow[] = []
  let dropped = 0
  for (const row of entries as unknown[]) {
    if (
      !isRecord(row) ||
      typeof row.entry_id !== 'string' ||
      typeof row.updated_at !== 'number' ||
      typeof row.is_deleted !== 'boolean'
    ) {
      throw new VaultCorruptError('manifest entry row is malformed')
    }
    if (!isSafeEntryId(row.entry_id) || !isSaneTimestamp(row.updated_at)) {
      dropped += 1
      continue
    }
    // `trashed_at` is optional (desktop v0.3.0+): a garbage value drops the field, not the row.
    const trashedAt =
      typeof row.trashed_at === 'number' && Number.isFinite(row.trashed_at)
        ? { trashed_at: row.trashed_at }
        : {}
    rows.push({
      entry_id: row.entry_id,
      updated_at: row.updated_at,
      is_deleted: row.is_deleted,
      ...trashedAt,
    })
  }
  return { rows, dropped }
}

/**
 * Every entry id with a tombstone row in ANY manifest, plus every entry whose LWW WINNER is in the
 * desktop Trash. The asymmetry is deliberate: a trashed row that lost to a newer live row (a
 * restore or an edit elsewhere) does not count.
 */
function tombstonesOf(
  manifests: ReadonlyMap<string, Manifest>,
  index: ReadonlyMap<string, IndexEntry>,
): Set<string> {
  const tombstones = new Set<string>()
  for (const manifest of manifests.values()) {
    for (const row of manifest.entries) if (row.is_deleted) tombstones.add(row.entry_id)
  }
  for (const winner of index.values()) {
    if (winner.trashedAt !== undefined) tombstones.add(winner.entryId)
  }
  return tombstones
}

const entryPath = (winner: IndexEntry): string =>
  `${winner.authorDevice}/entries/${winner.entryId}.bin`

export class Puller {
  readonly #reader: DriveReader
  readonly #db: WebDb
  readonly #core: Core | undefined
  readonly #lockKeys: (reason: LockReason) => void
  readonly #now: () => number
  readonly #limit: Limiter
  readonly #isUnlocked: () => boolean
  readonly #onCacheWrite: () => void
  #loadedCore: Core | null = null
  #ownId: string | null = null
  #generation: number | null = null
  #index: Map<string, IndexEntry> | null = null
  #refreshing: Promise<PullResult> | null = null
  #oversizeSkipped = 0
  #pulls = 0
  #degraded: DegradedDevice[] = []
  /** Retention view of the last refresh: manifest devices, slot ids, tombstoned entry ids. */
  #desktops: RetentionDesktops = { manifests: [], slots: null, tombstones: new Set() }
  /** Other web devices' intent ciphertext from the last refresh. */
  #foreignIntents: ForeignIntentFile[] = []
  /** Slot ids listed by the authority check of the refresh in progress. */
  #listedSlots: Set<string> | null = null
  /** Slotted desktops whose manifest advertises outbox v2 import, from the last refresh. */
  #v2Desktops: ReadonlySet<string> = new Set()
  /** The desktop whose month index the web reads, from the last refresh (null: none). */
  #indexSource: string | null = null
  /**
   * Entry downloads in progress by path. Only the registered task may cache its bytes: `#revoke`
   * and a refresh that marks a path stale remove the entry, detaching the old download.
   */
  readonly #inflight = new Map<string, Promise<Uint8Array | null>>()

  constructor(deps: PullDeps) {
    this.#reader = deps.reader
    this.#db = deps.db
    this.#core = deps.core
    this.#lockKeys = deps.lockKeys ?? lock
    this.#now = deps.now ?? Date.now
    this.#limit = deps.limit ?? createLimiter(FETCH_CONCURRENCY)
    this.#isUnlocked = deps.isUnlocked ?? isUnlocked
    this.#onCacheWrite = deps.onCacheWrite ?? notifyCacheWrite
  }

  /** A locked session must not keep using the OAuth token or the network. */
  #assertUnlocked(): void {
    if (!this.#isUnlocked()) throw new VaultLockedError()
  }

  /**
   * What intent retention needs from the last refresh: the devices with a manifest, the listed
   * device slot ids (null before a refresh) and every entry id with a tombstone row in ANY
   * manifest (not only LWW winners), plus every entry whose LWW winner is trashed.
   */
  get desktops(): RetentionDesktops {
    return this.#desktops
  }

  /**
   * Intent ciphertext of every OTHER web device of the vault (a device with a slot and no
   * manifest), from the last refresh. Never this browser's own outbox.
   */
  get foreignIntents(): readonly ForeignIntentFile[] {
    return this.#foreignIntents
  }

  /**
   * Desktops that still hold a device slot and whose manifest `outbox_versions` contains 2, from
   * the last refresh (empty before one and after `primeFromCache`).
   */
  get v2Desktops(): ReadonlySet<string> {
    return this.#v2Desktops
  }

  /**
   * The slotted desktop with `index_present` and the newest manifest `generated_at` (read fresh
   * by the last refresh), or null.
   */
  get indexSource(): string | null {
    return this.#indexSource
  }

  /** Completed `refresh()` runs: a new value means device files may have changed on Drive. */
  get pulls(): number {
    return this.#pulls
  }

  /** The download limiter (concurrency 4), shared with the media reads of Phase 11.1. */
  get limit(): Limiter {
    return this.#limit
  }

  /** The current global index (entry id to LWW winner), or null before the first `refresh`. */
  get index(): ReadonlyMap<string, IndexEntry> | null {
    return this.#index
  }

  async #getCore(): Promise<Core> {
    this.#loadedCore ??= this.#core ?? (await loadCore())
    return this.#loadedCore
  }

  /** Concurrent callers share one run. */
  refresh(): Promise<PullResult> {
    this.#refreshing ??= this.#refresh().finally(() => {
      this.#refreshing = null
    })
    return this.#refreshing
  }

  /**
   * Rebuilds the index from the manifests cached by the last pull — IndexedDB only, no Drive
   * reads — so a reload can show the list while `refresh()` revalidates in the background.
   * False when there is nothing usable to prime from (the caller then falls back to
   * `refresh()`); a cache read error means the same. A `VaultLockedError` (a lock between the
   * reads and the assignment) propagates. `desktops.slots` stays null, `foreignIntents` and
   * the degraded list stay empty: priming is deliberately narrower than a refresh.
   */
  async primeFromCache(): Promise<boolean> {
    if (this.#index !== null) return true
    try {
      const record = await this.#db.device.get()
      if (record === undefined) return false
      const devices = (await this.#db.files.paths())
        .map((path) => CACHED_MANIFEST.exec(path)?.[1])
        .filter((device): device is string => device !== undefined && device !== record.deviceId)
        .sort()
      const manifests = new Map<string, Manifest>()
      for (const device of devices) {
        // The keep-previous reader: the cached text is the core-normalized manifest and one
        // that no longer parses is skipped — the next refresh re-reads the device.
        const manifest = await this.#cachedManifest(device, [])
        if (manifest !== null) manifests.set(device, manifest)
      }
      if (manifests.size === 0) return false
      this.#assertUnlocked()
      // A refresh that completed meanwhile owns the fresher index: keep it.
      if (this.#index !== null) return true
      this.#ownId = record.deviceId
      this.#generation = record.recoveryGeneration
      this.#index = buildEntryIndex(
        [...manifests].map(([device, manifest]) => ({ device, entries: manifest.entries })),
      )
      const tombstones = tombstonesOf(manifests, this.#index)
      this.#desktops = { manifests: [...manifests.keys()], slots: null, tombstones }
      return true
    } catch (error) {
      if (error instanceof VaultLockedError) throw error
      return false
    }
  }

  async #refresh(): Promise<PullResult> {
    // Folder ids are reused between reads, never across refreshes: the authority check below
    // must see a deleted or recreated `devices` folder, not a cached id.
    this.#reader.clearFolderCache()
    const core = await this.#getCore()
    const versions = readVersions(core)
    this.#assertUnlocked()
    const generation = await this.#checkAuthority(core, versions)
    this.#assertUnlocked()
    this.#generation = generation

    const reader = this.#reader
    const devices = (await guarded('the device list', () => reader.listDevices(generation))).filter(
      (id) => id !== this.#ownId,
    )
    this.#assertUnlocked()
    // Per-device manifest reads run concurrently through the shared limiter; the results are
    // folded in `devices` order so warnings, degraded flags, manifest insertion order and the
    // web-peer list never depend on completion order.
    const results = await Promise.allSettled(
      devices.map((device) => this.#readDeviceManifest(core, generation, device)),
    )
    const manifests = new Map<string, Manifest>()
    const warnings: string[] = []
    const degraded: DegradedDevice[] = []
    const webPeers: string[] = []
    for (const result of results) {
      // The first rejection in `devices` order aborts the pull: a partial manifest set would
      // make the LWW winners wrong. allSettled waited for every read, so nothing keeps
      // writing after this throws.
      if (result.status === 'rejected') throw result.reason
      const read = result.value
      warnings.push(...read.warnings)
      if (read.degraded !== undefined) degraded.push(read.degraded)
      if (read.webPeer) webPeers.push(read.device)
      if (read.manifest !== null) manifests.set(read.device, read.manifest)
    }

    this.#assertUnlocked()
    const stale = await this.#diffAndCacheManifests(core, manifests)
    await this.#pruneGhostManifests(devices)
    // Small files of every desktop run concurrently through the shared limiter; the first
    // rejection in device order aborts the pull and the warnings fold in device order.
    const smallFiles = await Promise.allSettled(
      [...manifests.keys()].map((device) => this.#cacheSmallFiles(generation, device)),
    )
    for (const result of smallFiles) {
      if (result.status === 'rejected') throw result.reason
      warnings.push(...result.value)
    }
    this.#assertUnlocked()
    const foreignIntents = await this.#cacheForeignIntents(generation, webPeers, warnings)
    this.#assertUnlocked()

    this.#index = buildEntryIndex(
      [...manifests].map(([device, manifest]) => ({ device, entries: manifest.entries })),
    )
    this.#degraded = degraded
    this.#foreignIntents = foreignIntents
    const tombstones = tombstonesOf(manifests, this.#index)
    this.#desktops = { manifests: [...manifests.keys()], slots: this.#listedSlots, tombstones }
    this.#setCapabilities(manifests, degraded)
    this.#pulls += 1
    return { generation, devices: [...manifests.keys()].sort(), stale, warnings }
  }

  /** `v2Desktops` and `indexSource` from this refresh's manifests (see step 8 above). */
  #setCapabilities(manifests: ReadonlyMap<string, Manifest>, degraded: DegradedDevice[]): void {
    const slots = this.#listedSlots
    const stale = new Set(degraded.map((d) => d.device))
    const v2 = new Set<string>()
    let source: { device: string; generatedAt: number } | null = null
    for (const [device, manifest] of manifests) {
      if (slots?.has(device) !== true) continue
      if (manifest.outboxVersions.includes(2)) v2.add(device)
      if (!manifest.indexPresent || stale.has(device)) continue
      if (
        source === null ||
        manifest.generatedAt > source.generatedAt ||
        (manifest.generatedAt === source.generatedAt && device > source.device)
      ) {
        source = { device, generatedAt: manifest.generatedAt }
      }
    }
    this.#v2Desktops = v2
    this.#indexSource = source?.device ?? null
  }

  /**
   * One device's `metadata.json` (concurrency-limited read), its keep-previous fallback and the
   * per-device warnings/degraded flag — returned whole so the caller folds in `devices` order.
   * A device with no manifest at all (the web's own outbox folder) is not degraded; it is a web
   * peer when its slot is listed.
   */
  async #readDeviceManifest(
    core: Core,
    generation: number,
    device: string,
  ): Promise<DeviceManifestRead> {
    const warnings: string[] = []
    const read = await this.#limit(() => {
      this.#assertUnlocked()
      return this.#readOptional(generation, `${device}/metadata.json`)
    })
    if (read === 'oversize') warnings.push(`${device}: manifest is too large and was ignored`)
    const text = read === 'oversize' ? null : read
    const parsed =
      text === null ? null : this.#parseManifest(core, device, decoder.decode(text), warnings)
    const normalized = parsed === 'unsupported' ? null : parsed
    let manifest: Manifest | null
    let degraded: DegradedDevice | undefined
    let webPeer = false
    if (normalized === null) {
      // Keep-previous: the cached copy is the newest manifest ever read successfully for this
      // device (a failed read never overwrites it), so a stale manifest cannot advance a winner.
      manifest = await this.#cachedManifest(device, warnings)
      const reason: DegradedReason =
        read === 'oversize'
          ? 'manifest-oversize'
          : text === null
            ? 'manifest-missing'
            : parsed === 'unsupported'
              ? 'manifest-format'
              : 'manifest-unreadable'
      if (manifest !== null || reason !== 'manifest-missing') degraded = { device, reason }
      else if (this.#listedSlots?.has(device) === true) webPeer = true
    } else {
      manifest = this.#toManifest(device, normalized, warnings)
    }
    return { device, manifest, warnings, degraded, webPeer }
  }

  #toManifest(device: string, normalized: string, warnings: string[]): Manifest {
    const parsed: unknown = JSON.parse(normalized)
    const { rows, dropped } = entryRows(parsed)
    if (dropped > 0)
      warnings.push(`${device}: ${dropped} manifest row(s) with an unsafe id or time ignored`)
    const fields = isRecord(parsed) ? parsed : {}
    const versions = fields.outbox_versions
    return {
      text: normalized,
      entries: rows,
      outboxVersions: Array.isArray(versions)
        ? versions.filter((v): v is number => typeof v === 'number')
        : [],
      indexPresent: fields.index_present === true,
      generatedAt: typeof fields.generated_at === 'number' ? fields.generated_at : 0,
    }
  }

  /**
   * A listed device whose manifest is now missing or unreadable keeps its previously cached
   * manifest for this pull (dropping it would change the LWW winners); a device never seen before
   * is skipped.
   */
  async #cachedManifest(device: string, warnings: string[]): Promise<Manifest | null> {
    const cached = await this.#db.files.get(`${device}/metadata.json`)
    if (cached === undefined) return null
    try {
      const manifest = this.#toManifest(device, decoder.decode(cached.ciphertext), warnings)
      warnings.push(`${device}: manifest unavailable, using the cached copy`)
      return manifest
    } catch {
      return null
    }
  }

  /**
   * control + `_meta.json` + own slot, all read before any decision. Returns the generation.
   * Drops, locks and throws `ReonboardRequiredError` on a generation or fingerprint change or a
   * confirmed-missing own slot.
   */
  async #checkAuthority(core: Core, versions: Versions): Promise<number> {
    const reader = this.#reader
    const record = await this.#db.device.get()
    if (record === undefined) {
      // Never enrolled in this browser: nothing cached to drop, nothing to lock.
      reonboardReason = 'not-enrolled'
      throw new ReonboardRequiredError('not-enrolled')
    }
    this.#ownId = record.deviceId

    const control = await guarded('control.json', () => readControl(reader, core, versions))
    const meta = await guarded('_meta.json', () => readMeta(reader, core, versions))
    const slotPresent = await guarded('the device slot', () => this.#ownSlotPresent(core))

    let reason: ReonboardReason | null = null
    if (control.recoveryGeneration !== record.recoveryGeneration) reason = 'generation-changed'
    else if (meta.masterFingerprint !== record.masterFingerprint) reason = 'fingerprint-changed'
    else if (!slotPresent) reason = 'slot-missing'
    if (reason !== null) await this.#revoke(reason)
    return control.recoveryGeneration
  }

  /**
   * True when the devices folder listing succeeded and contains `<ownId>.json` (and the slot
   * parses). False ONLY for a successful listing without it. Any request error propagates (and is
   * mapped to a transient error by the caller); a missing devices folder is not proof either.
   */
  async #ownSlotPresent(core: Core): Promise<boolean> {
    const folderId = await this.#reader.findFolderPath(DEVICE_SLOT_FOLDERS)
    if (folderId === null) throw new VaultNotReadyError(DEVICE_SLOT_FOLDERS.join('/'))
    const path = deviceSlotPath(this.#ownId ?? '')
    const listed = await this.#reader.listFolder(folderId, 'files')
    this.#listedSlots = new Set(
      listed.filter((f) => f.name.endsWith('.json')).map((f) => f.name.slice(0, -'.json'.length)),
    )
    if (!listed.some((file) => `.meta/keyring/devices/${file.name}` === path)) return false
    let bytes: Uint8Array
    try {
      bytes = await this.#reader.readSharedFile(path)
    } catch (error) {
      if (error instanceof DriveNotFoundError) return false
      throw error
    }
    try {
      const slot = decoder.decode(bytes)
      passesFormatGuard(() => checkDeviceSlot(core, path, slot)) // unknown: latched, read goes on
      core.parseDeviceSlot(slot)
    } catch (error) {
      throw new VaultCorruptError(`${path}: ${error instanceof Error ? error.message : error}`)
    }
    return true
  }

  async #revoke(reason: ReonboardReason): Promise<never> {
    this.#index = null
    this.#foreignIntents = []
    this.#desktops = { manifests: [], slots: null, tombstones: new Set() }
    this.#v2Desktops = new Set()
    this.#indexSource = null
    this.#inflight.clear() // a download that started earlier must not re-cache ciphertext
    this.#lockKeys('revoked')
    reonboardReason = reason
    let cause: unknown
    try {
      await this.#db.clearCache()
    } catch (error) {
      cause = error // the caller must still be routed to onboarding
    }
    throw new ReonboardRequiredError(reason, cause)
  }

  /**
   * Bytes of a logical device file, or null on a confirmed NotFound or a path the reader refuses
   * (`RangeError`: an unsafe name from untrusted Drive content is "missing", never a failed pull).
   * A `DriveTooLargeError` (a planted or corrupt file above `maxBytes`, default: the reader's cap)
   * yields `'oversize'`: it is neither missing nor transient, and retrying cannot help, so one
   * file never aborts the whole pull; callers skip it and keep whatever they had cached. Other
   * errors are transient.
   */
  async #readOptional(
    generation: number,
    path: string,
    maxBytes?: number,
  ): Promise<Uint8Array | null | 'oversize'> {
    try {
      return await this.#reader.readDeviceFile(generation, path, maxBytes)
    } catch (error) {
      if (error instanceof DriveNotFoundError || error instanceof RangeError) return null
      if (error instanceof DriveTooLargeError) {
        this.#oversizeSkipped += 1
        return 'oversize'
      }
      throw asTransient(error, path)
    }
  }

  /**
   * Normalized manifest JSON, null when the device's manifest is unusable (warning), or
   * `'unsupported'` when it has an unknown field, row shape or `schema_version` (the format guard
   * latched; the caller keeps the cached manifest).
   */
  #parseManifest(
    core: Core,
    device: string,
    raw: string,
    warnings: string[],
  ): string | null | 'unsupported' {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      warnings.push(`${device}: manifest is not valid JSON`)
      return null
    }
    const path = `${device}/metadata.json`
    if (isRecord(parsed) && !passesFormatGuard(() => checkDeviceManifest(core, path, parsed))) {
      warnings.push(`${device}: manifest uses a newer format; the cached copy is kept`)
      return 'unsupported'
    }
    try {
      return core.parseManifest(raw)
    } catch (error) {
      warnings.push(`${device}: ${error instanceof Error ? error.message : 'bad manifest'}`)
      return null
    }
  }

  /** Stale ids via `computeDiff(cached, new)` per device; stale cached entries are dropped. */
  async #diffAndCacheManifests(core: Core, manifests: Map<string, Manifest>): Promise<string[]> {
    const stale = new Set<string>()
    for (const [device, manifest] of manifests) {
      const path = `${device}/metadata.json`
      const cached = await this.#db.files.get(path)
      const local =
        cached === undefined
          ? JSON.stringify({
              device_id: device,
              recovery_generation: 0,
              entries: [],
              journals: [],
              generated_at: 0,
            })
          : decoder.decode(cached.ciphertext)
      const diff = JSON.parse(core.computeDiff(local, manifest.text)) as {
        to_pull: string[]
        to_delete_locally: Array<[string, number]>
      }
      for (const id of [...diff.to_pull, ...diff.to_delete_locally.map(([id]) => id)]) {
        stale.add(id)
        await this.#dropPayload(`${device}/entries/${id}.bin`)
      }
      await this.#putFile(path, encoder.encode(manifest.text), false)
    }
    return [...stale].sort()
  }

  /**
   * Drops the cached `metadata.json` of a device that is no longer listed (it left the vault):
   * the keep-previous fallback above protects only still-listed devices, and a ghost's stale
   * rows must not survive into the next `primeFromCache`. Cache-only — nothing is written to
   * Drive and the ghost's other cached files are untouched. Runs only on a refresh that got
   * past the device listing, so a failed listing prunes nothing.
   */
  async #pruneGhostManifests(devices: readonly string[]): Promise<void> {
    const listed = new Set(devices)
    for (const path of await this.#db.files.paths()) {
      const device = CACHED_MANIFEST.exec(path)?.[1]
      if (device !== undefined && device !== this.#ownId && !listed.has(device)) {
        await this.#db.files.delete(path)
      }
    }
  }

  /**
   * Drops the cached payload at `path` and detaches its in-flight download (if any): that download
   * may hold bytes read before the change, so it must not cache them, and a later caller must not
   * join it.
   */
  async #dropPayload(path: string): Promise<void> {
    this.#inflight.delete(path)
    await this.#db.files.delete(path)
  }

  /**
   * Drops the cached ciphertext of the current winner of each id (unknown ids are ignored), so the
   * next `fetchEntries` downloads it again. The vault uses it when a cached copy opens older than
   * its index winner.
   */
  async dropCached(ids: readonly string[]): Promise<void> {
    const index = this.#index
    if (index === null) return
    for (const id of new Set(ids)) {
      const winner = index.get(id)
      if (winner !== undefined) await this.#dropPayload(entryPath(winner))
    }
  }

  async #putFile(path: string, bytes: Uint8Array, pinned: boolean): Promise<void> {
    const record = {
      path,
      ciphertext: bytes,
      etag: null,
      modifiedTime: null,
      lastAccess: this.#now(),
      pinned,
    }
    // Re-caching a payload must not drop a pin set meanwhile (`warmStart` re-pins only its own set):
    // the read-preserve-write is one transaction, so a concurrent `setPinned(true)` is not lost.
    if (!pinned && ENTRY_PAYLOAD.test(path)) await this.#db.files.putPreservingPin(record)
    else await this.#db.files.put(record)
  }

  /**
   * `outbox-acks.bin`, `journals/*.bin`, `tags.bin`, `templates.bin`, `streak.bin` of one desktop. Every
   * individual network call is concurrency-limited (wrapping the whole task in `#limit` would
   * deadlock the queue); the returned warnings fold into the pull's warnings in device order.
   */
  async #cacheSmallFiles(generation: number, device: string): Promise<string[]> {
    const warnings: string[] = []
    const bytesOf = (path: string): Promise<Uint8Array | null | 'oversize'> =>
      this.#limit(() => {
        this.#assertUnlocked()
        return this.#readOptional(generation, path)
      })
    const cache = async (path: string, bytes: Uint8Array | null | 'oversize'): Promise<void> => {
      if (bytes === 'oversize') warnings.push(`${path}: file is too large and was ignored`)
      else if (bytes !== null) await this.#putFile(path, bytes, false)
    }
    const acks = `${device}/${ACKS_FILE}`
    const tags = `${device}/tags.bin`
    const templates = `${device}/templates.bin`
    const streak = `${device}/streak.bin`
    // Acks, tags, templates, streak and the journals listing all start at once; the listed
    // journal files are downloaded concurrently below.
    const [ackRead, tagRead, templateRead, streakRead, journalListing] = await Promise.allSettled([
      bytesOf(acks),
      bytesOf(tags),
      bytesOf(templates),
      bytesOf(streak),
      this.#limit(() => {
        this.#assertUnlocked()
        return guarded(`${device}/journals`, () =>
          this.#reader.listDeviceFiles(generation, device, 'journals'),
        )
      }),
    ])
    // The first rejection in this order aborts the device; allSettled already waited for every
    // read, so nothing keeps writing after this throws.
    if (ackRead.status === 'rejected') throw ackRead.reason
    if (tagRead.status === 'rejected') throw tagRead.reason
    if (templateRead.status === 'rejected') throw templateRead.reason
    if (streakRead.status === 'rejected') throw streakRead.reason
    if (journalListing.status === 'rejected') throw journalListing.reason
    const names = journalListing.value.filter((n) => n.endsWith('.bin'))
    const journalReads = Promise.allSettled(
      names.map((name) => bytesOf(`${device}/journals/${name}`)),
    )
    if (ackRead.value === null) await this.#db.files.delete(acks)
    else await cache(acks, ackRead.value)
    await cache(tags, tagRead.value)
    await cache(templates, templateRead.value)
    await cache(streak, streakRead.value)
    const journals = (await journalReads).map((result) => {
      if (result.status === 'rejected') throw result.reason
      return result.value
    })
    for (const [index, bytes] of journals.entries()) {
      await cache(`${device}/journals/${names[index]}`, bytes)
    }
    return warnings
  }

  /**
   * Downloads the `outbox/<entryId>.bin` intents of each other web device (concurrency-limited)
   * and caches them; an oversize one keeps its cached copy. Every cached intent of a device or an
   * entry that is no longer listed is dropped (so is any cached `[jtpd]-<id>.bin` v2 intent, which
   * is never downloaded). Read-only: nothing is written to Drive.
   */
  async #cacheForeignIntents(
    generation: number,
    peers: readonly string[],
    warnings: string[],
  ): Promise<ForeignIntentFile[]> {
    const listed: Array<{ device: string; entryId: string; path: string }> = []
    for (const device of peers) {
      this.#assertUnlocked()
      const names = await guarded(`${device}/outbox`, () =>
        this.#reader.listDeviceFiles(generation, device, 'outbox'),
      )
      for (const name of names) {
        const entryId = name.endsWith('.bin') ? name.slice(0, -'.bin'.length) : ''
        // Media and v2 intents are not entry intents: never downloaded (the web shows neither).
        if (entryId.startsWith('m-') || V2_INTENT_STEM.test(entryId)) continue
        if (!isSafeEntryId(entryId)) continue
        listed.push({ device, entryId, path: `${device}/outbox/${name}` })
      }
    }
    const found = await Promise.all(
      listed.map(async ({ device, entryId, path }): Promise<ForeignIntentFile | null> => {
        const read = await this.#limit(() => {
          this.#assertUnlocked()
          return this.#readOptional(generation, path)
        })
        if (read === null) return null
        if (read === 'oversize') {
          warnings.push(`${path}: file is too large and was ignored`)
          const cached = await this.#db.files.get(path)
          return cached === undefined ? null : { device, entryId, bytes: cached.ciphertext }
        }
        await this.#putFile(path, read, false)
        return { device, entryId, bytes: read }
      }),
    )
    const kept = found.filter((f): f is ForeignIntentFile => f !== null)
    const keep = new Set(kept.map((f) => `${f.device}/outbox/${f.entryId}.bin`))
    for (const path of await this.#db.files.paths()) {
      if (FOREIGN_INTENT.test(path) && !keep.has(path)) await this.#db.files.delete(path)
    }
    return kept
  }

  /**
   * On-demand download of one device file (`chats.bin`, `memory.bin`) through the shared limiter,
   * at most `maxBytes`: null when it is missing, `'oversize'` when it is larger. Nothing is cached:
   * the caller keeps the decoded result in RAM. Needs a prior `refresh()` or `primeFromCache()`.
   */
  async readDeviceBin(path: string, maxBytes: number): Promise<Uint8Array | null | 'oversize'> {
    const generation = this.#generation
    if (generation === null) throw new Error('readDeviceBin needs a prior refresh()')
    const bytes = await this.#limit(() => {
      this.#assertUnlocked()
      return this.#readOptional(generation, path, maxBytes)
    })
    this.#assertUnlocked()
    return bytes
  }

  /**
   * Ciphertext of the winning copy of each id (`<authorDevice>/entries/<id>.bin`), from the cache
   * when present, otherwise downloaded (concurrency-limited; one download per id in flight).
   * Unknown ids and files that are confirmed missing are omitted. Needs a prior `refresh()`.
   */
  async fetchEntries(ids: readonly string[]): Promise<Map<string, Uint8Array>> {
    const index = this.#index
    const generation = this.#generation
    if (index === null || generation === null)
      throw new Error('fetchEntries needs a prior refresh()')
    const core = await this.#getCore()
    const out = new Map<string, Uint8Array>()
    await Promise.all(
      [...new Set(ids)].map(async (id) => {
        const winner = index.get(id)
        if (winner === undefined) return
        let bytes: Uint8Array | null
        try {
          bytes = await this.#entryBytes(generation, winner)
        } catch (error) {
          if (error instanceof RangeError) return // an unusable id is missing, not a failed batch
          throw error
        }
        if (bytes === null) return
        // An unknown envelope latches the format guard; the bytes are still returned to be opened.
        passesFormatGuard(() => checkEnvelopeBytes(core, entryPath(winner), bytes))
        out.set(id, bytes)
      }),
    )
    return out
  }

  #entryBytes(generation: number, winner: IndexEntry): Promise<Uint8Array | null> {
    const path = entryPath(winner)
    const pending = this.#inflight.get(path)
    if (pending !== undefined) return pending
    // Still registered under `path` = still current: a revoke or a refresh that marked the path
    // stale removes it, and its (possibly old) bytes must then not be cached.
    const isCurrent = (): boolean => this.#inflight.get(path) === task
    const task: Promise<Uint8Array | null> = (async (): Promise<Uint8Array | null> => {
      const cached = await this.#db.files.get(path)
      if (cached !== undefined) {
        await this.#db.files.touch(path, this.#now())
        return cached.ciphertext
      }
      const bytes = await this.#limit(() => {
        this.#assertUnlocked()
        return this.#readOptional(generation, path)
      })
      if (bytes === 'oversize') return null // not retryable: the id is treated as missing
      if (bytes !== null && isCurrent()) {
        // Best effort: a full store must not fail the read.
        await this.#putFile(path, bytes, false).then(this.#onCacheWrite, () => undefined)
      }
      return bytes
    })().finally(() => {
      if (isCurrent()) this.#inflight.delete(path)
    })
    this.#inflight.set(path, task)
    return task
  }

  /**
   * Devices whose manifest the LAST successful pull could not read fresh (its cached copy, the
   * newest one ever read, was used, or the device is unreadable). Cleared per device by a later
   * pull that reads its manifest.
   */
  getDegradedDevices(): DegradedDevice[] {
    return this.#degraded.map((d) => ({ ...d }))
  }

  /**
   * Files skipped because they exceeded the default download cap (not retryable). */
  get oversizeSkipped(): number {
    return this.#oversizeSkipped
  }

  /** Fetches the 5 newest non-deleted entries and nothing else. Returns their ids, newest first. */
  async warmStart(): Promise<string[]> {
    if (this.#index === null) await this.refresh()
    const ids = newestLive(this.#index ?? new Map(), WARM_START_ENTRIES).map((e) => e.entryId)
    await this.fetchEntries(ids)
    await this.#pinWarmSet(ids).catch(() => undefined) // best effort: pinning never fails a read
    return ids
  }

  /** The cache evictor keeps exactly the newest warm-start payloads: pin them, unpin older ones. */
  async #pinWarmSet(ids: readonly string[]): Promise<void> {
    const index = this.#index
    const keep = new Set<string>()
    for (const id of ids) {
      const winner = index?.get(id)
      if (winner !== undefined) keep.add(entryPath(winner))
    }
    for (const meta of await this.#db.files.sizes()) {
      if (meta.pinned && ENTRY_PAYLOAD.test(meta.path) && !keep.has(meta.path)) {
        await this.#db.files.setPinned(meta.path, false)
      }
    }
    for (const path of keep) await this.#db.files.setPinned(path, true)
  }
}

export function createPuller(deps: PullDeps): Puller {
  return new Puller(deps)
}
