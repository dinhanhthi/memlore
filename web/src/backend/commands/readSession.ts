/**
 * Shared read session for the entry / taxonomy / search commands (Phase 10.3).
 *
 * One lazily built `{db, puller, vault}` per page. `ready()` is what every read handler awaits:
 *   1. `puller.primeFromCache()` first — the cached index serves the list at once while the
 *      sync schedule's unlock pull revalidates (stale-while-revalidate); `puller.refresh()`
 *      runs only when nothing could be primed (the sync commands of Phase 10.4 drive later
 *      refreshes; a new index object invalidates the taxonomy cache below),
 *   2. the journal/tag/template files are opened and the locked and invisible journal ids are fed to
 *      `vault.setExcludedJournalIds` BEFORE any entry is loaded (so an entry of a locked journal is
 *      never retained),
 *   3. once per unlock, every draft in IndexedDB is opened and fed to `vault.setOutboxIntents`
 *      (Phase 16.5), so the overlay and the next write's `priorIntent` see the web edits saved
 *      before a reload. Every write command awaits `ready()` first, so none runs on an empty
 *      overlay. Intent retention (`sync/retention.ts`) then runs once, and again after every
 *      `pull()`; its notices are returned by the next `pull()`. Retention passes and the
 *      outbox-writing entry commands share one per-session mutex (`acquireOutboxLock`), so a pass
 *      never drops a draft (and its media) that a write is rebuilding from `priorIntent`,
 *   4. `warmStart()` once per unlock: only the 5 newest entry payloads are loaded.
 * The pending outbox v2 drafts (Phase 22: journal / tag creates, template edits, entry trashes) are
 * re-read at hydration and after every retention pass (`refreshPending`): pending trashes are
 * hidden in the vault, pending journals admitted, and `openForRead` / `openForWrite` overlay the
 * pending creates and template edits on the taxonomy. `ready()` itself stays synced: push
 * hold-back and retention read it (see `pendingTaxonomy.ts`).
 * After every `puller.refresh()`, the intents the pull read from OTHER web devices' outboxes are
 * opened, validated and fed to `vault.setForeignIntents` (read-only overlay, Phase 16.2); one that
 * fails is skipped and logged by error name only.
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
import { nowSecs } from '../clock'
import { VaultLockedError, getKeyRing, isUnlocked, onLock, type KeyRing } from '../keys'
import type { DriveReader } from '../drive/client'
import { JOURNAL_SEEN_PREFIX, draftKind, type DraftRecord, type WebDb } from '../storage/idb'
import type { IndexEntry } from '../sync/entryIndex'
import type { OutboxEntryV1, WebNotice } from '../sync/outbox'
import type { MonthIndexReader } from '../sync/monthIndex'
import type { ForeignIntentFile, Limiter } from '../sync/pull'
import type { Vault } from '../vault'
import type { DeviceBinLoader } from './deviceBins'
import {
  NO_PENDING,
  overlayTaxonomy,
  pendingFromDrafts,
  pendingJournalIds,
  type PendingV2,
} from './pendingTaxonomy'

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
  | 'setForeignIntents'
  | 'setTrashedIds'
  | 'getWriteView'
  | 'getSynced'
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
  /** Every tag id in the pulled `tags.bin` files, live or deleted (Phase 21 retention). */
  knownTagIds: string[]
  /**
   * Names of the tags whose synced winner is deleted (Phase 22): the desktop refuses a web tag
   * create under one of them (`name_taken`), so the web refuses it first.
   */
  deletedTagNames: string[]
  /**
   * Names of the locked journals (not deleted, not invisible) (Phase 22): desktop
   * `create_journal_with_id` refuses a web journal create under one of them (`name_taken`).
   */
  lockedJournalNames: string[]
  /** Live user templates (predefined templates do not sync), `sort_order` then name. */
  templates: Template[]
  /** Template ids whose synced winner is deleted (Phase 21 retention). */
  deletedTemplateIds: string[]
  /**
   * `updated_at` of each live synced template (Phase 22): the `base_updated_at` of a web template
   * edit or delete. Own keys only.
   */
  templateUpdatedAt: Record<string, number>
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
  /**
   * Intent-retention notices raised since the previous pull, oldest first (Phase 16.6.8). Each
   * is returned once: it is persisted as shown before it is queued.
   */
  notices?: WebNotice[]
  /**
   * Set while the format guard is latched (an unknown manifest, envelope or metadata format was
   * read): why. Reads go on; every write is refused until reload. Absent: not latched.
   */
  formatReadOnly?: string
  /**
   * What the synced desktops offer, read from this refresh (Phase 15.1): `outboxV2` = a slotted
   * desktop imports outbox v2 intents, `monthIndex` = a desktop publishes the month index.
   * Absent: none.
   */
  capabilities?: { outboxV2: boolean; monthIndex: boolean }
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
  /** On-demand `chats.bin` / `memory.bin` and cached `streak.bin` (Phase 5). Absent in test doubles. */
  deviceBins?: DeviceBinLoader
  /**
   * Month index rows of the index source desktop (Phase 15.2). Await `ready()` before
   * `getMonths`: the journal exclusion it applies is set there. Absent in test doubles.
   */
  monthIndex?: MonthIndexReader
  db?: WebDb
  core?: Core
  /** Refreshes the index if needed, applies the journal exclusions, warm-starts once. */
  ready: () => Promise<Taxonomy>
  /**
   * Phase 20.3: some slot-holding desktop of the last refresh advertises `outbox_versions ∋ 2`.
   * Absent in test doubles (= false).
   */
  outboxV2Capable?: () => boolean
  /**
   * Phase 22: this browser's pending v2 creates, template edits and trashes (`pendingTaxonomy.ts`),
   * as last read. Absent in test doubles (= none).
   */
  pendingV2?: () => PendingV2
  /**
   * Re-reads the pending v2 drafts, then hides the pending trashes and admits the pending journals
   * in the vault. Run by the session after every retention pass; every v2 write runs it after
   * saving its draft. Absent in test doubles.
   */
  refreshPendingV2?: () => Promise<void>
  /**
   * Waits for the outbox mutex (held by one retention pass or one outbox write at a time) and
   * resolves its release. Never await `ready()` or `pull()` while holding it: both can run
   * retention, which waits for the same mutex.
   */
  acquireOutboxLock: () => Promise<() => void>
  /**
   * Phase 10.4: re-reads the cloud (always hits the network), re-applies the journal exclusions
   * and reloads the entries that are already in RAM and changed on the server.
   */
  pull: () => Promise<PullOutcome>
  /** Unregisters the session's lock hooks (its own and the vault's). Absent in test doubles. */
  dispose?: () => void
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

