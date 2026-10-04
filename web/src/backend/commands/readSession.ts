/**
 * Shared read session for the entry / taxonomy / search commands (Phase 10.3).
 *
 * One lazily built `{db, puller, vault}` per page. `ready()` is what every read handler awaits:
 *   1. `puller.refresh()` when there is no index yet (the sync commands of Phase 10.4 will drive
 *      later refreshes; a new index object invalidates the taxonomy cache below),
 *   2. the journal/tag/template files are opened and the locked and invisible journal ids are fed to
 *      `vault.setExcludedJournalIds` BEFORE any entry is loaded (so an entry of a locked journal is
 *      never retained),
 *   3. once per unlock, every draft in IndexedDB is opened and fed to `vault.setOutboxIntents`
 *      (Phase 16.5), so the overlay and the next write's `priorIntent` see the web edits saved
 *      before a reload. Every write command awaits `ready()` first, so none runs on an empty
 *      overlay,
 *   4. `warmStart()` once per unlock: only the 5 newest entry payloads are loaded.
 * Every read handler first checks the key holder and rejects with `VaultLockedError` when locked.
 *
 * Heavy modules (WASM core, puller, vault, Drive client, IndexedDB) are imported lazily by the
 * default session, so importing this file has no side effects.
 */

import type { Core } from '../../core/core'
import type { Journal, Tag } from '../../../../src/types/journal'
import type { Template } from '../../../../src/types/template'
import { PAGE_SIZE } from '../../../../src/types/pagination'
import { emitFromBackend } from '../../tauri/event'
import { VaultLockedError, getKeyRing, isUnlocked, onLock, type KeyRing } from '../keys'
import type { DriveReader } from '../drive/client'
import { JOURNAL_SEEN_PREFIX, type WebDb } from '../storage/idb'
import type { IndexEntry } from '../sync/entryIndex'
import type { OutboxEntryV1 } from '../sync/outbox'
import type { Limiter } from '../sync/pull'
import type { Vault } from '../vault'

/** The part of the vault the read commands use. */
export type VaultApi = Pick<
  Vault,
  | 'load'
  | 'getEntry'
  | 'getContentBytes'
  | 'isLoaded'
  | 'status'
  | 'listLoaded'
  | 'listIndex'
  | 'search'
  | 'tagCounts'
  | 'setOutboxIntents'
  | 'getOutboxIntents'
  | 'getOutboxIntent'
>

export interface Taxonomy {
  /** Visible journals only (not deleted, locked or invisible), `sort_order` then `created_at`. */
  journals: Journal[]
  /** Auto-apply tag ids per journal id (own keys only: ids come from payloads). */
  autoTagIds: Record<string, string[]>
  /**
   * Locked or invisible journals (any state, rollback-protected: see `readTaxonomy`): their entries
   * are excluded from every view.
   */
  excludedJournalIds: string[]
  /** Journals with a record on the cloud or a seen record. An entry of any other journal is hidden. */
  knownJournalIds: string[]
  /** Live tags, by name. */
  tags: Tag[]
  /** Live user templates (predefined templates do not sync), `sort_order` then name. */
  templates: Template[]
}

/** What one `pull()` observed. */
export interface PullOutcome {
  /** Entry ids whose manifest row changed since the previous pull. */
  stale: string[]
  /**
   * The visible content may differ from before: the index, a stale id or the journals, tags or
   * templates changed. False for the very first pull of a session (nothing was shown before).
   */
  changed: boolean
  /** Devices whose manifest could not be read fresh (the cached one was used). Empty or absent: none. */
  degraded?: ReadonlyArray<{ device: string; reason: string }>
}

/** What the media commands (Phase 11.1) need besides the vault: ciphertext cache, reader, core. */
export interface MediaBackend {
  db: Pick<WebDb, 'blobs' | 'files' | 'device'>
  reader: Pick<DriveReader, 'readDeviceFile'>
  core: Pick<Core, 'openMedia'>
  /** The puller's download limiter (concurrency 4), shared so media and entries obey one cap. */
  limit: Limiter
}

