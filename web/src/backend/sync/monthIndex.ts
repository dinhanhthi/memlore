/**
 * Month index reader (Phase 15.2): list-view rows of one UTC month without opening every entry.
 *
 * The desktop named by `puller.indexSource` (slotted, `index_present`, newest manifest) publishes
 * `<device>/index/YYYY-MM.bin` per UTC month plus the catalog `<device>/index/months.bin`, each a
 * device-bin envelope opened with `openDeviceBin` (JSON shapes: memlore-core `month_index.rs`).
 *
 * - `revalidate()` (also run by `getMonths` once per completed pull) downloads the small catalog
 *   through the puller's shared limiter (which checks the lock before every download). A cached
 *   month whose catalog hash changed, a month the catalog no longer lists and every cached month
 *   of another device are dropped. A transient catalog failure keeps the previous catalog of the
 *   same source; a missing or unreadable one leaves no catalog (every month degraded).
 * - Month files are fetched ON DEMAND (`getMonths`) and their ciphertext is cached in the `files`
 *   store under its logical path, with the catalog hash it was fetched for in `etag`. The hash is
 *   never recomputed here (the desktop hashes its own serde bytes): a cached month is reused only
 *   while the catalog still names that hash. Parsed rows are kept in RAM until `clear()`.
 * - Lenient parse with `typeof` checks: a malformed row is skipped; a file that cannot be read,
 *   opened or parsed, or that names another device or month, is DEGRADED for that month only and
 *   never cached. Only `VaultLockedError` propagates: a lock mid-fetch stops the read.
 *
 * FAIL CLOSED: manifests carry no lock flags, so a row may describe an entry locked later. A row is
 * returned only when the entry-index winner exists, is live (neither deleted nor trashed), its
 * `updatedAt` equals the row's `updated_at` and the row's journal is not excluded. A row whose
 * `updated_at` differs is hidden and its id reported in `unconfirmed` (the caller may load the
 * entry through the vault to confirm it); every other failing row is dropped silently.
 *
 * The index is keyed by UTC month while views are local time: `utcMonthsForLocalMonth` gives the
 * UTC months (the month itself plus the adjacent one at the edge) a local month touches.
 */

import { getKeyRing, isUnlocked, VaultLockedError, type KeyRing } from '../keys'
import type { Core } from '../../core/core'
import { isSafeComponent } from '../drive/paths'
import type { WebDb } from '../storage/idb'
import { isLive } from './entryIndex'
import { PullTransientError, type Puller } from './pull'

/** Largest index file the web opens: the WASM `MAX_BIN_BYTES` (memlore-wasm lib.rs). */
const MAX_INDEX_BYTES = 16 * 1024 * 1024
/** `MONTH_INDEX_SCHEMA_VERSION` (memlore-core month_index.rs). */
const SCHEMA_VERSION = 1
const MONTH_KEY = /^\d{4}-(0[1-9]|1[0-2])$/
/** A cached index file: `<device>/index/<name>.bin`. */
const CACHED_INDEX = /^([^/]+)\/index\/([^/]+)\.bin$/

/** `SyncMediaItem` (memlore-core metadata.rs). */
export interface MonthIndexMedia {
  id: string
  file_name: string
  file_type: string
  file_size: number | null
  sort_order: number
  created_at: number
  insertion_mode: string
  width: number | null
  height: number | null
  duration_seconds: number | null
  exif_date: number | null
  exif_latitude: number | null
  exif_longitude: number | null
}

export interface MonthIndexVersionRef {
  version_id: string
  device_id: string
  created_at: number
}

/** `MonthIndexRow` (memlore-core month_index.rs). Times are Unix SECONDS. */
export interface MonthIndexRow {
  entry_id: string
  updated_at: number
  entry_date: number
  journal_id: string
  emotion: string | null
  is_favorite: boolean
  tag_ids: string[]
  word_count: number
  title: string | null
  preview_text: string | null
  latitude: number | null
  longitude: number | null
  location_label: string | null
  media: MonthIndexMedia[]
  versions: MonthIndexVersionRef[]
}

export interface MonthIndexResult {
  /** Rows that passed the fail-closed filter, in month then file order (one per entry). */
  rows: MonthIndexRow[]
  /** Entry ids hidden because the row's `updated_at` differs from the index winner. */
  unconfirmed: string[]
  /** Requested months that could not be read (no source, no catalog, or a bad month file). */
  degraded: string[]
}