/**
 * Forgets the default session, so the next `session()` builds a new one. For a switch to another
 * vault: the puller's index and foreign intents survive a lock, so the old session must go. Call
 * it while locked (its lock hooks have already cleared the RAM caches).
 */
export function resetReadSession(): void {
  const dropped = sessionPromise
  sessionPromise = null
  // Its lock hooks would otherwise stay registered for the life of the page.
  void dropped?.then(
    (session) => session.dispose?.(),
    () => undefined,
  )
}

function getDefaultSession(): Promise<ReadSession> {
  sessionPromise ??= buildSession().catch((error: unknown) => {
    sessionPromise = null
    throw error
  })
  return sessionPromise
}

/** The synced taxonomy with the session's pending v2 overlay (`pendingTaxonomy.ts`). */
function overlaid(session: ReadSession, synced: Taxonomy): Taxonomy {
  return overlayTaxonomy(synced, session.pendingV2?.() ?? NO_PENDING)
}

/**
 * Locked: rejects with `VaultLockedError`. Otherwise the vault and the taxonomy, with the index
 * refreshed and the journal exclusions applied. The taxonomy includes this browser's pending
 * journal / tag creates and template edits (Phase 22).
 */
export async function openForRead(): Promise<{ vault: VaultApi; taxonomy: Taxonomy }> {
  const env = readEnv()
  if (!env.isUnlocked()) throw new VaultLockedError()
  const session = await env.session()
  const taxonomy = await session.ready()
  return { vault: session.vault, taxonomy: overlaid(session, taxonomy) }
}