export interface ReadSession {
  vault: VaultApi
  /** Absent in sessions that cannot serve media. */
  media?: MediaBackend
  db?: WebDb
  core?: Core
  /** Refreshes the index if needed, applies the journal exclusions, warm-starts once. */
  ready: () => Promise<Taxonomy>
  /**
   * Phase 10.4: re-reads the cloud (always hits the network), re-applies the journal exclusions
   * and reloads the entries that are already in RAM and changed on the server.
   */
  pull: () => Promise<PullOutcome>
}

export interface ReadEnv {
  isUnlocked: () => boolean
  session: () => Promise<ReadSession>
  /** Content-changed notification (`memlore:entries-changed`). */
  emit: (event: string) => void
  /** Unix milliseconds. */
  now: () => number
  pageSize: number
}

let injected: Partial<ReadEnv> = {}
let sessionPromise: Promise<ReadSession> | null = null

function defaultEmit(event: string): void {
  // The UI listens with `window.addEventListener` (src/hooks, App.tsx); the shim reaches `listen`ers.
  emitFromBackend(event)
  if (typeof window !== 'undefined' && typeof CustomEvent !== 'undefined') {
    window.dispatchEvent(new CustomEvent(event))
  }
}

function defaultEnv(): ReadEnv {
  return {
    isUnlocked,
    session: getDefaultSession,
    emit: defaultEmit,
    now: () => Date.now(),
    pageSize: PAGE_SIZE,
  }
}

export const readEnv = (): ReadEnv => ({ ...defaultEnv(), ...injected })

/** Test seam: override injected pieces. Pass `{}` to restore the defaults. */
export function configureReadEnv(partial: Partial<ReadEnv>): void {
  injected = partial
  sessionPromise = null
}

function getDefaultSession(): Promise<ReadSession> {
  sessionPromise ??= buildSession().catch((error: unknown) => {
    sessionPromise = null
    throw error
  })
  return sessionPromise
}

/**
 * Locked: rejects with `VaultLockedError`. Otherwise the vault and the taxonomy, with the index
 * refreshed and the journal exclusions applied.
 */
export async function openForRead(): Promise<{ vault: VaultApi; taxonomy: Taxonomy }> {
  const env = readEnv()
  if (!env.isUnlocked()) throw new VaultLockedError()
  const session = await env.session()
  const taxonomy = await session.ready()
  return { vault: session.vault, taxonomy }
}

/**
 * Write session: returns the vault, taxonomy, IndexedDB and wasm core.
 * Rejects with VaultLockedError if locked or if write dependencies are unavailable.
 */
export async function openForWrite(): Promise<{
  vault: VaultApi
  taxonomy: Taxonomy
  db: WebDb
  core: Core
}> {
  const env = readEnv()
  if (!env.isUnlocked()) throw new VaultLockedError()
  const session = await env.session()
  const taxonomy = await session.ready()
  if (!session.db || !session.core) {
    throw new Error('Write session dependencies (db, core) unavailable')
  }
  return { vault: session.vault, taxonomy, db: session.db, core: session.core }
}

// ---------------------------------------------------------------------------------------------
// Default session
// ---------------------------------------------------------------------------------------------

async function buildSession(): Promise<ReadSession> {
  const [{ openWebDb }, { DriveReader }, { oauth }, core] = await Promise.all([
    import('../storage/idb'),
    import('../drive/client'),
    import('../drive/oauth'),
    import('../../core/core').then((m) => m.loadCore()),
  ])
  const reader = new DriveReader({
    getToken: () => oauth.getAccessToken(),
    sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  })
  return createReadSession({ db: await openWebDb(), reader, core })
}

export interface ReadSessionDeps {
  db: WebDb
  reader: DriveReader
  core: Core
}