export interface MonthIndexDeps {
  puller: Pick<Puller, 'indexSource' | 'index' | 'pulls' | 'readDeviceBin'>
  db: { files: Pick<WebDb['files'], 'get' | 'put' | 'delete' | 'paths'> }
  core: Pick<Core, 'openDeviceBin'>
  /** The vault's journal exclusion (locked, invisible or unknown journal). */
  isJournalExcluded: (journalId: string) => boolean
  /** Defaults to the key holder's. */
  isUnlocked?: () => boolean
  getKeyRing?: () => KeyRing
  /** Unix milliseconds for `lastAccess`. Default `Date.now`. */
  now?: () => number
}

export interface MonthIndexReader {
  /** Re-reads the catalog of the current index source and drops outdated cached months. */
  revalidate(): Promise<void>
  /** Rows of these UTC months (`YYYY-MM`), fetched on demand. */
  getMonths(months: readonly string[]): Promise<MonthIndexResult>
  /** Drops the RAM state and detaches in-flight reads (call on lock). */
  clear(): void
}

interface Catalog {
  device: string
  /** Month to the hash of its index file. */
  hashes: Map<string, string>
}

const decoder = new TextDecoder()

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []

export function createMonthIndexReader(deps: MonthIndexDeps): MonthIndexReader {
  const { puller, db, core } = deps
  const unlocked = deps.isUnlocked ?? isUnlocked
  const ring = deps.getKeyRing ?? getKeyRing
  const now = deps.now ?? Date.now
  let epoch = 0
  let catalog: Catalog | null = null
  /** `puller.pulls` and source the catalog was revalidated for (null: never). */
  let validated: { pull: number; source: string | null } | null = null
  let revalidating: Promise<void> | null = null
  /** Parsed rows by month, with the hash they were read for. */
  let months = new Map<string, { hash: string; rows: MonthIndexRow[] }>()

  const assertUnlocked = (started: number): void => {
    if (!unlocked() || started !== epoch) throw new VaultLockedError()
  }

  const openJson = (bytes: Uint8Array): unknown =>
    JSON.parse(decoder.decode(core.openDeviceBin(ring(), bytes))) as unknown

  /** Bytes of an index file through the shared limiter; null when missing, too large or unreadable. */
  async function download(path: string, started: number): Promise<Uint8Array | null | 'error'> {
    assertUnlocked(started)
    let bytes: Uint8Array | null | 'oversize'
    try {
      bytes = await puller.readDeviceBin(path, MAX_INDEX_BYTES)
    } catch (error) {
      if (error instanceof VaultLockedError) throw error
      assertUnlocked(started)
      return 'error'
    }
    assertUnlocked(started)
    return bytes === 'oversize' ? null : bytes
  }

  async function readCatalog(source: string, started: number): Promise<Catalog | null | 'error'> {
    const path = `${source}/index/months.bin`
    let bytes: Uint8Array | null | 'error'
    try {
      assertUnlocked(started)
      bytes = await puller
        .readDeviceBin(path, MAX_INDEX_BYTES)
        .then((b) => (b === 'oversize' ? null : b))
    } catch (error) {
      if (error instanceof VaultLockedError) throw error
      bytes = error instanceof PullTransientError ? 'error' : null
    }
    assertUnlocked(started)
    if (bytes === null || bytes === 'error') return bytes
    try {
      return toCatalog(openJson(bytes), source)
    } catch {
      return null
    }
  }

  async function prune(current: Catalog | null): Promise<void> {
    for (const path of await db.files.paths()) {
      const match = CACHED_INDEX.exec(path)
      if (match === null) continue
      const [, device, name] = match
      if (current === null || device !== current.device) {
        await db.files.delete(path)
        continue
      }
      const hash = current.hashes.get(name)
      if (hash === undefined) {
        await db.files.delete(path)
        continue
      }
      const cached = await db.files.get(path)
      if (cached !== undefined && cached.etag !== hash) await db.files.delete(path)
    }
    for (const [month, held] of [...months]) {
      if (current?.hashes.get(month) !== held.hash) months.delete(month)
    }
  }

  async function runRevalidate(started: number): Promise<void> {
    assertUnlocked(started)
    const pull = puller.pulls
    const source = puller.indexSource
    if (source === null) {
      catalog = null
      months = new Map()
      validated = { pull, source }
      return
    }
    const read = await readCatalog(source, started)
    if (read === 'error') {
      // Transient: the previous catalog of the same source stays (rows are still fail-closed).
      if (catalog?.device !== source) catalog = null
    } else {
      catalog = read
      // A missing or unreadable catalog says nothing about other devices' caches: only a fresh
      // catalog prunes.
      if (read !== null) await prune(read)
      assertUnlocked(started)
    }
    validated = { pull, source }
  }

  function revalidate(): Promise<void> {
    const started = epoch
    const run = runRevalidate(started).finally(() => {
      if (revalidating === run) revalidating = null
    })
    revalidating = run
    return run
  }

  async function ensureFresh(): Promise<void> {
    if (revalidating !== null) await revalidating
    if (validated?.pull === puller.pulls && validated.source === puller.indexSource) return
    await revalidate()
  }

  /** One month's rows, or null when degraded. */
  async function loadMonth(
    current: Catalog,
    month: string,
    hash: string,
    started: number,
  ): Promise<MonthIndexRow[] | null> {
    const held = months.get(month)
    if (held !== undefined && held.hash === hash) return held.rows
    const path = `${current.device}/index/${month}.bin`
    const cached = await db.files.get(path)
    assertUnlocked(started)
    let bytes: Uint8Array | null | 'error' = null
    let fromCache = false
    if (cached !== undefined && cached.etag === hash) {
      bytes = cached.ciphertext
      fromCache = true
    } else {
      bytes = await download(path, started)
    }
    if (bytes === null || bytes === 'error') return null
    let rows: MonthIndexRow[] | null
    try {
      rows = toMonthRows(openJson(bytes), current.device, month)
    } catch {
      rows = null
    }
    assertUnlocked(started)
    if (rows === null) {
      if (fromCache) await db.files.delete(path)
      return null
    }
    if (!fromCache) {
      const record = {
        path,
        ciphertext: bytes,
        etag: hash,
        modifiedTime: null,
        lastAccess: now(),
        pinned: false,
      }
      // Best effort: a full store must not fail the read.
      await db.files.put(record).catch(() => undefined)
      assertUnlocked(started)
    }
    months.set(month, { hash, rows })
    return rows
  }

  async function getMonths(requested: readonly string[]): Promise<MonthIndexResult> {
    const started = epoch
    assertUnlocked(started)
    await ensureFresh()
    assertUnlocked(started)
    const wanted = [...new Set(requested)].filter((m) => MONTH_KEY.test(m))
    const current = catalog
    if (current === null) return { rows: [], unconfirmed: [], degraded: wanted }
    const loaded = await Promise.all(
      wanted.map(async (month) => {
        const hash = current.hashes.get(month)
        // Not in the catalog: the source has no entry that month.
        if (hash === undefined) return { month, rows: [] as MonthIndexRow[] }
        return { month, rows: await loadMonth(current, month, hash, started) }
      }),
    )
    assertUnlocked(started)
    return filterRows(loaded)
  }

  /**
   * The fail-closed filter. An entry listed in two months (its date moved and one month file is
   * older) yields its matching row; it is `unconfirmed` only when no row matches the winner.
   */
  function filterRows(
    loaded: ReadonlyArray<{ month: string; rows: MonthIndexRow[] | null }>,
  ): MonthIndexResult {
    const index = puller.index
    const result: MonthIndexResult = { rows: [], unconfirmed: [], degraded: [] }
    const candidates: Array<{ row: MonthIndexRow; matches: boolean }> = []
    const confirmed = new Set<string>()
    for (const { month, rows } of loaded) {
      if (rows === null) {
        result.degraded.push(month)
        continue
      }
      for (const row of rows) {
        const winner = index?.get(row.entry_id)
        if (winner === undefined || !isLive(winner)) continue
        if (deps.isJournalExcluded(row.journal_id)) continue
        const matches = winner.updatedAt === row.updated_at
        if (matches) confirmed.add(row.entry_id)
        candidates.push({ row, matches })
      }
    }
    const seen = new Set<string>()
    for (const { row, matches } of candidates) {
      if (seen.has(row.entry_id) || (!matches && confirmed.has(row.entry_id))) continue
      seen.add(row.entry_id)
      if (matches) result.rows.push(row)
      else result.unconfirmed.push(row.entry_id)
    }
    return result
  }

  return {
    revalidate,
    getMonths,
    clear: () => {
      epoch += 1
      catalog = null
      validated = null
      revalidating = null
      months = new Map()
    },
  }
}

