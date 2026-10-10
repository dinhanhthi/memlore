/** Test helpers for the read commands: an in-memory vault double and a session injector. */

import * as Y from 'yjs'
import { foldText, matchesQuery, parseQuery } from '../textFold'
import {
  EntryUnavailableError,
  type EntryMetadata,
  type LoadResult,
  type SyncedView,
  type TrashView,
  type VaultEntry,
} from '../vault'
import type { IndexEntry } from '../sync/entryIndex'
import type { OutboxEntryV1 } from '../sync/outbox'
import type { DraftRecord, WebDb } from '../storage/idb'
import type { Core } from '../../core/core'
import type { KeyRing } from '../keys'
import { NO_PENDING, pendingFromDrafts, type PendingV2 } from './pendingTaxonomy'
import { configureReadEnv, type PullOutcome, type Taxonomy, type VaultApi } from './readSession'

export interface FakeSpec {
  id: string
  updatedAt: number
  entryDate?: number
  journal?: string
  title?: string
  text?: string
  favorite?: boolean
  emotion?: string | null
  tags?: string[]
  media?: number
  /** Ids of `media` (`m0`, `m1`, ...) the payload tombstones in `deleted_media`. */
  deletedMedia?: string[]
  /** Metadata flags revealed only when the payload is loaded. */
  locked?: boolean
  invisible?: boolean
  /** The index row is a tombstone. */
  tombstone?: boolean
  /** The index winner is in the desktop Trash since this time (unix seconds). */
  trashedAt?: number
  /** `vault.load` reports a failure for it. */
  fails?: boolean
  yjs?: number[]
  /** Location of the payload (absent: none). */
  latitude?: number
  longitude?: number
  locationLabel?: string
}

export const EMPTY_TAXONOMY: Taxonomy = {
  journals: [],
  autoTagIds: {},
  excludedJournalIds: [],
  knownJournalIds: [],
  tags: [],
  knownTagIds: [],
  deletedTagNames: [],
  lockedJournalNames: [],
  templates: [],
  deletedTemplateIds: [],
  templateUpdatedAt: {},
}

/** In-memory `VaultApi`: `load` "downloads" a spec and records every call. */
export class FakeVault implements VaultApi {
  readonly loadCalls: string[][] = []
  readonly #specs = new Map<string, FakeSpec>()
  readonly #entries = new Map<string, VaultEntry>()
  readonly #stubs = new Map<string, string>()
  #outboxIntents = new Map<string, OutboxEntryV1>()
  #trashed = new Set<string>()
  /** Desktop-Trash copies opened by `loadTrashed`. */
  readonly #trashedCopies = new Map<string, VaultEntry>()
  readonly loadTrashedCalls: string[][] = []
  /** Journals whose entries the Trash view excludes (the real vault's `setExcludedJournalIds`). */
  readonly excludedJournals = new Set<string>()

  constructor(specs: FakeSpec[]) {
    for (const spec of specs) this.#specs.set(spec.id, spec)
  }