/** The session over a given store, Drive reader and core (the default one passes the real ones). */
export async function createReadSession(deps: ReadSessionDeps): Promise<ReadSession> {
  const { db, reader, core } = deps
  const [{ createPuller }, { createVault }, { createDraftManager }] = await Promise.all([
    import('../sync/pull'),
    import('../vault'),
    import('../drafts'),
  ])
  const puller = createPuller({ reader, db, core })
  const vault = createVault({ core, puller })

  let cache: { key: unknown; value: Taxonomy } | null = null
  let warmed: Promise<void> | null = null
  let hydrated: Promise<void> | null = null
  // Bumped by the lock hook. Every step that awaits captures it first and discards its result
  // (writes no cache, no exclusions, no warm-start state) when a lock landed in between.
  let epoch = 0
  onLock(() => {
    epoch += 1
    cache = null
    warmed = null
    hydrated = null
  })
  const assertSameEpoch = (started: number): void => {
    if (started !== epoch) throw new VaultLockedError()
  }

  const taxonomy = async (): Promise<Taxonomy> => {
    const started = epoch
    const key = puller.index
    if (cache !== null && key !== null && cache.key === key) return cache.value
    const value = await readTaxonomy(db, core, getKeyRing())
    assertSameEpoch(started)
    vault.setExcludedJournalIds(value.excludedJournalIds, value.knownJournalIds)
    cache = { key, value }
    return value
  }

  // Lists every draft (pushed ones too: a pushed edit may not be imported yet), which also
  // recomputes the page's dirty flag after a reload. Intents already in the overlay win: they
  // were set by a write after these drafts were read.
  const hydrate = async (): Promise<void> => {
    const started = epoch
    const drafts = await createDraftManager({ db }).listDrafts()
    assertSameEpoch(started)
    if (drafts.length === 0) return
    const ring = getKeyRing()
    const opened = drafts.flatMap((d) => openDraft(core, ring, d.entryId, d.sealed))
    const current = vault.getOutboxIntents()
    const set = new Set(current.map((i) => i.entry_id))
    vault.setOutboxIntents([...opened.filter((i) => !set.has(i.entry_id)), ...current])
  }

  const ready = async (): Promise<Taxonomy> => {
    const started = epoch
    if (puller.index === null) await puller.refresh()
    assertSameEpoch(started)
    const value = await taxonomy()
    assertSameEpoch(started)
    if (hydrated === null) {
      const run = hydrate()
      hydrated = run
      run.catch(() => {
        if (hydrated === run) hydrated = null
      })
    }
    await hydrated
    assertSameEpoch(started)
    if (warmed === null) {
      const run = puller.warmStart().then(async (ids) => {
        await vault.load(ids)
      })
      warmed = run
      run.catch(() => {
        if (warmed === run) warmed = null
      })
    }
    await warmed
    assertSameEpoch(started)
    return value
  }

  const pull = async (): Promise<PullOutcome> => {
    const started = epoch
    const before = puller.index
    const taxonomyBefore = cache === null ? null : JSON.stringify(cache.value)
    const result = await puller.refresh()
    assertSameEpoch(started)
    const value = await ready()
    assertSameEpoch(started)
    // Lazy policy: only what is already in RAM is reloaded, stubs included (an entry that was
    // locked or in a locked journal may be visible now). The puller dropped the stale ciphertext,
    // and `vault.load` refetches any copy older than the index winner (a tombstone becomes a
    // stub), so a changed entry is never served from RAM.
    await vault.load(result.stale.filter((id) => vault.status(id) !== 'not-loaded'))
    assertSameEpoch(started)
    const taxonomyChanged = taxonomyBefore !== null && taxonomyBefore !== JSON.stringify(value)
    const changed =
      before !== null &&
      (result.stale.length > 0 || taxonomyChanged || indexDiffers(before, puller.index))
    return { stale: result.stale, changed, degraded: puller.getDegradedDevices() }
  }

  return { vault, media: { db, reader, core, limit: puller.limit }, db, core, ready, pull }
}