/**
 * Write session: returns the vault, taxonomy (pending overlay included, as `openForRead`),
 * IndexedDB and wasm core, the session's v2 capability and its pending-overlay refresh.
 * Rejects with VaultLockedError if locked or if write dependencies are unavailable.
 */
export async function openForWrite(): Promise<{
  vault: VaultApi
  taxonomy: Taxonomy
  /** The synced taxonomy alone (the bases of v2 template intents). */
  synced: Taxonomy
  /** `synced` with the pending overlay as of now: call it under the outbox lock. */
  currentTaxonomy: () => Taxonomy
  db: WebDb
  core: Core
  outboxV2Capable: boolean
  refreshPendingV2: () => Promise<void>
}> {
  const env = readEnv()
  if (!env.isUnlocked()) throw new VaultLockedError()
  const session = await env.session()
  const taxonomy = await session.ready()
  if (!session.db || !session.core) {
    throw new Error('Write session dependencies (db, core) unavailable')
  }
  return {
    vault: session.vault,
    taxonomy: overlaid(session, taxonomy),
    synced: taxonomy,
    currentTaxonomy: () => overlaid(session, taxonomy),
    db: session.db,
    core: session.core,
    outboxV2Capable: session.outboxV2Capable?.() ?? false,
    refreshPendingV2: async () => {
      await session.refreshPendingV2?.()
    },
  }
}

