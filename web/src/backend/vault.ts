/**
 * In-RAM vault (Phase 10.2): decrypted entries live ONLY in JS maps owned by this object.
 *
 * - Plaintext is never written to IndexedDB (the `files` store keeps ciphertext only), nor to
 *   localStorage/sessionStorage, nor the console. Nothing here logs.
 * - `load(ids)` fetches the winning ciphertext through the puller, opens it with the CURRENT key
 *   ring (`keys.getKeyRing()`, `VaultLockedError` when locked) and stores it. When an id is already
 *   in RAM the opened copy is merged with it through the WASM `mergeMetadataLww`, so the desktop
 *   LWW rule (newer `updated_at`, tie: greater device id) decides, never the arrival order.
 * - `clear()` is registered as a lock hook: on lock the maps are replaced by empty ones (no
 *   reference to the old ones survives) and in-flight loads discard their result.
 *
 * VISIBILITY (README "Desktop safety contract" 6, desktop `locked_entry_exclusion_predicate` and
 * `invisible_entry_exclusion_predicate`, `src-tauri/src/db/queries.rs`): desktop lists locked
 * entries but gates their content behind the second lock, and hides invisible entries/journals
 * outside an unlocked invisible vault. The web has no second lock and no invisible vault, so a
 * locked entry, an invisible entry (or an entry in a locked/invisible journal) and a deleted entry
 * are EXCLUDED from every view (lists, favorites, search, counts, tag/journal counts). They are
 * reduced to a minimal STUB (ids, timestamps and flags only): title, text, preview, tags, media
 * and the Yjs body are dropped right after `openEntry`, so their plaintext is never retained.
 * `getEntry` / `getContentBytes` throw `EntryUnavailableError` for them. Entry flags come from the
 * entry metadata; journal flags live in the journal channel, so Phase 10.3 feeds them through
 * `setExcludedJournalIds`. Ids that are only in the index (not loaded yet) are listed by
 * `listIndex()` because their flags are unknown until opened; the page logic loads before it shows.
 */

import * as Y from 'yjs'
import type { Core } from '../core/core'
import { getKeyRing, onLock, type KeyRing } from './keys'
import type { IndexEntry } from './sync/entryIndex'
import type { OutboxEntryV1 } from './sync/outbox'
import { foldText, matchesQuery, parseQuery, type MatchOptions } from './textFold'

type VaultCore = Pick<Core, 'openEntry' | 'mergeMetadataLww'>

export interface VaultKeys {
  getKeyRing: () => KeyRing
  onLock: (cb: () => void) => () => void
}

/** The part of the puller the vault needs. */
export interface VaultSource {
  fetchEntries: (ids: readonly string[]) => Promise<Map<string, Uint8Array>>
  readonly index: ReadonlyMap<string, IndexEntry> | null
}

export interface VaultDeps {
  core: VaultCore
  /** Defaults to the key holder (`getKeyRing`, `onLock`). */
  keys?: VaultKeys
  /** Without a puller `load` throws; the loaded set can still be queried. */
  puller?: VaultSource
  /** Unix milliseconds for `loadedAt`. Default `Date.now`. */
  now?: () => number
}

/** Decrypted `EntryMetadata` (memlore-core `metadata.rs`); times are Unix SECONDS. */
export interface EntryMetadata {
  entry_id: string
  device_id: string
  updated_at: number
  entry_date: number
  created_at: number
  journal_id: string
  journal_name: string | null
  title: string | null
  preview_text: string | null
  content_text: string | null
  emotion: string | null
  is_favorite: boolean
  is_deleted: boolean
  is_locked: boolean
  is_invisible: boolean
  vault_id: string | null
  tag_ids: string[]
  /** Everything else (location, weather, media, ...), passed through untouched. */
  [key: string]: unknown
}

export interface VaultEntry {
  metadata: EntryMetadata
  /** Yjs full-state bytes (empty when the entry has no body yet). */
  content: Uint8Array
  contentText: string
  previewText: string
  /** Unix milliseconds when this copy was opened. */
  loadedAt: number
}

export type ExcludedReason = 'locked' | 'invisible' | 'deleted' | 'journal'
export type EntryStatus = 'visible' | ExcludedReason | 'not-loaded'