/**
 * One draft's intent, or nothing when it cannot be opened or is not an intent for `entryId`. A
 * draft that fails is logged and KEPT (it may open after a key change; dropping it loses an edit).
 */
function openDraft(
  core: Core,
  ring: KeyRing,
  entryId: string,
  sealed: Uint8Array,
): OutboxEntryV1[] {
  try {
    const parsed = JSON.parse(core.openOutboxEntry(ring, sealed)) as unknown
    if (!isRecord(parsed) || parsed.entry_id !== entryId || !isRecord(parsed.fields)) {
      throw new Error('not an outbox intent for this entry')
    }
    return [parsed as unknown as OutboxEntryV1]
  } catch (error) {
    console.warn(`Skipping draft ${entryId}: it could not be opened`, error)
    return []
  }
}

function indexDiffers(
  before: ReadonlyMap<string, IndexEntry>,
  after: ReadonlyMap<string, IndexEntry> | null,
): boolean {
  if (after === null || before.size !== after.size) return true
  for (const [id, row] of before) {
    const next = after.get(id)
    if (
      next === undefined ||
      next.authorDevice !== row.authorDevice ||
      next.updatedAt !== row.updatedAt ||
      next.isDeleted !== row.isDeleted
    ) {
      return true
    }
  }
  return false
}

// ---------------------------------------------------------------------------------------------
// Journal / tag / template files (`<device>/journals/*.bin`, `tags.bin`, `templates.bin`)
// ---------------------------------------------------------------------------------------------

const JOURNAL_PATH = /^([^/.][^/]*)\/journals\/[^/]+\.bin$/
const TAGS_PATH = /^([^/.][^/]*)\/tags\.bin$/
const TEMPLATES_PATH = /^([^/.][^/]*)\/templates\.bin$/

const decoder = new TextDecoder()

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

/** Greater `updated_at` wins; tie: the greater device id (the desktop LWW rule). */
function newer(
  a: { updatedAt: number; device: string },
  b: { updatedAt: number; device: string },
): boolean {
  return a.updatedAt !== b.updatedAt ? a.updatedAt > b.updatedAt : a.device > b.device
}

async function openJson(db: WebDb, core: Core, ring: KeyRing, path: string): Promise<unknown> {
  const record = await db.files.get(path)
  if (record === undefined) return null
  return JSON.parse(decoder.decode(core.openDeviceBin(ring, record.ciphertext))) as unknown
}

function fromBase64(b64: string): number[] {
  return Array.from(atob(b64), (c) => c.charCodeAt(0))
}

interface Ranked<T> {
  updatedAt: number
  device: string
  value: T
}

function keepNewest<T>(into: Map<string, Ranked<T>>, id: string, candidate: Ranked<T>): void {
  const current = into.get(id)
  if (current === undefined || newer(candidate, current)) into.set(id, candidate)
}

// ---------------------------------------------------------------------------------------------
// Journal lock state is rollback-protected
// ---------------------------------------------------------------------------------------------

/** Highest-seen lock state of a journal: `journal-seen:<id>` = `"<updatedAt>:<l>:<i>"` in `meta`. */
interface SeenJournal {
  updatedAt: number
  locked: boolean
  invisible: boolean
}

const SEEN_VALUE = /^(\d{1,16}):([01]):([01])$/

function parseSeen(value: unknown): SeenJournal | null {
  const m = typeof value === 'string' ? SEEN_VALUE.exec(value) : null
  if (m === null) return null // a damaged hint is ignored, never trusted
  return { updatedAt: Number(m[1]), locked: m[2] === '1', invisible: m[3] === '1' }
}

const seenValue = (s: SeenJournal): string =>
  `${s.updatedAt}:${s.locked ? 1 : 0}:${s.invisible ? 1 : 0}`