/** The session's outbox mutex (see `ReadSession.acquireOutboxLock`). Call after `openForWrite()`. */
export async function acquireOutboxLock(): Promise<() => void> {
  return (await readEnv().session()).acquireOutboxLock()
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
  const [
    { createPuller, PullTransientError },
    { createVault },
    { createDraftManager },
    { runRetention },
    { checkEntryMetadata, getFormatGuardReason, passesFormatGuard },
    { createDeviceBinLoader },
    { createMonthIndexReader },
  ] = await Promise.all([
    import('../sync/pull'),
    import('../vault'),
    import('../drafts'),
    import('../sync/retention'),
    import('../sync/formatGuard'),
    import('./deviceBins'),
    import('../sync/monthIndex'),
  ])
  const puller = createPuller({ reader, db, core })
  const deviceBins = createDeviceBinLoader({ puller, db, core })
  const vault = createVault({
    core,
    puller,
    guardMetadata: (id, json) => {
      passesFormatGuard(() => checkEntryMetadata(core, `entries/${id}.bin#metadata`, json))
    },
  })
  const monthIndex = createMonthIndexReader({
    puller,
    db,
    core,
    isJournalExcluded: (journalId) => vault.isJournalExcluded(journalId),
  })

  let cache: { key: unknown; value: Taxonomy } | null = null
  let warmed: Promise<void> | null = null
  let hydrated: Promise<void> | null = null
  /** Once-per-unlock `puller.primeFromCache` memo; a rejection clears it so the next call retries. */
  let primed: Promise<boolean> | null = null
  /** The index object `prime()` produced: while it still stands, a transient warm failure is noise. */
  let primedIndex: ReadonlyMap<string, IndexEntry> | null = null
  /** The puller's foreign intent set last fed to the vault (a refresh makes a new array). */
  let foreignSeen: readonly ForeignIntentFile[] | null = null
  /** `<device>/<entry>@<web_updated_at_secs>` of the foreign intents shown, for `changed`. */
  let foreignKey = ''
  /** This browser's pending v2 drafts, as last read (`refreshPending`). */
  let pending: PendingV2 = NO_PENDING
  // Bumped by the lock hook. Every step that awaits captures it first and discards its result
  // (writes no cache, no exclusions, no warm-start state) when a lock landed in between.
  let epoch = 0
  const offLock = onLock(() => {
    epoch += 1
    cache = null
    warmed = null
    hydrated = null
    primed = null
    primedIndex = null
    foreignSeen = null
    foreignKey = ''
    pending = NO_PENDING
    notices = []
    deviceBins.clear()
    monthIndex.clear()
  })
  const assertSameEpoch = (started: number): void => {
    if (started !== epoch) throw new VaultLockedError()
  }

  /**
   * `puller.primeFromCache()` once per unlock: the cached index serves the list at once while
   * the schedule's unlock pull revalidates (stale-while-revalidate). False — or a rejection —
   * means the caller falls back to `puller.refresh()` / retries next time.
   */
  const prime = (): Promise<boolean> => {
    if (primed === null) {
      const started = epoch
      const run = (async () => {
        const was = puller.index
        const ok = await puller.primeFromCache()
        // A lock mid-prime discards this epoch's result; the caller's assertSameEpoch rejects.
        if (started === epoch && was === null && ok) primedIndex = puller.index
        return ok
      })()
      primed = run
      run.catch(() => {
        if (primed === run) primed = null
      })
    }
    return primed
  }

  // The outbox mutex: a FIFO chain of never-rejecting promises, one holder at a time.
  let outboxTail: Promise<void> = Promise.resolve()
  const acquireOutboxLock = async (): Promise<() => void> => {
    const previous = outboxTail
    let release!: () => void
    outboxTail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    return release
  }

  // Intent retention (sync/retention.ts): one pass at a time, under the outbox mutex, so it never
  // interleaves with an outbox write. Its notices wait for the next pull.
  let notices: WebNotice[] = []
  const retain = async (): Promise<boolean> => {
    const started = epoch
    const release = await acquireOutboxLock()
    try {
      // The taxonomy `ready()` read before this pass (hydrate and pull both run it first).
      const synced = cache?.value
      const result = await runRetention({
        db,
        core,
        ring: getKeyRing(),
        nowSecs: () => nowSecs(),
        desktops: puller.desktops,
        vault,
        ...(synced === undefined ? {} : { v2: { desktops: puller.v2Desktops, taxonomy: synced } }),
      })
      if (started !== epoch) return false
      notices.push(...result.notices)
      return result.changed
    } catch (error) {
      // Fail safe: nothing was dropped that should not be; keep everything until next time.
      if (started === epoch) {
        const reason = error instanceof Error ? error.name : typeof error
        console.warn(`Intent retention skipped (${reason})`)
      }
      return false
    } finally {
      release()
    }
  }

  const taxonomy = async (): Promise<Taxonomy> => {
    const started = epoch
    const key = puller.index
    if (cache !== null && key !== null && cache.key === key) return cache.value
    const value = await readTaxonomy(db, core, getKeyRing())
    assertSameEpoch(started)
    applyJournals(value)
    cache = { key, value }
    return value
  }

  // A journal this browser created is known (not locked or invisible): its entries are served.
  const applyJournals = (value: Taxonomy): void => {
    vault.setExcludedJournalIds(value.excludedJournalIds, [
      ...value.knownJournalIds,
      ...pendingJournalIds(value, pending),
    ])
  }

  // Sets the pending overlay from these drafts. Re-applies the journal exclusions (O(entries in
  // RAM)) only when the pending journal set changed.
  const setPending = (drafts: readonly DraftRecord[]): void => {
    const next = pendingFromDrafts(drafts, core, getKeyRing())
    const journalsOf = (p: PendingV2): string =>
      cache === null ? '' : pendingJournalIds(cache.value, p).join('\n')
    const journalsChanged = journalsOf(next) !== journalsOf(pending)
    pending = next
    vault.setTrashedIds(next.trashedEntryIds)
    if (journalsChanged && cache !== null) applyJournals(cache.value)
  }

  const refreshPending = async (): Promise<void> => {
    const started = epoch
    const drafts = await db.drafts.list()
    assertSameEpoch(started)
    setPending(drafts)
  }

  // Lists every entry draft (pushed ones too: a pushed edit may not be imported yet; v2 drafts
  // carry no entry intent: they feed the pending overlay), which also recomputes the page's dirty
  // flag after a reload. Intents already in the overlay win: they were set by a write after these
  // drafts were read.
  const hydrate = async (): Promise<void> => {
    const started = epoch
    const all = await createDraftManager({ db }).listDrafts()
    assertSameEpoch(started)
    setPending(all)
    const drafts = all.filter((d) => draftKind(d) === 'entry')
    if (drafts.length === 0) return
    const ring = getKeyRing()
    const opened = drafts.flatMap((d) => openDraft(core, ring, d.entryId, d.sealed))
    const current = vault.getOutboxIntents()
    const set = new Set(current.map((i) => i.entry_id))
    vault.setOutboxIntents([...opened.filter((i) => !set.has(i.entry_id)), ...current])
    await retain()
    assertSameEpoch(started)
    await refreshPending()
  }

  // Re-opened only when a refresh produced a new set; the vault drops them on lock.
  const applyForeign = (): void => {
    const files = puller.foreignIntents
    if (files === foreignSeen) return
    if (files.length > 0 || foreignKey !== '') {
      const ring = getKeyRing()
      const opened = files.flatMap((f) => openForeignIntent(core, ring, f))
      vault.setForeignIntents(opened)
      foreignKey = opened
        .map((i) => `${i.web_device_id}/${i.entry_id}@${i.web_updated_at_secs}`)
        .sort()
        .join('\n')
    }
    foreignSeen = files
  }

  const ready = async (): Promise<Taxonomy> => {
    const started = epoch
    if (puller.index === null && !(await prime())) await puller.refresh()
    assertSameEpoch(started)
    const value = await taxonomy()
    assertSameEpoch(started)
    applyForeign()
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
    try {
      await warmed
    } catch (error) {
      // An offline reload serves the cached list: while the primed index still stands (no
      // refresh has replaced it) a transient warm failure is swallowed; the cleared memo
      // retries the warm start on the next ready().
      const stillPrimed = primedIndex !== null && puller.index === primedIndex
      if (!(stillPrimed && error instanceof PullTransientError)) throw error
    }
    assertSameEpoch(started)
    return value
  }

  const pull = async (): Promise<PullOutcome> => {
    const started = epoch
    // Prime first so a reload compares the refresh against the cached index, not nothing.
    await prime()
    assertSameEpoch(started)
    const before = puller.index
    const taxonomyBefore = cache === null ? null : JSON.stringify(cache.value)
    const foreignBefore = foreignKey
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
    const retained = await retain()
    assertSameEpoch(started)
    // A dropped v2 draft (reflected, acked or finally refused) leaves the overlay now.
    await refreshPending()
    const taxonomyChanged = taxonomyBefore !== null && taxonomyBefore !== JSON.stringify(value)
    const changed =
      retained ||
      (before !== null && foreignKey !== foreignBefore) ||
      (before !== null &&
        (result.stale.length > 0 || taxonomyChanged || indexDiffers(before, puller.index)))
    const raised = notices
    notices = []
    // Read after `ready()` and the loads: an entry opened there may have latched the guard.
    const formatReadOnly = getFormatGuardReason()
    return {
      stale: result.stale,
      changed,
      degraded: puller.getDegradedDevices(),
      ...(raised.length > 0 ? { notices: raised } : {}),
      ...(formatReadOnly === null ? {} : { formatReadOnly }),
      capabilities: {
        outboxV2: puller.v2Desktops.size > 0,
        monthIndex: puller.indexSource !== null,
      },
    }
  }

  return {
    vault,
    media: { db, reader, core, limit: puller.limit },
    deviceBins,
    monthIndex,
    db,
    core,
    ready,
    outboxV2Capable: () => puller.v2Desktops.size > 0,
    pendingV2: () => pending,
    refreshPendingV2: refreshPending,
    acquireOutboxLock,
    pull,
    dispose: () => {
      offLock()
      vault.dispose()
    },
  }
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
    // Log the error name only: a JSON.parse message can quote decrypted text.
    const reason = error instanceof Error ? error.name : typeof error
    console.warn(`Skipping draft ${entryId}: it could not be opened (${reason})`)
    return []
  }
}