/** `Vault.getSynced`: synced state only, no overlay. */
export interface SyncedView {
  status: EntryStatus
  /** Full metadata when visible, the stub (ids, timestamps, flags) when excluded. */
  metadata: EntryMetadata | null
  /** Yjs full state when visible. */
  content: Uint8Array | null
}

/** Thrown by `getEntry` / `getContentBytes` for locked, invisible, deleted or not-loaded ids. */
export class EntryUnavailableError extends Error {
  readonly reason: Exclude<EntryStatus, 'visible'>
  constructor(id: string, reason: Exclude<EntryStatus, 'visible'>) {
    super(`entry ${id} is unavailable (${reason})`)
    this.name = 'EntryUnavailableError'
    this.reason = reason
  }
}

export interface LoadResult {
  /** Ids now visible in the vault (opened or already fresh). */
  loaded: string[]
  /** Ids that are locked, invisible, deleted or in an excluded journal (stubs only). */
  excluded: string[]
  /** Ids unknown to the index or whose file is confirmed missing. */
  missing: string[]
  /** Ids whose payload could not be opened (corrupt, wrong key, mismatched id). */
  failed: Array<{ id: string; message: string }>
}

export interface EntryFilter {
  journalId?: string
  tagId?: string
  favorite?: boolean
  emotion?: string
}

/** Everything kept for an excluded entry: no title, text, preview, tags, media or body. */
interface Stub {
  reason: ExcludedReason
  metadata: EntryMetadata
}

interface Held extends VaultEntry {
  /** Folded title and folded body, SEPARATE streams (FTS columns); same lifetime as the entry. */
  folded: string[]
}

const EMPTY = new Uint8Array(0)
const decoder = new TextDecoder()

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)

/** Validates the required fields and normalizes the optional ones (typeof, never truthiness). */
function parseMetadata(json: string, expectedId: string): EntryMetadata {
  const raw: unknown = JSON.parse(json)
  if (
    !isRecord(raw) ||
    typeof raw.entry_id !== 'string' ||
    typeof raw.device_id !== 'string' ||
    typeof raw.updated_at !== 'number' ||
    typeof raw.entry_date !== 'number' ||
    typeof raw.created_at !== 'number' ||
    typeof raw.journal_id !== 'string' ||
    typeof raw.is_deleted !== 'boolean'
  ) {
    throw new Error('entry metadata is malformed')
  }
  if (raw.entry_id !== expectedId) throw new Error('entry id does not match its file')
  return {
    ...raw,
    entry_id: raw.entry_id,
    device_id: raw.device_id,
    updated_at: raw.updated_at,
    entry_date: raw.entry_date,
    created_at: raw.created_at,
    journal_id: raw.journal_id,
    journal_name: str(raw.journal_name),
    title: str(raw.title),
    preview_text: str(raw.preview_text),
    content_text: str(raw.content_text),
    emotion: str(raw.emotion),
    is_favorite: raw.is_favorite === true,
    is_deleted: raw.is_deleted,
    is_locked: raw.is_locked === true,
    is_invisible: raw.is_invisible === true,
    vault_id: str(raw.vault_id),
    tag_ids: Array.isArray(raw.tag_ids)
      ? raw.tag_ids.filter((t): t is string => typeof t === 'string')
      : [],
  }
}

/** Minimal metadata that still deserializes as `EntryMetadata` (so it can be LWW-merged). */
type StubSource = Pick<
  EntryMetadata,
  | 'entry_id'
  | 'device_id'
  | 'updated_at'
  | 'journal_id'
  | 'is_deleted'
  | 'is_locked'
  | 'is_invisible'
  | 'vault_id'
>

function makeStub(source: StubSource, reason: ExcludedReason): Stub {
  const keepJournal = reason === 'deleted' || reason === 'journal'
  return {
    reason,
    metadata: {
      entry_id: source.entry_id,
      device_id: source.device_id,
      updated_at: source.updated_at,
      entry_date: 0,
      created_at: 0,
      journal_id: keepJournal ? source.journal_id : '',
      journal_name: null,
      title: null,
      preview_text: null,
      content_text: null,
      emotion: null,
      is_favorite: false,
      is_deleted: source.is_deleted,
      is_locked: source.is_locked,
      is_invisible: source.is_invisible,
      vault_id: source.vault_id,
      tag_ids: [],
    },
  }
}