async function loadSeen(db: WebDb): Promise<Map<string, SeenJournal>> {
  const seen = new Map<string, SeenJournal>()
  for (const record of await db.meta.listByPrefix(JOURNAL_SEEN_PREFIX)) {
    const parsed = parseSeen(record.value)
    if (parsed !== null) seen.set(record.key.slice(JOURNAL_SEEN_PREFIX.length), parsed)
  }
  return seen
}

/**
 * The lock flags that apply to a journal: the Drive winner, unless a seen record is NEWER (the
 * cloud copy was rolled back or deleted by someone who can write to Drive but cannot forge a newer
 * AEAD copy). On an equal `updated_at` the stricter flag wins. Records the newest state seen.
 */
async function applySeen(
  db: WebDb,
  seen: Map<string, SeenJournal>,
  journal: Journal,
): Promise<void> {
  const previous = seen.get(journal.id)
  let locked = journal.is_locked
  let invisible = journal.is_invisible
  if (previous !== undefined && previous.updatedAt > journal.updated_at) {
    locked = previous.locked
    invisible = previous.invisible
  } else if (previous !== undefined && previous.updatedAt === journal.updated_at) {
    locked ||= previous.locked
    invisible ||= previous.invisible
  }
  journal.is_locked = locked
  journal.is_invisible = invisible
  const next: SeenJournal = { updatedAt: journal.updated_at, locked, invisible }
  const advance =
    previous === undefined ||
    next.updatedAt > previous.updatedAt ||
    (next.updatedAt === previous.updatedAt &&
      (next.locked !== previous.locked || next.invisible !== previous.invisible))
  if (!advance || !Number.isSafeInteger(next.updatedAt) || next.updatedAt < 0) return
  seen.set(journal.id, next)
  // Best effort: a failing store must not fail the read (the hint only adds protection).
  await db.meta
    .put({ key: `${JOURNAL_SEEN_PREFIX}${journal.id}`, value: seenValue(next) })
    .catch(() => undefined)
}

/**
 * Opens every cached journal, tag and template file with the current ring and merges the devices
 * by LWW per id. Any file that cannot be opened rejects (fail closed: a missing journal flag could
 * let a locked journal's entries through). The journal flags are also checked against the highest
 * state ever seen (`journal-seen:` records), so an older unlocked copy or a deleted file cannot
 * re-admit a journal; a journal with no record at all is reported unknown (entries hidden).
 */
export async function readTaxonomy(db: WebDb, core: Core, ring: KeyRing): Promise<Taxonomy> {
  const paths = (await db.files.paths()).sort()
  const journals = new Map<string, Ranked<Journal & { autoTagIds: string[] }>>()
  const tags = new Map<string, Ranked<{ tag: Tag; deleted: boolean }>>()
  const templates = new Map<string, Ranked<{ template: Template; deleted: boolean }>>()

  for (const path of paths) {
    const journalDevice = JOURNAL_PATH.exec(path)?.[1]
    const tagsDevice = TAGS_PATH.exec(path)?.[1]
    const templatesDevice = TEMPLATES_PATH.exec(path)?.[1]
    if (journalDevice === undefined && tagsDevice === undefined && templatesDevice === undefined) {
      continue
    }
    const raw = await openJson(db, core, ring, path)
    if (!isRecord(raw)) continue
    if (journalDevice !== undefined) {
      const j = parseJournal(raw)
      if (j !== null) {
        keepNewest(journals, j.id, { updatedAt: j.updated_at, device: journalDevice, value: j })
      }
    } else if (tagsDevice !== undefined) {
      for (const row of Array.isArray(raw.tags) ? (raw.tags as unknown[]) : []) {
        const t = parseTag(row)
        if (t !== null) keepNewest(tags, t.value.tag.id, { ...t, device: tagsDevice })
      }
    } else if (templatesDevice !== undefined) {
      for (const row of Array.isArray(raw.templates) ? (raw.templates as unknown[]) : []) {
        const t = parseTemplate(row)
        if (t !== null)
          keepNewest(templates, t.value.template.id, { ...t, device: templatesDevice })
      }
    }
  }

  const winners = [...journals.values()].map((r) => r.value)
  const seen = await loadSeen(db)
  for (const j of winners) await applySeen(db, seen, j)
  const known = new Set<string>([...seen.keys(), ...winners.map((j) => j.id)])
  const excluded = new Set<string>(
    winners.filter((j) => j.is_locked || j.is_invisible).map((j) => j.id),
  )
  for (const [id, s] of seen) if (s.locked || s.invisible) excluded.add(id)
  // No prototype: a journal id such as `__proto__` is an ordinary key.
  const autoTagIds = Object.create(null) as Record<string, string[]>
  for (const j of winners) autoTagIds[j.id] = j.autoTagIds
  return {
    journals: winners
      .filter((j) => !j.is_deleted && !j.is_locked && !j.is_invisible)
      .map(stripAutoTags)
      .sort((a, b) => a.sort_order - b.sort_order || a.created_at - b.created_at),
    autoTagIds,
    excludedJournalIds: [...excluded],
    knownJournalIds: [...known],
    tags: [...tags.values()]
      .filter((r) => !r.value.deleted)
      .map((r) => r.value.tag)
      .sort((a, b) => a.name.localeCompare(b.name)),
    templates: [...templates.values()]
      .filter((r) => !r.value.deleted)
      .map((r) => r.value.template)
      .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name)),
  }
}