// ---------------------------------------------------------------------------------------------
// Payload shape checks (lenient: newer writers may add fields)
// ---------------------------------------------------------------------------------------------

function toCatalog(value: unknown, source: string): Catalog | null {
  if (
    !isRecord(value) ||
    value.schema_version !== SCHEMA_VERSION ||
    value.device_id !== source ||
    !Array.isArray(value.months)
  ) {
    return null
  }
  const hashes = new Map<string, string>()
  for (const item of value.months as unknown[]) {
    if (!isRecord(item)) continue
    const month = str(item.month)
    const hash = str(item.hash_hex)
    if (month !== null && MONTH_KEY.test(month) && hash !== null && hash !== '') {
      hashes.set(month, hash)
    }
  }
  return { device: source, hashes }
}

function toMonthRows(value: unknown, source: string, month: string): MonthIndexRow[] | null {
  if (
    !isRecord(value) ||
    value.schema_version !== SCHEMA_VERSION ||
    value.device_id !== source ||
    value.month !== month
  ) {
    return null
  }
  const rows = Array.isArray(value.rows) ? (value.rows as unknown[]) : []
  return rows.map(toRow).filter((row): row is MonthIndexRow => row !== null)
}

function toRow(value: unknown): MonthIndexRow | null {
  if (!isRecord(value)) return null
  const id = str(value.entry_id)
  const updatedAt = num(value.updated_at)
  if (id === null || !isSafeComponent(id) || id.startsWith('.') || updatedAt === null) return null
  // Fail closed: a row without a journal id cannot be checked against the journal exclusion.
  const journalId = str(value.journal_id)
  if (journalId === null || journalId === '') return null
  return {
    entry_id: id,
    updated_at: updatedAt,
    entry_date: num(value.entry_date) ?? 0,
    journal_id: journalId,
    emotion: str(value.emotion),
    is_favorite: value.is_favorite === true,
    tag_ids: strings(value.tag_ids),
    word_count: num(value.word_count) ?? 0,
    title: str(value.title),
    preview_text: str(value.preview_text),
    latitude: num(value.latitude),
    longitude: num(value.longitude),
    location_label: str(value.location_label),
    media: Array.isArray(value.media)
      ? value.media.map(toMedia).filter((m): m is MonthIndexMedia => m !== null)
      : [],
    versions: Array.isArray(value.versions)
      ? value.versions.map(toVersion).filter((v): v is MonthIndexVersionRef => v !== null)
      : [],
  }
}