/** A v2 intent file stem (`[jtpd]-<id>`): another browser's non-entry intent, never shown. */
const V2_INTENT_STEM = /^[jtpd]-/

/**
 * One foreign intent, or nothing when it cannot be opened or is not a v1 intent of `file.device`
 * for `file.entryId` (an unknown version is skipped, never an error). Logged by error name only.
 * A v2 intent (`[jtpd]-` name) is skipped silently, before any decode.
 */
function openForeignIntent(core: Core, ring: KeyRing, file: ForeignIntentFile): OutboxEntryV1[] {
  if (V2_INTENT_STEM.test(file.entryId)) return []
  try {
    const parsed = JSON.parse(core.openOutboxEntry(ring, file.bytes)) as unknown
    if (!isForeignIntent(parsed, file)) throw new Error('not an outbox intent for this file')
    return [parsed]
  } catch (error) {
    const reason = error instanceof Error ? error.name : typeof error
    console.warn(`Skipping an intent from another browser (${reason})`)
    return []
  }
}

const isFieldOrNull = (v: unknown): boolean => v === null || (isRecord(v) && 'value' in v)
const isFieldMap = (v: unknown): boolean =>
  isRecord(v) && Object.values(v).every((f) => isRecord(f) && 'value' in f)

/**
 * Identity and shape checks on an opened intent. Field TYPES are already guaranteed: the core
 * deserializes into its typed `OutboxEntryV1` and re-serializes it. This checks what the core
 * cannot: the intent belongs to the folder and file it was read from (no spoofed device id).
 */