function stripAutoTags(journal: Journal & { autoTagIds: string[] }): Journal {
  const copy: Journal & { autoTagIds?: string[] } = { ...journal }
  delete copy.autoTagIds
  return copy
}

function parseJournal(raw: Record<string, unknown>): (Journal & { autoTagIds: string[] }) | null {
  if (
    typeof raw.journal_id !== 'string' ||
    typeof raw.name !== 'string' ||
    typeof raw.updated_at !== 'number'
  ) {
    return null
  }
  return {
    id: raw.journal_id,
    name: raw.name,
    color: str(raw.color),
    created_at: typeof raw.created_at === 'number' ? raw.created_at : 0,
    updated_at: raw.updated_at,
    sort_order: typeof raw.sort_order === 'number' ? raw.sort_order : 0,
    is_deleted: raw.is_deleted === true,
    is_locked: raw.is_locked === true,
    is_invisible: raw.is_invisible === true,
    vault_id: str(raw.vault_id),
    // Not on the wire: the placeholder is a per-device seed.
    is_initial_placeholder: false,
    autoTagIds: strings(raw.auto_tag_ids),
  }
}

function parseTag(row: unknown): Omit<Ranked<{ tag: Tag; deleted: boolean }>, 'device'> | null {
  if (!isRecord(row) || typeof row.id !== 'string' || typeof row.name !== 'string') return null
  return {
    updatedAt: typeof row.updated_at === 'number' ? row.updated_at : 0,
    value: {
      tag: { id: row.id, name: row.name, color: str(row.color) },
      deleted: row.is_deleted === true,
    },
  }
}

function parseTemplate(
  row: unknown,
): Omit<Ranked<{ template: Template; deleted: boolean }>, 'device'> | null {
  if (!isRecord(row) || typeof row.id !== 'string' || typeof row.name !== 'string') return null
  const b64 = str(row.content_b64)
  return {
    updatedAt: typeof row.updated_at === 'number' ? row.updated_at : 0,
    value: {
      deleted: row.is_deleted === true,
      template: {
        id: row.id,
        name: row.name,
        description: str(row.description),
        content: b64 === null ? null : fromBase64(b64),
        // Predefined templates never sync; every row on the wire is a user template.
        is_predefined: false,
        sort_order: typeof row.sort_order === 'number' ? row.sort_order : 0,
        created_at: typeof row.created_at === 'number' ? row.created_at : 0,
      },
    },
  }
}