const byEntryDateDesc = (a: Held, b: Held): number =>
  b.metadata.entry_date - a.metadata.entry_date ||
  b.metadata.created_at - a.metadata.created_at ||
  (a.metadata.entry_id < b.metadata.entry_id ? -1 : 1)

export class Vault {
  readonly #core: VaultCore
  readonly #keys: VaultKeys
  readonly #puller: VaultSource | undefined
  readonly #now: () => number
  readonly #unregister: () => void
  #entries = new Map<string, Held>()
  #stubs = new Map<string, Stub>()
  #excludedJournals = new Set<string>()
  /** Journal ids with a known record, or null before the first `setExcludedJournalIds`. */
  #knownJournals: Set<string> | null = null
  /** Pending outbox intents overlaid on top of synced state. */
  #outboxIntents = new Map<string, OutboxEntryV1>()
  /** Bumped by `clear()`; a load that started under an older epoch discards its result. */
  #epoch = 0

  constructor(deps: VaultDeps) {
    this.#core = deps.core
    this.#keys = deps.keys ?? { getKeyRing, onLock }
    this.#puller = deps.puller
    this.#now = deps.now ?? Date.now
    this.#unregister = this.#keys.onLock(() => this.clear())
  }

  /** Sets the active outbox intents to overlay on top of synced state. */
  setOutboxIntents(intents: OutboxEntryV1[]): void {
    this.#outboxIntents = new Map(intents.map((i) => [i.entry_id, i]))
  }

  getOutboxIntents(): OutboxEntryV1[] {
    return Array.from(this.#outboxIntents.values())
  }

  getOutboxIntent(entryId: string): OutboxEntryV1 | undefined {
    return this.#outboxIntents.get(entryId)
  }

  /**
   * The SYNCED state of an entry, never the outbox overlay (intent retention compares against it):
   * a loaded entry's metadata and Yjs bytes, an excluded entry's stub (flags kept), or
   * `not-loaded` with nulls.
   */
  getSynced(id: string): SyncedView {
    const held = this.#entries.get(id)
    if (held !== undefined) {
      return { status: 'visible', metadata: { ...held.metadata }, content: held.content }
    }
    const stub = this.#stubs.get(id)
    if (stub !== undefined)
      return { status: stub.reason, metadata: { ...stub.metadata }, content: null }
    return { status: 'not-loaded', metadata: null, content: null }
  }

  /** Visible (non-excluded) entries in RAM (including web-created ones). */
  get size(): number {
    return this.#getAllVisibleHeld().length
  }

  /** Empties every map and forgets the excluded-journal set. Idempotent; also the lock hook. */
  clear(): void {
    this.#epoch += 1
    this.#entries = new Map()
    this.#stubs = new Map()
    this.#excludedJournals = new Set()
    this.#knownJournals = null
    this.#outboxIntents = new Map()
  }

  /** Unregisters the lock hook and clears. */
  dispose(): void {
    this.#unregister()
    this.clear()
  }

  isLoaded(id: string): boolean {
    return this.status(id) === 'visible'
  }

  /**
   * Visibility with the overlay applied. A stub (locked, invisible, deleted, journal) always wins
   * over an outbox intent, and the overlaid journal is subject to journal exclusion.
   */
  status(id: string): EntryStatus {
    const intent = this.#outboxIntents.get(id)
    const held = this.#entries.get(id)
    if (held !== undefined) {
      const journalId = this.#overlaidJournalId(held.metadata, intent)
      return this.#journalExcluded(journalId) ? 'journal' : 'visible'
    }
    const stub = this.#stubs.get(id)
    if (stub !== undefined) return stub.reason
    if (intent?.created_on_web) {
      const journalId = intent.fields.journal_id?.value ?? ''
      return this.#journalExcluded(journalId) ? 'journal' : 'visible'
    }
    return 'not-loaded'
  }

  /** Throws `EntryUnavailableError` for locked, invisible, deleted and not-loaded entries. */
  getEntry(id: string): VaultEntry {
    return this.#held(id)
  }

  /** Yjs bytes of a visible entry. Same errors as `getEntry`. */
  getContentBytes(id: string): Uint8Array {
    return this.#held(id).content
  }

  #held(id: string): Held {
    const status = this.status(id)
    if (status !== 'visible') throw new EntryUnavailableError(id, status)
    const held = this.#entries.get(id)
    if (held !== undefined) return this.#applyOverlay(held)
    const intent = this.#outboxIntents.get(id)
    if (intent !== undefined) return this.#syntheticHeldFromIntent(intent)
    throw new EntryUnavailableError(id, 'not-loaded')
  }