function toMedia(value: unknown): MonthIndexMedia | null {
  if (!isRecord(value)) return null
  const id = str(value.id)
  const fileName = str(value.file_name)
  const fileType = str(value.file_type)
  if (id === null || fileName === null || fileType === null) return null
  return {
    id,
    file_name: fileName,
    file_type: fileType,
    file_size: num(value.file_size),
    sort_order: num(value.sort_order) ?? 0,
    created_at: num(value.created_at) ?? 0,
    insertion_mode: str(value.insertion_mode) ?? '',
    width: num(value.width),
    height: num(value.height),
    duration_seconds: num(value.duration_seconds),
    exif_date: num(value.exif_date),
    exif_latitude: num(value.exif_latitude),
    exif_longitude: num(value.exif_longitude),
  }
}

function toVersion(value: unknown): MonthIndexVersionRef | null {
  if (!isRecord(value)) return null
  const id = str(value.version_id)
  if (id === null) return null
  return {
    version_id: id,
    device_id: str(value.device_id) ?? '',
    created_at: num(value.created_at) ?? 0,
  }
}

// ---------------------------------------------------------------------------------------------
// UTC month keys for local-time views
// ---------------------------------------------------------------------------------------------

/** UTC `YYYY-MM` of a Unix-seconds instant (desktop `month_key`). */
function utcMonthKey(secs: number): string {
  const date = new Date(secs * 1000)
  return `${String(date.getUTCFullYear()).padStart(4, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
}

/** Every UTC month the Unix-seconds range `[from, to)` touches, ascending. Empty when `to <= from`. */
export function utcMonthsCovering(fromSecs: number, toSecs: number): string[] {
  if (!Number.isFinite(fromSecs) || !Number.isFinite(toSecs) || toSecs <= fromSecs) return []
  const out: string[] = []
  const last = utcMonthKey(toSecs - 1)
  const start = new Date(fromSecs * 1000)
  let year = start.getUTCFullYear()
  let month = start.getUTCMonth()
  for (;;) {
    const key = utcMonthKey(Date.UTC(year, month, 1) / 1000)
    out.push(key)
    if (key >= last) return out
    month += 1
    if (month === 12) {
      month = 0
      year += 1
    }
  }
}

/**
 * The UTC months a LOCAL month (`YYYY-MM`, this runtime's time zone) touches: the month itself and,
 * at a month edge, the adjacent one. Empty for a malformed key.
 */
export function utcMonthsForLocalMonth(month: string): string[] {
  if (!MONTH_KEY.test(month)) return []
  const year = Number(month.slice(0, 4))
  const index = Number(month.slice(5, 7)) - 1
  const from = new Date(year, index, 1).getTime() / 1000
  const to = new Date(year, index + 1, 1).getTime() / 1000
  return utcMonthsCovering(from, to)
}