function isForeignIntent(value: unknown, file: ForeignIntentFile): value is OutboxEntryV1 {
  if (!isRecord(value) || !isRecord(value.fields)) return false
  const f = value.fields
  return (
    value.schema_version === 1 &&
    value.entry_id === file.entryId &&
    value.web_device_id === file.device &&
    typeof value.created_on_web === 'boolean' &&
    typeof value.web_updated_at_secs === 'number' &&
    Array.isArray(value.yjs_full_state) &&
    Array.isArray(value.media) &&
    ['title', 'entry_date', 'emotion', 'is_favorite', 'journal_id'].every((k) =>
      isFieldOrNull(f[k]),
    ) &&
    isFieldMap(f.tags_add) &&
    isFieldMap(f.tags_remove)
  )
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
      next.isDeleted !== row.isDeleted ||
      next.trashedAt !== row.trashedAt
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
  const templateUpdatedAt = Object.create(null) as Record<string, number>
  for (const [id, r] of templates) if (!r.value.deleted) templateUpdatedAt[id] = r.updatedAt
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
    knownTagIds: [...tags.keys()],
    deletedTagNames: [...tags.values()].filter((r) => r.value.deleted).map((r) => r.value.tag.name),
    lockedJournalNames: winners
      .filter((j) => j.is_locked && !j.is_deleted && !j.is_invisible)
      .map((j) => j.name),
    templates: [...templates.values()]
      .filter((r) => !r.value.deleted)
      .map((r) => r.value.template)
      .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name)),
    deletedTemplateIds: [...templates.entries()]
      .filter(([, r]) => r.value.deleted)
      .map(([id]) => id),
    templateUpdatedAt,
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