  /** The journal id after the intent's journal move, if that move applies to this base. */
  #overlaidJournalId(base: EntryMetadata, intent: OutboxEntryV1 | undefined): string {
    const f = intent?.fields.journal_id
    if (f && (base.updated_at === f.base_updated_at || base.journal_id === f.base)) return f.value
    return base.journal_id
  }

  #applyOverlay(base: Held): Held {
    const intent = this.#outboxIntents.get(base.metadata.entry_id)
    if (!intent) return base
    return this.#computeOverlaidHeld(base, intent)
  }

  #computeOverlaidHeld(base: Held, intent: OutboxEntryV1): Held {
    const m: EntryMetadata = { ...base.metadata }
    const { fields } = intent

    let content = base.content
    if (intent.yjs_full_state && intent.yjs_full_state.length > 0) {
      try {
        const doc = new Y.Doc()
        if (base.content.length > 0) {
          Y.applyUpdate(doc, base.content)
        }
        Y.applyUpdate(doc, new Uint8Array(intent.yjs_full_state))
        content = Y.encodeStateAsUpdate(doc)
      } catch {
        // Corrupt intent yjs state: keep base content
      }
    }

    const contentText = intent.content_text ?? base.contentText
    const previewText = intent.preview_text ?? base.previewText
    if (intent.content_text !== null && intent.content_text !== undefined) {
      m.content_text = intent.content_text
    }
    if (intent.preview_text !== null && intent.preview_text !== undefined) {
      m.preview_text = intent.preview_text
    }

    if (fields.title) {
      const f = fields.title
      if (
        base.metadata.updated_at === f.base_updated_at ||
        (base.metadata.title ?? '') === (f.base ?? '')
      ) {
        m.title = f.value
      }
    }

    if (fields.entry_date) {
      const f = fields.entry_date
      const valTs = Number(f.value)
      const baseTs = Number(f.base)
      if (base.metadata.updated_at === f.base_updated_at || base.metadata.entry_date === baseTs) {
        m.entry_date = valTs
      }
    }

    if (fields.emotion) {
      const f = fields.emotion
      if (
        base.metadata.updated_at === f.base_updated_at ||
        (base.metadata.emotion ?? null) === (f.base ?? null)
      ) {
        m.emotion = f.value
      }
    }

    if (fields.is_favorite) {
      const f = fields.is_favorite
      if (
        base.metadata.updated_at === f.base_updated_at ||
        Boolean(base.metadata.is_favorite) === Boolean(f.base)
      ) {
        m.is_favorite = f.value
      }
    }

    m.journal_id = this.#overlaidJournalId(base.metadata, intent)

    if (fields.tags_add || fields.tags_remove) {
      const currentTags = new Set(base.metadata.tag_ids)
      for (const [tagId, f] of Object.entries(fields.tags_add || {})) {
        if (base.metadata.updated_at === f.base_updated_at || !currentTags.has(tagId)) {
          currentTags.add(tagId)
        }
      }
      for (const [tagId, f] of Object.entries(fields.tags_remove || {})) {
        if (base.metadata.updated_at === f.base_updated_at || currentTags.has(tagId)) {
          currentTags.delete(tagId)
        }
      }
      m.tag_ids = Array.from(currentTags)
    }

    if (intent.media && intent.media.length > 0) {
      const baseMedia = Array.isArray(base.metadata.media)
        ? [...(base.metadata.media as Array<Record<string, unknown>>)]
        : []
      const existingIds = new Set(baseMedia.map((x) => x.id ?? x.media_id))
      for (const mRef of intent.media) {
        if (!existingIds.has(mRef.media_id)) {
          baseMedia.push({
            id: mRef.media_id,
            file_name: mRef.file_name,
            file_type: mRef.file_type,
            file_size: mRef.size,
            has_thumb: mRef.has_thumb,
            created_at: intent.web_updated_at_secs,
            is_outbox: true,
          })
        }
      }
      m.media = baseMedia
    }

    return {
      metadata: m,
      content,
      contentText,
      previewText,
      loadedAt: base.loadedAt,
      folded: [foldText(m.title ?? ''), foldText(contentText)],
    }
  }

  #syntheticHeldFromIntent(intent: OutboxEntryV1): Held {
    const doc = new Y.Doc()
    if (intent.yjs_full_state && intent.yjs_full_state.length > 0) {
      try {
        Y.applyUpdate(doc, new Uint8Array(intent.yjs_full_state))
      } catch {
        // Corrupt intent yjs state: keep empty doc
      }
    }
    const content = Y.encodeStateAsUpdate(doc)
    const contentText = intent.content_text ?? ''
    const previewText = intent.preview_text ?? ''
    const tagIds = Object.keys(intent.fields.tags_add || {})
    const mediaList = (intent.media || []).map((mRef) => ({
      id: mRef.media_id,
      file_name: mRef.file_name,
      file_type: mRef.file_type,
      file_size: mRef.size,
      has_thumb: mRef.has_thumb,
      created_at: intent.web_updated_at_secs,
      is_outbox: true,
    }))
    const entryDate = intent.fields.entry_date
      ? Number(intent.fields.entry_date.value)
      : intent.web_updated_at_secs

    const metadata: EntryMetadata = {
      entry_id: intent.entry_id,
      device_id: intent.web_device_id,
      updated_at: intent.web_updated_at_secs,
      entry_date: entryDate,
      created_at: intent.web_updated_at_secs,
      journal_id: intent.fields.journal_id?.value ?? '',
      journal_name: null,
      title: intent.fields.title?.value ?? null,
      preview_text: previewText,
      content_text: contentText,
      emotion: intent.fields.emotion?.value ?? null,
      is_favorite: intent.fields.is_favorite?.value ?? false,
      is_deleted: false,
      is_locked: false,
      is_invisible: false,
      vault_id: null,
      tag_ids: tagIds,
      media: mediaList,
    }

    return {
      metadata,
      content,
      contentText,
      previewText,
      loadedAt: this.#now(),
      folded: [foldText(metadata.title ?? ''), foldText(contentText)],
    }
  }

  #getAllVisibleHeld(): Held[] {
    const list: Held[] = []
    const seenIds = new Set<string>()

    for (const [id, held] of this.#entries) {
      seenIds.add(id)
      const view = this.#applyOverlay(held)
      if (!this.#journalExcluded(view.metadata.journal_id)) list.push(view)
    }

    for (const [id, intent] of this.#outboxIntents) {
      if (!seenIds.has(id) && !this.#stubs.has(id) && intent.created_on_web) {
        const journalId = intent.fields.journal_id?.value ?? ''
        if (!this.#journalExcluded(journalId)) {
          list.push(this.#syntheticHeldFromIntent(intent))
        }
      }
    }

    return list
  }

  /**
   * Excludes every entry of these journals (locked or invisible journals, from the journal
   * channel). Loaded entries of them are reduced to stubs immediately. When `known` is given, an
   * entry whose (non-empty) journal id is not in it is excluded too: its journal record is missing
   * or deleted, so its lock state is unknown (fail closed). Journal stubs of a journal that is no
   * longer excluded are dropped, so those entries are listed and loaded again.
   */
  setExcludedJournalIds(ids: Iterable<string>, known?: Iterable<string>): void {
    this.#excludedJournals = new Set(ids)
    if (known !== undefined) this.#knownJournals = new Set(known)
    for (const [id, held] of [...this.#entries]) {
      if (this.#journalExcluded(held.metadata.journal_id)) {
        this.#entries.delete(id)
        this.#stubs.set(id, makeStub(held.metadata, 'journal'))
      }
    }
    for (const [id, stub] of [...this.#stubs]) {
      if (stub.reason === 'journal' && !this.#journalExcluded(stub.metadata.journal_id)) {
        this.#stubs.delete(id)
      }
    }
  }

  #journalExcluded(journalId: string): boolean {
    if (this.#excludedJournals.has(journalId)) return true
    return this.#knownJournals !== null && journalId !== '' && !this.#knownJournals.has(journalId)
  }

  // -------------------------------------------------------------------------------------------
  // Load
  // -------------------------------------------------------------------------------------------

  async load(ids: readonly string[]): Promise<LoadResult> {
    const puller = this.#puller
    if (puller === undefined) throw new Error('vault has no puller')
    this.#keys.getKeyRing() // VaultLockedError early, before any download
    const epoch = this.#epoch
    const result: LoadResult = { loaded: [], excluded: [], missing: [], failed: [] }
    const index = puller.index
    if (index === null) throw new Error('vault.load needs a prior pull refresh()')

    const toFetch: string[] = []
    for (const id of new Set(ids)) {
      const winner = index.get(id)
      if (winner === undefined) result.missing.push(id)
      else if (winner.isDeleted) this.#markDeleted(winner, result)
      else if (this.#isFresh(winner)) this.#report(id, result)
      else toFetch.push(id)
    }
    if (toFetch.length === 0) return result

    const payloads = await puller.fetchEntries(toFetch)
    if (epoch !== this.#epoch) return { loaded: [], excluded: [], missing: [], failed: [] }
    const ring = this.#keys.getKeyRing()
    for (const id of toFetch) {
      const bytes = payloads.get(id)
      if (bytes === undefined) {
        result.missing.push(id)
        continue
      }
      try {
        this.#ingest(id, this.#core.openEntry(ring, bytes))
        this.#report(id, result)
      } catch (error) {
        result.failed.push({ id, message: error instanceof Error ? error.message : 'open failed' })
      }
    }
    return result
  }

  #isStubbed(winner: IndexEntry): boolean {
    const stub = this.#stubs.get(winner.entryId)
    return stub !== undefined && stub.metadata.updated_at >= winner.updatedAt
  }

  /** Already in RAM at least as new as the index winner (journal stubs are never fresh). */
  #isFresh(winner: IndexEntry): boolean {
    const held = this.#entries.get(winner.entryId)
    if (held !== undefined) return held.metadata.updated_at >= winner.updatedAt
    const stub = this.#stubs.get(winner.entryId)
    return (
      stub !== undefined &&
      stub.reason !== 'journal' &&
      stub.metadata.updated_at >= winner.updatedAt
    )
  }

  #report(id: string, result: LoadResult): void {
    if (this.#entries.has(id)) result.loaded.push(id)
    else result.excluded.push(id)
  }

  #markDeleted(winner: IndexEntry, result: LoadResult): void {
    this.#entries.delete(winner.entryId)
    this.#stubs.set(
      winner.entryId,
      makeStub(
        {
          entry_id: winner.entryId,
          device_id: winner.authorDevice,
          updated_at: winner.updatedAt,
          journal_id: '',
          is_deleted: true,
          is_locked: false,
          is_invisible: false,
          vault_id: null,
        },
        'deleted',
      ),
    )
    result.excluded.push(winner.entryId)
  }

  #ingest(id: string, opened: { metadataJson: string; yjs: Uint8Array }): void {
    const incoming = parseMetadata(opened.metadataJson, id)
    const existing = this.#entries.get(id)?.metadata ?? this.#stubs.get(id)?.metadata
    if (existing !== undefined) {
      const merged = parseMetadata(
        this.#core.mergeMetadataLww(JSON.stringify(existing), opened.metadataJson),
        id,
      )
      const incomingWon =
        merged.device_id === incoming.device_id && merged.updated_at === incoming.updated_at
      if (!incomingWon) return // the copy already in RAM is newer: keep it
    }
    this.#entries.delete(id)
    this.#stubs.delete(id)
    const reason = this.#exclusionReason(incoming)
    if (reason !== null) {
      this.#stubs.set(id, makeStub(incoming, reason))
      return
    }
    const contentText = incoming.content_text ?? ''
    this.#entries.set(id, {
      metadata: incoming,
      content: opened.yjs.length === 0 ? EMPTY : opened.yjs,
      contentText,
      previewText: incoming.preview_text ?? '',
      loadedAt: this.#now(),
      folded: [foldText(incoming.title ?? ''), foldText(contentText)],
    })
  }

  #exclusionReason(metadata: EntryMetadata): ExcludedReason | null {
    if (metadata.is_deleted) return 'deleted'
    if (metadata.is_locked) return 'locked'
    if (metadata.is_invisible) return 'invisible'
    if (this.#journalExcluded(metadata.journal_id)) return 'journal'
    return null
  }

  // -------------------------------------------------------------------------------------------
  // Views (visible entries only)
  // -------------------------------------------------------------------------------------------

  /** Loaded entries sorted by entry date, newest first (as on desktop), then created, then id. */
  listLoaded(filter: EntryFilter = {}): VaultEntry[] {
    return this.#getAllVisibleHeld()
      .filter((h) => matchesFilter(h, filter))
      .sort(byEntryDateDesc)
  }

  listFavorites(): VaultEntry[] {
    return this.listLoaded({ favorite: true })
  }

  count(filter: EntryFilter = {}): number {
    let n = 0
    for (const held of this.#getAllVisibleHeld()) if (matchesFilter(held, filter)) n += 1
    return n
  }

  tagCounts(): Map<string, number> {
    const counts = new Map<string, number>()
    for (const { metadata } of this.#getAllVisibleHeld()) {
      for (const tag of new Set(metadata.tag_ids)) counts.set(tag, (counts.get(tag) ?? 0) + 1)
    }
    return counts
  }

  journalCounts(): Map<string, number> {
    const counts = new Map<string, number>()
    for (const { metadata } of this.#getAllVisibleHeld()) {
      counts.set(metadata.journal_id, (counts.get(metadata.journal_id) ?? 0) + 1)
    }
    return counts
  }

  /**
   * Search over the LOADED visible set with desktop semantics (see textFold.ts): all words must
   * match whole tokens of title + body, accent- and case-insensitive; `prefix` makes the last
   * token a prefix. Newest entry date first; no limit (the command layer decides).
   */
  search(query: string, options: MatchOptions & { filter?: EntryFilter } = {}): VaultEntry[] {
    const parsed = parseQuery(query)
    if (parsed.length === 0) return []
    const filter = options.filter ?? {}
    return this.#getAllVisibleHeld()
      .filter((h) => matchesFilter(h, filter) && matchesQuery(h.folded, parsed, options))
      .sort(byEntryDateDesc)
  }

  /**
   * The index (all known entries, loaded or not), `updated_at` descending (the fetch order of the
   * lazy pages), without tombstones and without ids already known to be excluded. A stub older
   * than the index winner is listed again: its entry changed and may be visible now.
   */
  listIndex(): IndexEntry[] {
    const index = this.#puller?.index
    if (index === null || index === undefined) return []
    return [...index.values()]
      .filter((e) => !e.isDeleted && !this.#isStubbed(e))
      .sort((a, b) => b.updatedAt - a.updatedAt || (a.entryId < b.entryId ? -1 : 1))
  }

  /**
   * TESTS ONLY. JSON of everything the vault holds (visible entries, stubs, bytes as text) so a
   * test can assert that a plaintext marker is, or is not, retained in RAM.
   */
  __debugDump(): string {
    return JSON.stringify({
      entries: [...this.#entries.values()].map((h) => ({
        ...h,
        content: decoder.decode(h.content),
      })),
      stubs: [...this.#stubs.values()],
    })
  }
}

function matchesFilter(held: Held, filter: EntryFilter): boolean {
  const m = held.metadata
  return (
    (filter.journalId === undefined || m.journal_id === filter.journalId) &&
    (filter.tagId === undefined || m.tag_ids.includes(filter.tagId)) &&
    (filter.favorite === undefined || m.is_favorite === filter.favorite) &&
    (filter.emotion === undefined || m.emotion === filter.emotion)
  )
}

export function createVault(deps: VaultDeps): Vault {
  return new Vault(deps)
}