  get loadedIds(): string[] {
    return [...this.#entries.keys()]
  }

  readonly setOutboxIntents = (intents: OutboxEntryV1[]): void => {
    this.#outboxIntents = new Map(intents.map((i) => [i.entry_id, i]))
  }

  readonly getOutboxIntents = (): OutboxEntryV1[] => {
    return Array.from(this.#outboxIntents.values())
  }

  readonly getOutboxIntent = (entryId: string): OutboxEntryV1 | undefined => {
    return this.#outboxIntents.get(entryId)
  }

  /** Pending web trashes: served as deleted, as the real vault does. */
  readonly setTrashedIds = (ids: Iterable<string>): void => {
    this.#trashed = new Set(ids)
  }

  readonly load = async (ids: readonly string[]): Promise<LoadResult> => {
    this.loadCalls.push([...ids])
    const result: LoadResult = { loaded: [], excluded: [], missing: [], failed: [], stale: [] }
    for (const id of new Set(ids)) {
      const spec = this.#specs.get(id)
      if (spec === undefined) result.missing.push(id)
      else if (spec.tombstone === true || spec.trashedAt !== undefined) {
        this.#stubs.set(id, 'deleted')
        result.excluded.push(id)
      } else if (spec.fails === true) result.failed.push({ id, message: 'boom' })
      else if (this.#entries.has(id)) result.loaded.push(id)
      else if (spec.locked === true || spec.invisible === true) {
        this.#stubs.set(id, spec.locked === true ? 'locked' : 'invisible')
        result.excluded.push(id)
      } else {
        this.#entries.set(id, toVaultEntry(spec))
        result.loaded.push(id)
      }
    }
    return result
  }

  readonly isLoaded = (id: string): boolean => this.status(id) === 'visible'

  readonly status: VaultApi['status'] = (id) => {
    if (this.#trashed.has(id)) return 'deleted'
    if (this.#outboxIntents.get(id)?.created_on_web) return 'visible'
    return this.#entries.has(id) ? 'visible' : ((this.#stubs.get(id) ?? 'not-loaded') as 'locked')
  }

  readonly getEntry = (id: string): VaultEntry => {
    if (this.#trashed.has(id)) throw new EntryUnavailableError(id, 'deleted')
    return this.#overlaid(id)
  }

  /** The entry with its outbox intent overlaid, trashed or not. */
  #overlaid(id: string): VaultEntry {
    const intent = this.#outboxIntents.get(id)
    if (intent && intent.created_on_web) {
      const metadata: EntryMetadata = {
        entry_id: intent.entry_id,
        device_id: intent.web_device_id,
        updated_at: intent.web_updated_at_secs,
        entry_date: intent.fields.entry_date
          ? Number(intent.fields.entry_date.value)
          : intent.web_updated_at_secs,
        entry_date_user_edited:
          intent.fields.entry_date !== null && intent.fields.entry_date !== undefined,
        created_at: intent.web_updated_at_secs,
        journal_id: intent.fields.journal_id?.value ?? 'j1',
        journal_name: null,
        title: intent.fields.title?.value ?? null,
        preview_text: intent.preview_text ?? '',
        content_text: intent.content_text ?? '',
        emotion: intent.fields.emotion?.value ?? null,
        is_favorite: intent.fields.is_favorite?.value ?? false,
        is_deleted: false,
        is_locked: false,
        is_invisible: false,
        vault_id: null,
        tag_ids: Object.keys(intent.fields.tags_add ?? {}),
        media: (intent.media ?? []).map((m) => ({ id: m.media_id })),
      }
      return {
        metadata,
        content: new Uint8Array(intent.yjs_full_state ?? []),
        contentText: intent.content_text ?? '',
        previewText: intent.preview_text ?? '',
        loadedAt: 0,
      }
    }
    const entry = this.#entries.get(id)
    if (entry !== undefined) {
      if (intent) {
        const m = { ...entry.metadata }
        if (intent.fields.title) m.title = intent.fields.title.value
        if (intent.fields.entry_date) {
          m.entry_date = Number(intent.fields.entry_date.value)
          m.entry_date_user_edited = true
        }
        if (intent.fields.emotion) m.emotion = intent.fields.emotion.value
        if (intent.fields.is_favorite) m.is_favorite = intent.fields.is_favorite.value
        if (intent.fields.journal_id) m.journal_id = intent.fields.journal_id.value
        const tags = new Set(m.tag_ids)
        for (const t of Object.keys(intent.fields.tags_add ?? {})) tags.add(t)
        for (const t of Object.keys(intent.fields.tags_remove ?? {})) tags.delete(t)
        m.tag_ids = Array.from(tags)
        return {
          ...entry,
          metadata: m,
          content:
            intent.yjs_full_state.length > 0
              ? new Uint8Array(intent.yjs_full_state)
              : entry.content,
          contentText: intent.content_text ?? entry.contentText,
          previewText: intent.preview_text ?? entry.previewText,
        }
      }
      return entry
    }
    const reason = (this.#stubs.get(id) ?? 'not-loaded') as 'locked'
    throw new EntryUnavailableError(id, reason)
  }

  readonly getContentBytes = (id: string): Uint8Array => this.getEntry(id).content

  /** The fake holds no foreign intents, so the write view is the overlaid entry. */
  readonly getWriteView = (id: string): VaultEntry => this.getEntry(id)

  readonly foreignIntents: OutboxEntryV1[] = []
  readonly setForeignIntents = (intents: OutboxEntryV1[]): void => {
    this.foreignIntents.splice(0, this.foreignIntents.length, ...intents)
  }

  /** Synced state only (no overlay): a loaded spec, or a stub carrying the spec's flags. */
  readonly getSynced = (id: string): SyncedView => {
    const entry = this.#entries.get(id)
    if (entry !== undefined) {
      return { status: 'visible', metadata: { ...entry.metadata }, content: entry.content }
    }
    const reason = this.#stubs.get(id)
    const spec = this.#specs.get(id)
    if (reason === undefined || spec === undefined) {
      return { status: 'not-loaded', metadata: null, content: null }
    }
    const metadata: EntryMetadata = {
      ...toVaultEntry(spec).metadata,
      is_deleted: spec.tombstone === true,
      is_locked: spec.locked === true,
      is_invisible: spec.invisible === true,
    }
    return { status: reason as SyncedView['status'], metadata, content: null }
  }

  readonly listLoaded: VaultApi['listLoaded'] = (filter = {}) =>
    [...this.#entries.values()]
      .filter((e) => !this.#trashed.has(e.metadata.entry_id))
      .filter((e) => filter.journalId === undefined || e.metadata.journal_id === filter.journalId)
      .sort((a, b) => b.metadata.entry_date - a.metadata.entry_date)

  readonly listIndex: VaultApi['listIndex'] = () =>
    [...this.#specs.values()]
      .filter(
        (s) =>
          s.tombstone !== true &&
          s.trashedAt === undefined &&
          !this.#stubs.has(s.id) &&
          !this.#trashed.has(s.id),
      )
      .sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1))
      .map((s) => ({
        entryId: s.id,
        authorDevice: 'dev',
        updatedAt: s.updatedAt,
        isDeleted: false,
      }))

  readonly search: VaultApi['search'] = (query, options = {}) => {
    const parsed = parseQuery(query)
    return this.listLoaded().filter((e) =>
      matchesQuery([foldText(e.metadata.title ?? ''), foldText(e.contentText)], parsed, options),
    )
  }

  readonly listTrashedIndex = (): IndexEntry[] =>
    [...this.#specs.values()].flatMap((s) =>
      s.trashedAt !== undefined && s.tombstone !== true
        ? [
            {
              entryId: s.id,
              authorDevice: 'dev',
              updatedAt: s.updatedAt,
              isDeleted: false,
              trashedAt: s.trashedAt,
            },
          ]
        : [],
    )

  /** "Downloads" the trashed specs; locked, invisible and journal-excluded ones are not kept. */
  readonly loadTrashed = async (ids: readonly string[]): Promise<void> => {
    this.loadTrashedCalls.push([...ids])
    for (const id of ids) {
      const spec = this.#specs.get(id)
      if (spec?.trashedAt === undefined || spec.tombstone === true) continue
      if (spec.locked === true || spec.invisible === true) continue
      const entry = toVaultEntry(spec)
      if (this.excludedJournals.has(entry.metadata.journal_id)) continue
      this.#trashedCopies.set(id, entry)
    }
  }

  /** RAM only: a desktop-Trash copy, else a pending web trash (synced copy or web create). */
  readonly trashView = (id: string): TrashView | null => {
    const copy = this.#trashedCopies.get(id)
    const trashedAt = this.#specs.get(id)?.trashedAt
    if (copy !== undefined && trashedAt !== undefined) {
      return { held: copy, trashedAt, pending: false }
    }
    if (!this.#trashed.has(id) || this.#stubs.has(id)) return null
    if (!this.#entries.has(id) && this.#outboxIntents.get(id)?.created_on_web !== true) return null
    const held = this.#overlaid(id)
    if (this.excludedJournals.has(held.metadata.journal_id)) return null
    return { held, trashedAt: null, pending: true }
  }

  readonly tagCounts = (): Map<string, number> => {
    const counts = new Map<string, number>()
    for (const { metadata } of this.#entries.values()) {
      for (const tag of metadata.tag_ids) counts.set(tag, (counts.get(tag) ?? 0) + 1)
    }
    return counts
  }
}

function toVaultEntry(spec: FakeSpec): VaultEntry {
  const metadata: EntryMetadata = {
    entry_id: spec.id,
    device_id: 'dev',
    updated_at: spec.updatedAt,
    entry_date: spec.entryDate ?? spec.updatedAt,
    created_at: spec.entryDate ?? spec.updatedAt,
    journal_id: spec.journal ?? 'j1',
    journal_name: null,
    title: spec.title ?? `Title ${spec.id}`,
    preview_text: 'preview',
    content_text: spec.text ?? `body ${spec.id}`,
    emotion: spec.emotion ?? null,
    is_favorite: spec.favorite === true,
    is_deleted: false,
    is_locked: false,
    is_invisible: false,
    vault_id: null,
    tag_ids: spec.tags ?? [],
    media: Array.from({ length: spec.media ?? 0 }, (_, i) => ({ id: `m${i}` })),
    ...(spec.latitude === undefined ? {} : { latitude: spec.latitude }),
    ...(spec.longitude === undefined ? {} : { longitude: spec.longitude }),
    ...(spec.locationLabel === undefined ? {} : { location_label: spec.locationLabel }),
    ...(spec.deletedMedia === undefined
      ? {}
      : { deleted_media: spec.deletedMedia.map((id) => ({ id, deleted_at: 1 })) }),
  }
  return {
    metadata,
    content: new Uint8Array(spec.yjs ?? Array.from(Y.encodeStateAsUpdate(new Y.Doc()))),
    contentText: metadata.content_text ?? '',
    previewText: 'preview',
    loadedAt: 0,
  }
}

export interface Harness {
  vault: FakeVault
  emitted: string[]
  setUnlocked: (value: boolean) => void
  db: WebDb
  core: Core
}

/** Injects a fake session. Call `configureReadEnv({})` in `afterEach`. */
export function installFakeSession(
  specs: FakeSpec[],
  options: {
    taxonomy?: Taxonomy
    pageSize?: number
    now?: number
    pull?: () => Promise<PullOutcome>
    /** Some desktop takes outbox v2 intents (Phase 22 handlers). Default false. */
    outboxV2?: boolean
  } = {},
): Harness {
  const vault = new FakeVault(specs)
  const emitted: string[] = []
  let unlocked = true

  let seq = 0
  const draftsMap = new Map<string, DraftRecord>()
  const blobsMap = new Map<string, Uint8Array>()
  const db = {
    device: {
      get: async () => ({ deviceId: 'test-device-id', nextChangeSeq: 1 }),
      allocateChangeSeq: async () => ++seq,
    },
    drafts: {
      put: async (rec: DraftRecord) => {
        draftsMap.set(rec.entryId, { ...rec })
      },
      get: async (id: string) => {
        const rec = draftsMap.get(id)
        return rec ? { ...rec } : undefined
      },
      delete: async (id: string) => {
        draftsMap.delete(id)
      },
      list: async () => Array.from(draftsMap.values(), (rec) => ({ ...rec })),
    },
    blobs: {
      put: async (b: { path: string; bytes: Uint8Array }) => {
        blobsMap.set(b.path, b.bytes)
      },
      get: async (p: string) => {
        const bytes = blobsMap.get(p)
        return bytes ? { path: p, bytes, size: bytes.length, lastAccess: Date.now() } : undefined
      },
      delete: async (p: string) => {
        blobsMap.delete(p)
      },
    },
  } as unknown as WebDb

  const core = {
    sealOutboxEntry: (_ring: unknown, json: string) => new TextEncoder().encode(json),
    sealOutboxMedia: (_ring: unknown, bytes: Uint8Array) => bytes,
    sealOutboxThumb: (_ring: unknown, bytes: Uint8Array) => bytes,
    // v2 "sealing" is the JSON text behind a `2` byte; v1 bytes start with `{`.
    sealOutboxIntentV2: (_ring: unknown, json: string) =>
      new Uint8Array([2, ...new TextEncoder().encode(json)]),
    openOutboxIntent: (_ring: unknown, bytes: Uint8Array) => {
      const version = bytes[0] === 2 ? 2 : 1
      const json = new TextDecoder().decode(version === 2 ? bytes.subarray(1) : bytes)
      return { version, json, free: () => undefined }
    },
  } as unknown as Core

  let pending: PendingV2 = NO_PENDING

  // A real FIFO mutex, as the session's, so concurrent writes serialize in tests.
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

  configureReadEnv({
    isUnlocked: () => unlocked,
    session: async () => ({
      vault,
      ready: async () => options.taxonomy ?? EMPTY_TAXONOMY,
      outboxV2Capable: () => options.outboxV2 ?? false,
      pendingV2: () => pending,
      refreshPendingV2: async () => {
        pending = pendingFromDrafts(await db.drafts.list(), core, {} as KeyRing)
        vault.setTrashedIds(pending.trashedEntryIds)
      },
      acquireOutboxLock,
      pull: options.pull ?? (async () => ({ stale: [], changed: false })),
      db,
      core,
    }),
    emit: (event) => {
      emitted.push(event)
    },
    now: () => options.now ?? Date.UTC(2026, 9, 3, 12),
    pageSize: options.pageSize ?? 20,
  })
  return {
    vault,
    emitted,
    setUnlocked: (value) => {
      unlocked = value
    },
    db,
    core,
  }
}
