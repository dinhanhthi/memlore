/**
 * Entry read commands (Phase 10.3); writes Phase 16 (outbox v1), `soft_delete_entry` Phase 22.2
 * (outbox v2 trash).
 *
 * WIRE SHAPE: the desktop pager is `PagedResult<T> = { items, total }` with 1-based pages of
 * `PAGE_SIZE` (src/types/pagination.ts, `usePagedQuery`), not `{entries, hasMore}`. The same shape
 * is returned here.
 *
 * ORDERING DECISION (lazy loading): the manifests carry `updated_at` but not the entry date, so
 * entries are fetched in last-updated order (the puller index, `vault.listIndex()`), and the LOADED
 * set is displayed in the requested sort (entry date desc by default, as on desktop). An entry with
 * an old `updated_at` and a recent entry date shows up later than on desktop, once its page loads.
 * There is no background prefetch. Page N loads entries until N * pageSize visible matches are
 * loaded or the index is exhausted (bounded by `MAX_LOAD_ROUNDS`), tolerating ids that turn out
 * locked, invisible or deleted.
 *
 * `total` is `visible matches loaded + index ids not loaded yet`. For the all-entries list it is
 * close to exact (it shrinks as excluded entries are discovered); for the journal / favorites /
 * tag lists it is an UPPER BOUND, because an unloaded entry's journal, tag and favorite flag are
 * unknown. A page past the end is an honest empty page, as on desktop.
 *
 * VISIBILITY: only entries the vault serves (never locked, invisible, deleted or in a locked or
 * invisible journal). `lockedView`, `activeVaultId` and `lockFilter` (second-locked / invisible-only
 * views list exactly the excluded entries) are therefore ignored or answered empty.
 *
 * Calendar-style reads (`list_entry_dates`, `list_entries_for_date_range`, `get_emotion_by_date`,
 * `count_entries_in_journal`) are answered from the entries loaded so far: they never trigger a
 * download. `list_on_this_day` is answered from the month index (`indexViews.ts`).
 */

import * as Y from 'yjs'
import type { Entry, EmotionKey } from '../../../../src/types/entry'
import type { EntrySort, EntryTimeRange, PagedResult } from '../../../../src/types/pagination'
import { EntryUnavailableError, type VaultEntry } from '../vault'
import type { Handler } from '../router'
import { nowSecs as correctedNowSecs } from '../clock'
import { getCachedWriteFlag } from '../config'
import { sealOutboxIntentV2 } from '../../core/core'
import { createDraftManager } from '../drafts'
import { isUuid } from '../drive/paths'
import { getKeyRing } from '../keys'
import { WebUnsupportedError } from '../unsupported'
import {
  DEFAULT_MEDIA_MAX_PHOTO_UPLOAD_BYTES,
  DEFAULT_MEDIA_MAX_VIDEO_UPLOAD_BYTES,
  formatImageTooLargeError,
  formatVideoTooLargeError,
  generateImageThumbnail,
  generateVideoThumbnail,
  isAllowedMimeType,
} from '../media/thumbnail'
import {
  buildOutboxIntent,
  type FieldChange,
  type OutboxEntryV1,
  type OutboxFields,
  type OutboxMediaRef,
} from '../sync/outbox'
import { acquireOutboxLock, openForRead, openForWrite, readEnv, type VaultApi } from './readSession'
import { WEB_MEDIA_PATH_PREFIX } from './media'

export const MSG_UNAVAILABLE = 'This entry is not available on the web (locked, hidden or deleted).'

/** Upper bound of load rounds for one list call (each round loads at most one page of ids). */
export const MAX_LOAD_ROUNDS = 50

/** Thrown by `loadVisible` for locked, invisible and deleted entries. */
export class EntryNotAvailableError extends Error {
  constructor() {
    super(MSG_UNAVAILABLE)
    this.name = 'EntryNotAvailableError'
  }
}

// ---------------------------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------------------------

const EMOTIONS: readonly string[] = ['bad', 'neutral', 'good']

const numOrNull = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null)

/**
 * Desktop `Entry` from a visible vault entry. Fields the wire does not carry: `from_chat` is a
 * local-only flag (false); the lock / invisible / deleted flags are false for everything served.
 */
export function toEntry(entry: VaultEntry): Entry {
  const m = entry.metadata
  return {
    id: m.entry_id,
    journal_id: m.journal_id,
    title: m.title,
    preview_text: m.preview_text,
    content_text: m.content_text,
    entry_date: m.entry_date,
    created_at: m.created_at,
    updated_at: m.updated_at,
    latitude: numOrNull(m.latitude),
    longitude: numOrNull(m.longitude),
    location_label: strOrNull(m.location_label),
    location_address: strOrNull(m.location_address),
    weather_summary: strOrNull(m.weather_summary),
    weather_icon: strOrNull(m.weather_icon),
    emotion: m.emotion !== null && EMOTIONS.includes(m.emotion) ? (m.emotion as EmotionKey) : null,
    is_favorite: m.is_favorite,
    is_deleted: false,
    is_locked: false,
    is_invisible: false,
    vault_id: null,
    cover_media_id: strOrNull(m.cover_media_id),
    content_language: strOrNull(m.content_language),
    entry_date_user_edited: m.entry_date_user_edited === true,
    media_count: Array.isArray(m.media) ? m.media.length : 0,
    from_chat: false,
  }
}

const byDateDesc = (a: VaultEntry, b: VaultEntry): number =>
  b.metadata.entry_date - a.metadata.entry_date ||
  (a.metadata.entry_id < b.metadata.entry_id ? 1 : -1)

const SORTS: Record<EntrySort, (a: VaultEntry, b: VaultEntry) => number> = {
  newest: byDateDesc,
  oldest: (a, b) =>
    a.metadata.entry_date - b.metadata.entry_date ||
    (a.metadata.entry_id < b.metadata.entry_id ? -1 : 1),
  recentlyEdited: (a, b) =>
    b.metadata.updated_at - a.metadata.updated_at ||
    (a.metadata.entry_id < b.metadata.entry_id ? 1 : -1),
}

// ---------------------------------------------------------------------------------------------
// Time ranges (desktop `time_range_bounds`: local calendar, `firstDayOfWeek` 0 = Sunday)
// ---------------------------------------------------------------------------------------------

type Bounds = readonly [number, number] | null

const seconds = (d: Date): number => Math.floor(d.getTime() / 1000)

export function timeRangeBounds(
  range: EntryTimeRange,
  firstDayOfWeek: number,
  nowMs: number,
): Bounds {
  const now = new Date(nowMs)
  const y = now.getFullYear()
  const m = now.getMonth()
  const d = now.getDate()
  switch (range) {
    case 'today':
      return [seconds(new Date(y, m, d)), seconds(new Date(y, m, d + 1))]
    case 'thisWeek': {
      const back = (now.getDay() + 7 - firstDayOfWeek) % 7
      return [seconds(new Date(y, m, d - back)), seconds(new Date(y, m, d - back + 7))]
    }
    case 'thisMonth':
      return [seconds(new Date(y, m, 1)), seconds(new Date(y, m + 1, 1))]
    case 'thisYear':
      return [seconds(new Date(y, 0, 1)), seconds(new Date(y + 1, 0, 1))]
    default:
      return null
  }
}

// ---------------------------------------------------------------------------------------------
// Argument parsing (the UI sends camelCase; stay tolerant of missing optional values)
// ---------------------------------------------------------------------------------------------

const asString = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const asNumber = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null

interface PageArgs {
  sort: EntrySort
  range: EntryTimeRange
  custom: Bounds
  firstDayOfWeek: number
  page: number
  lockFilter: string
}

function parsePageArgs(args: Record<string, unknown>): PageArgs {
  const sort = asString(args.sort)
  const range = asString(args.range)
  const from = asNumber(args.fromTs)
  const to = asNumber(args.toTs)
  const page = asNumber(args.page)
  return {
    sort: sort !== null && Object.hasOwn(SORTS, sort) ? (sort as EntrySort) : 'newest',
    range: (range ?? 'all') as EntryTimeRange,
    custom: from !== null && to !== null ? [from, to] : null,
    firstDayOfWeek: asNumber(args.firstDayOfWeek) ?? 0,
    page: page !== null && page >= 1 ? Math.floor(page) : 1,
    lockFilter: asString(args.lockFilter) ?? 'all',
  }
}

// ---------------------------------------------------------------------------------------------
// Paging
// ---------------------------------------------------------------------------------------------

const unloadedIds = (vault: VaultApi, tried: ReadonlySet<string>): string[] =>
  vault
    .listIndex()
    .filter((i) => !vault.isLoaded(i.entryId) && !tried.has(i.entryId))
    .map((i) => i.entryId)

async function pagedEntries(
  args: Record<string, unknown>,
  keep: (entry: VaultEntry) => boolean,
): Promise<PagedResult<Entry>> {
  const { vault } = await openForRead()
  const env = readEnv()
  const a = parsePageArgs(args)
  // The "locked" / "invisible" views list exactly the entries the web never serves.
  if (a.lockFilter !== 'all') return { items: [], total: 0 }
  const bounds = a.custom ?? timeRangeBounds(a.range, a.firstDayOfWeek, env.now())
  const matches = (): VaultEntry[] =>
    vault
      .listLoaded()
      .filter(
        (e) =>
          keep(e) &&
          (bounds === null ||
            (e.metadata.entry_date >= bounds[0] && e.metadata.entry_date < bounds[1])),
      )

  const needed = a.page * env.pageSize
  const tried = new Set<string>()
  let found = matches()
  for (let round = 0; found.length < needed && round < MAX_LOAD_ROUNDS; round += 1) {
    const batch = unloadedIds(vault, tried).slice(0, Math.min(env.pageSize, needed - found.length))
    if (batch.length === 0) break
    for (const id of batch) tried.add(id)
    await vault.load(batch)
    found = matches()
  }
  const start = (a.page - 1) * env.pageSize
  return {
    items: found
      .sort(SORTS[a.sort])
      .slice(start, start + env.pageSize)
      .map(toEntry),
    total: found.length + unloadedIds(vault, new Set()).length,
  }
}

const listEntriesPaged: Handler = (args) =>
  pagedEntries(args, (e) => e.metadata.journal_id === asString(args.journalId))

const listAllEntriesPaged: Handler = (args) => pagedEntries(args, () => true)

const listFavoriteEntriesPaged: Handler = (args) => {
  const journalId = asString(args.journalId)
  return pagedEntries(
    args,
    (e) => e.metadata.is_favorite && (journalId === null || e.metadata.journal_id === journalId),
  )
}

const listEntriesByTagPaged: Handler = (args) => {
  const tagId = asString(args.tagId)
  const journalId = asString(args.journalId)
  const favoritesOnly = args.favoritesOnly === true
  return pagedEntries(
    args,
    (e) =>
      tagId !== null &&
      e.metadata.tag_ids.includes(tagId) &&
      (journalId === null || e.metadata.journal_id === journalId) &&
      (!favoritesOnly || e.metadata.is_favorite),
  )
}

// ---------------------------------------------------------------------------------------------
// Single entry
// ---------------------------------------------------------------------------------------------

/**
 * The visible entry, fetched on demand when it is not loaded. `null` for an id the vault does not
 * know (desktop: not found); `EntryNotAvailableError` for locked, invisible and deleted entries.
 */
export async function loadVisible(vault: VaultApi, id: string): Promise<VaultEntry | null> {
  if (!vault.isLoaded(id)) {
    const result = await vault.load([id])
    if (result.missing.includes(id)) return null
    const failure = result.failed.find((f) => f.id === id)
    if (failure !== undefined) throw new Error(`Could not open this entry: ${failure.message}`)
  }
  try {
    return vault.getEntry(id)
  } catch (error) {
    if (error instanceof EntryUnavailableError) throw new EntryNotAvailableError()
    throw error
  }
}

const getEntry: Handler = async ({ id }) => {
  const { vault } = await openForRead()
  const entry = await loadVisible(vault, String(id))
  return entry === null ? null : toEntry(entry)
}

const getEntryContent: Handler = async ({ id }) => {
  const { vault } = await openForRead()
  const entry = await loadVisible(vault, String(id))
  if (entry === null || entry.content.length === 0) return null
  return Array.from(entry.content)
}

// ---------------------------------------------------------------------------------------------
// Calendar-style reads over the loaded set (no downloads)
// ---------------------------------------------------------------------------------------------

const loadedIn = (vault: VaultApi, journalId: string | null): VaultEntry[] =>
  vault.listLoaded().filter((e) => journalId === null || e.metadata.journal_id === journalId)

const listEntryDates: Handler = async ({ journalId }) => {
  const { vault } = await openForRead()
  return loadedIn(vault, asString(journalId))
    .sort(byDateDesc)
    .map((e) => e.metadata.entry_date)
}

const listEntriesForDateRange: Handler = async ({ journalId, fromTs, toTs }) => {
  const { vault } = await openForRead()
  const from = asNumber(fromTs) ?? 0
  const to = asNumber(toTs) ?? 0
  return loadedIn(vault, asString(journalId))
    .filter((e) => e.metadata.entry_date >= from && e.metadata.entry_date < to)
    .sort(byDateDesc)
    .map(toEntry)
}

const pad = (n: number): string => String(n).padStart(2, '0')

/**
 * `(date, emotion)` pairs for `year`: year bounds in UTC, the day in local time, one pair per
 * (day, emotion), days ascending and the most recently updated emotion first within a day.
 */
const getEmotionByDate: Handler = async ({ year }) => {
  const y = asNumber(year)
  if (y === null || !Number.isInteger(y)) throw new Error('year must be an integer')
  const { vault } = await openForRead()
  const from = Date.UTC(y, 0, 1) / 1000
  const to = Date.UTC(y + 1, 0, 1) / 1000
  const latest = new Map<string, { date: string; emotion: string; updated: number }>()
  for (const { metadata: m } of vault.listLoaded()) {
    if (m.emotion === null || m.entry_date < from || m.entry_date >= to) continue
    const local = new Date(m.entry_date * 1000)
    const date = `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())}`
    const key = `${date}|${m.emotion}`
    const seen = latest.get(key)
    if (seen === undefined || m.updated_at > seen.updated) {
      latest.set(key, { date, emotion: m.emotion, updated: m.updated_at })
    }
  }
  return [...latest.values()]
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : b.updated - a.updated))
    .map((r) => [r.date, r.emotion])
}

const countEntriesInJournal: Handler = async ({ journalId }) => {
  const { vault } = await openForRead()
  return loadedIn(vault, String(journalId)).length
}

// ---------------------------------------------------------------------------------------------
// Write Commands (Phase 16)
// ---------------------------------------------------------------------------------------------

export function assertWritesEnabled(): void {
  if (!getCachedWriteFlag()) {
    throw new Error('read_only')
  }
}

/**
 * An outbox-writing command. `lock()` takes the session's outbox mutex, shared with intent
 * retention (`sync/retention.ts`): call it after `openForWrite()` / `ensureLoaded()` and before
 * reading `priorIntent`, so no retention pass can drop the draft (and its media) this write builds
 * on. It is released when the command settles. Never await `ready()` or `pull()` after it.
 */
export function outboxWrite(
  body: (args: Record<string, unknown>, lock: () => Promise<void>) => Promise<unknown>,
): Handler {
  return async (args) => {
    const held: { release?: () => void } = {}
    try {
      return await body(args, async () => {
        held.release ??= await acquireOutboxLock()
      })
    } finally {
      held.release?.()
    }
  }
}

export type MediaFilePicker = (accept: string) => Promise<File | null>
let customMediaPicker: MediaFilePicker | null = null

export function setCustomMediaPicker(picker: MediaFilePicker | null): void {
  customMediaPicker = picker
}

async function promptForFile(accept: string): Promise<File | null> {
  if (customMediaPicker) return customMediaPicker(accept)
  if (typeof document === 'undefined') return null
  return new Promise<File | null>((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    let resolved = false
    const finish = (file: File | null) => {
      if (resolved) return
      resolved = true
      clearTimeout(timer)
      window.removeEventListener('focus', onFocus)
      resolve(file)
    }
    const onFocus = () => {
      timer = setTimeout(() => finish(null), 300)
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    input.addEventListener('change', () => finish(input.files?.[0] ?? null))
    input.addEventListener('cancel', () => finish(null))
    window.addEventListener('focus', onFocus, { once: true })
    input.click()
  })
}

const createEntry = outboxWrite(async (args, lock) => {
  assertWritesEnabled()
  const { vault, taxonomy, db, core } = await openForWrite()
  await lock()
  const ring = getKeyRing()
  const journalId = String(args.journalId ?? '')
  if (!journalId) throw new Error('journalId is required')

  const journal = taxonomy.journals.find((j) => j.id === journalId)
  if (!journal) throw new Error(`Journal not found or not visible: ${journalId}`)

  const device = await db.device.get()
  if (!device) throw new Error('Device record missing')

  const entryId = crypto.randomUUID()
  const changeSeq = await db.device.allocateChangeSeq()
  const nowSecs = correctedNowSecs()
  const entryDateSecs =
    typeof args.entryDate === 'number' && Number.isFinite(args.entryDate)
      ? Math.floor(args.entryDate)
      : nowSecs

  const titleStr = typeof args.title === 'string' ? args.title : ''
  const contentText = typeof args.contentText === 'string' ? args.contentText : null
  const previewText = typeof args.previewText === 'string' ? args.previewText : null

  const autoTags = taxonomy.autoTagIds[journalId] ?? []
  const tagsAdd: Record<string, FieldChange<boolean>> = {}
  for (const tagId of autoTags) {
    tagsAdd[tagId] = {
      value: true,
      base: false,
      base_updated_at: 0,
      change_seq: changeSeq,
      changed_at_secs: nowSecs,
    }
  }

  // The desktop editor's shape (src-tauri/src/yjs_doc.rs): XmlFragment "default" of paragraphs,
  // one per line. Never `Y.Text('content')`, which the editor renders as an empty body.
  const doc = new Y.Doc()
  if (contentText) {
    doc.getXmlFragment('default').insert(
      0,
      contentText.split('\n').map((line) => {
        const paragraph = new Y.XmlElement('paragraph')
        paragraph.insert(0, [new Y.XmlText(line)])
        return paragraph
      }),
    )
  }
  const yjsBytes = Y.encodeStateAsUpdate(doc)

  const fields: OutboxFields = {
    title: titleStr
      ? {
          value: titleStr,
          base: '',
          base_updated_at: 0,
          change_seq: changeSeq,
          changed_at_secs: nowSecs,
        }
      : null,
    entry_date: {
      value: String(entryDateSecs),
      base: String(nowSecs),
      base_updated_at: 0,
      change_seq: changeSeq,
      changed_at_secs: nowSecs,
    },
    emotion: null,
    is_favorite: null,
    journal_id: {
      value: journalId,
      base: '',
      base_updated_at: 0,
      change_seq: changeSeq,
      changed_at_secs: nowSecs,
    },
    tags_add: tagsAdd,
    tags_remove: {},
  }

  const intent: OutboxEntryV1 = {
    schema_version: 1,
    entry_id: entryId,
    web_device_id: device.deviceId,
    created_on_web: true,
    web_updated_at_secs: nowSecs,
    base_state_vector: [],
    yjs_full_state: Array.from(yjsBytes),
    content_text: contentText,
    preview_text: previewText,
    fields,
    media: [],
  }

  const sealed = core.sealOutboxEntry(ring, JSON.stringify(intent))
  const draftManager = createDraftManager({ db })
  await draftManager.saveDraft(entryId, sealed)

  const currentIntents = vault.getOutboxIntents().filter((i) => i.entry_id !== entryId)
  vault.setOutboxIntents([...currentIntents, intent])
  readEnv().emit('memlore:entries-changed')

  const created = vault.getEntry(entryId)
  if (!created) throw new Error('Created entry missing from vault overlay')
  return toEntry(created)
})

/**
 * The entry a write builds on. Locked, invisible, deleted and excluded-journal entries refuse the
 * write with `EntryNotAvailableError`, the same answer reads give (`loadVisible`).
 */
function writeViewOrUnavailable(vault: VaultApi, id: string): VaultEntry {
  try {
    return vault.getWriteView(id)
  } catch (error) {
    if (error instanceof EntryUnavailableError) throw new EntryNotAvailableError()
    throw error
  }
}

async function ensureLoaded(vault: VaultApi, id: string): Promise<void> {
  if (vault.status(id) === 'not-loaded') {
    await vault.load([id])
  }
}

const saveEntryContent = outboxWrite(async (args, lock) => {
  assertWritesEnabled()
  const id = String(args.id ?? '')
  if (!id) throw new Error('id is required')

  const { vault, db, core } = await openForWrite()
  const ring = getKeyRing()

  await ensureLoaded(vault, id)
  await lock()

  const priorIntent = vault.getOutboxIntent(id) ?? null
  writeViewOrUnavailable(vault, id)

  const device = await db.device.get()
  if (!device) throw new Error('Device record missing')

  let baseDocBytes: Uint8Array | null = null
  if (!priorIntent?.created_on_web) {
    const rawBase = vault.getWriteView(id).content
    if (rawBase && rawBase.length > 0) baseDocBytes = rawBase
  }

  const rawYjs = args.yjsDoc
  const localDocBytes =
    rawYjs instanceof Uint8Array ? rawYjs : Array.isArray(rawYjs) ? new Uint8Array(rawYjs) : null

  const contentText = typeof args.contentText === 'string' ? args.contentText : null
  const previewText = typeof args.previewText === 'string' ? args.previewText : null
  const nowSecs = correctedNowSecs()

  const updatedIntent = buildOutboxIntent({
    entryId: id,
    webDeviceId: device.deviceId,
    createdOnWeb: priorIntent ? priorIntent.created_on_web : false,
    baseSyncedDocBytes: baseDocBytes,
    priorIntent,
    localDocBytes,
    contentText,
    previewText,
    newFields: {},
    nowSecs,
  })

  const sealed = core.sealOutboxEntry(ring, JSON.stringify(updatedIntent))
  const draftManager = createDraftManager({ db })
  await draftManager.saveDraft(id, sealed)

  const currentIntents = vault.getOutboxIntents().filter((i) => i.entry_id !== id)
  vault.setOutboxIntents([...currentIntents, updatedIntent])
  readEnv().emit('memlore:entries-changed')
})

const updateEntry = outboxWrite(async (args, lock) => {
  assertWritesEnabled()
  const id = String(args.id ?? '')
  if (!id) throw new Error('id is required')

  const { vault, db, core } = await openForWrite()
  const ring = getKeyRing()

  await ensureLoaded(vault, id)
  await lock()

  const priorIntent = vault.getOutboxIntent(id) ?? null
  const syncedEntry = writeViewOrUnavailable(vault, id)

  const device = await db.device.get()
  if (!device) throw new Error('Device record missing')

  const changeSeq = await db.device.allocateChangeSeq()
  const nowSecs = correctedNowSecs()

  let baseDocBytes: Uint8Array | null = null
  if (!priorIntent?.created_on_web) {
    const rawBase = vault.getWriteView(id).content
    if (rawBase && rawBase.length > 0) baseDocBytes = rawBase
  }

  const newFields: Partial<OutboxFields> = {}
  if (typeof args.title === 'string') {
    const base = priorIntent?.fields.title
      ? priorIntent.fields.title.base
      : (syncedEntry?.metadata.title ?? '')
    const baseUpdatedAt = priorIntent?.fields.title
      ? priorIntent.fields.title.base_updated_at
      : (syncedEntry?.metadata.updated_at ?? 0)
    newFields.title = {
      value: args.title,
      base,
      base_updated_at: baseUpdatedAt,
      change_seq: changeSeq,
      changed_at_secs: nowSecs,
    }
  }

  const contentText = typeof args.contentText === 'string' ? args.contentText : null
  const previewText = typeof args.previewText === 'string' ? args.previewText : null

  const updatedIntent = buildOutboxIntent({
    entryId: id,
    webDeviceId: device.deviceId,
    createdOnWeb: priorIntent ? priorIntent.created_on_web : false,
    baseSyncedDocBytes: baseDocBytes,
    priorIntent,
    localDocBytes: null,
    contentText,
    previewText,
    newFields,
    nowSecs,
  })

  const sealed = core.sealOutboxEntry(ring, JSON.stringify(updatedIntent))
  const draftManager = createDraftManager({ db })
  await draftManager.saveDraft(id, sealed)

  const currentIntents = vault.getOutboxIntents().filter((i) => i.entry_id !== id)
  vault.setOutboxIntents([...currentIntents, updatedIntent])
  readEnv().emit('memlore:entries-changed')

  const updated = vault.getEntry(id)
  if (!updated) throw new Error('Updated entry missing from vault')
  return toEntry(updated)
})

const updateEntryDate = outboxWrite(async (args, lock) => {
  assertWritesEnabled()
  const id = String(args.id ?? '')
  const entryDate = asNumber(args.entryDate)
  if (!id || entryDate === null) throw new Error('id and entryDate are required')

  const { vault, db, core } = await openForWrite()
  const ring = getKeyRing()

  await ensureLoaded(vault, id)
  await lock()

  const priorIntent = vault.getOutboxIntent(id) ?? null
  const syncedEntry = writeViewOrUnavailable(vault, id)

  const device = await db.device.get()
  if (!device) throw new Error('Device record missing')

  const changeSeq = await db.device.allocateChangeSeq()
  const nowSecs = correctedNowSecs()

  let baseDocBytes: Uint8Array | null = null
  if (!priorIntent?.created_on_web) {
    const rawBase = vault.getWriteView(id).content
    if (rawBase && rawBase.length > 0) baseDocBytes = rawBase
  }

  const base = priorIntent?.fields.entry_date
    ? priorIntent.fields.entry_date.base
    : String(syncedEntry?.metadata.entry_date ?? nowSecs)
  const baseUpdatedAt = priorIntent?.fields.entry_date
    ? priorIntent.fields.entry_date.base_updated_at
    : (syncedEntry?.metadata.updated_at ?? 0)

  const newFields: Partial<OutboxFields> = {
    entry_date: {
      value: String(Math.floor(entryDate)),
      base,
      base_updated_at: baseUpdatedAt,
      change_seq: changeSeq,
      changed_at_secs: nowSecs,
    },
  }

  const updatedIntent = buildOutboxIntent({
    entryId: id,
    webDeviceId: device.deviceId,
    createdOnWeb: priorIntent ? priorIntent.created_on_web : false,
    baseSyncedDocBytes: baseDocBytes,
    priorIntent,
    localDocBytes: null,
    contentText: null,
    previewText: null,
    newFields,
    nowSecs,
  })

  const sealed = core.sealOutboxEntry(ring, JSON.stringify(updatedIntent))
  const draftManager = createDraftManager({ db })
  await draftManager.saveDraft(id, sealed)

  const currentIntents = vault.getOutboxIntents().filter((i) => i.entry_id !== id)
  vault.setOutboxIntents([...currentIntents, updatedIntent])
  readEnv().emit('memlore:entries-changed')
})

/**
 * `mark_entry_date_user_edited` (desktop `queries.rs:2754`, a flag-flip that never touches
 * `entry_date`). The intent format has no flag field of its own: the flag rides on
 * `fields.entry_date` — the desktop importer marks `entry_date_user_edited` whenever it
 * applies an entry_date change (`outbox_import.rs`), and the vault overlay mirrors it.
 * Every web caller marks right after `update_entry_date`, so the intent normally carries
 * the change already; a bare mark confirm-writes the current date (same value — the
 * importer reports it "reflected", so the flag stays a local overlay signal) so the
 * record still exists. A recorded change is never rewritten: its base and change_seq
 * are what the conflict rules compare against.
 */
const markEntryDateUserEdited = outboxWrite(async (args, lock) => {
  assertWritesEnabled()
  const id = String(args.id ?? '')
  if (!id) throw new Error('id is required')

  const { vault, db, core } = await openForWrite()
  const ring = getKeyRing()

  if ((await loadVisible(vault, id)) === null) throw new EntryNotAvailableError()
  await lock()

  const priorIntent = vault.getOutboxIntent(id) ?? null
  if (priorIntent?.fields.entry_date) {
    // The flag is already recorded on the intent's date change.
    readEnv().emit('memlore:entries-changed')
    return
  }

  // Throws ForeignEntryReadOnlyError for an entry known only from another browser's outbox.
  const writeView = writeViewOrUnavailable(vault, id)

  const device = await db.device.get()
  if (!device) throw new Error('Device record missing')
  const changeSeq = await db.device.allocateChangeSeq()
  const nowSecs = correctedNowSecs()

  let baseDocBytes: Uint8Array | null = null
  if (!priorIntent?.created_on_web) {
    const rawBase = vault.getWriteView(id).content
    if (rawBase && rawBase.length > 0) baseDocBytes = rawBase
  }

  const entryDate = writeView.metadata.entry_date
  const newFields: Partial<OutboxFields> = {
    entry_date: {
      value: String(entryDate),
      base: String(entryDate),
      base_updated_at: writeView.metadata.updated_at,
      change_seq: changeSeq,
      changed_at_secs: nowSecs,
    },
  }

  const updatedIntent = buildOutboxIntent({
    entryId: id,
    webDeviceId: device.deviceId,
    createdOnWeb: priorIntent ? priorIntent.created_on_web : false,
    baseSyncedDocBytes: baseDocBytes,
    priorIntent,
    localDocBytes: null,
    contentText: null,
    previewText: null,
    newFields,
    nowSecs,
  })

  const sealed = core.sealOutboxEntry(ring, JSON.stringify(updatedIntent))
  const draftManager = createDraftManager({ db })
  await draftManager.saveDraft(id, sealed)

  const currentIntents = vault.getOutboxIntents().filter((i) => i.entry_id !== id)
  vault.setOutboxIntents([...currentIntents, updatedIntent])
  readEnv().emit('memlore:entries-changed')
})

const updateEntryEmotion = outboxWrite(async (args, lock) => {
  assertWritesEnabled()
  const id = String(args.id ?? '')
  const rawEmotion = args.emotion
  const emotion =
    rawEmotion === null || rawEmotion === undefined
      ? null
      : typeof rawEmotion === 'string' && EMOTIONS.includes(rawEmotion)
        ? rawEmotion
        : null
  if (rawEmotion !== null && rawEmotion !== undefined && emotion === null) {
    throw new Error(`invalid emotion: ${String(rawEmotion)}`)
  }

  const { vault, db, core } = await openForWrite()
  const ring = getKeyRing()

  await ensureLoaded(vault, id)
  await lock()

  const priorIntent = vault.getOutboxIntent(id) ?? null
  const syncedEntry = writeViewOrUnavailable(vault, id)

  const device = await db.device.get()
  if (!device) throw new Error('Device record missing')

  const changeSeq = await db.device.allocateChangeSeq()
  const nowSecs = correctedNowSecs()

  let baseDocBytes: Uint8Array | null = null
  if (!priorIntent?.created_on_web) {
    const rawBase = vault.getWriteView(id).content
    if (rawBase && rawBase.length > 0) baseDocBytes = rawBase
  }

  const base = priorIntent?.fields.emotion
    ? priorIntent.fields.emotion.base
    : (syncedEntry?.metadata.emotion ?? null)
  const baseUpdatedAt = priorIntent?.fields.emotion
    ? priorIntent.fields.emotion.base_updated_at
    : (syncedEntry?.metadata.updated_at ?? 0)

  const newFields: Partial<OutboxFields> = {
    emotion: {
      value: emotion,
      base,
      base_updated_at: baseUpdatedAt,
      change_seq: changeSeq,
      changed_at_secs: nowSecs,
    },
  }

  const updatedIntent = buildOutboxIntent({
    entryId: id,
    webDeviceId: device.deviceId,
    createdOnWeb: priorIntent ? priorIntent.created_on_web : false,
    baseSyncedDocBytes: baseDocBytes,
    priorIntent,
    localDocBytes: null,
    contentText: null,
    previewText: null,
    newFields,
    nowSecs,
  })

  const sealed = core.sealOutboxEntry(ring, JSON.stringify(updatedIntent))
  const draftManager = createDraftManager({ db })
  await draftManager.saveDraft(id, sealed)

  const currentIntents = vault.getOutboxIntents().filter((i) => i.entry_id !== id)
  vault.setOutboxIntents([...currentIntents, updatedIntent])
  readEnv().emit('memlore:entries-changed')

  const updated = vault.getEntry(id)
  if (!updated) throw new Error('Updated entry missing from vault')
  return toEntry(updated)
})

const toggleFavorite = outboxWrite(async (args, lock) => {
  assertWritesEnabled()
  const id = String(args.id ?? '')
  if (!id) throw new Error('id is required')

  const { vault, db, core } = await openForWrite()
  const ring = getKeyRing()

  await ensureLoaded(vault, id)
  await lock()

  const priorIntent = vault.getOutboxIntent(id) ?? null
  const syncedEntry = writeViewOrUnavailable(vault, id)

  const device = await db.device.get()
  if (!device) throw new Error('Device record missing')

  const currentFav = syncedEntry?.metadata.is_favorite ?? false
  const targetFav = !currentFav

  const changeSeq = await db.device.allocateChangeSeq()
  const nowSecs = correctedNowSecs()

  let baseDocBytes: Uint8Array | null = null
  if (!priorIntent?.created_on_web) {
    const rawBase = vault.getWriteView(id).content
    if (rawBase && rawBase.length > 0) baseDocBytes = rawBase
  }

  const base = priorIntent?.fields.is_favorite ? priorIntent.fields.is_favorite.base : currentFav
  const baseUpdatedAt = priorIntent?.fields.is_favorite
    ? priorIntent.fields.is_favorite.base_updated_at
    : (syncedEntry?.metadata.updated_at ?? 0)

  const newFields: Partial<OutboxFields> = {
    is_favorite: {
      value: targetFav,
      base,
      base_updated_at: baseUpdatedAt,
      change_seq: changeSeq,
      changed_at_secs: nowSecs,
    },
  }

  const updatedIntent = buildOutboxIntent({
    entryId: id,
    webDeviceId: device.deviceId,
    createdOnWeb: priorIntent ? priorIntent.created_on_web : false,
    baseSyncedDocBytes: baseDocBytes,
    priorIntent,
    localDocBytes: null,
    contentText: null,
    previewText: null,
    newFields,
    nowSecs,
  })

  const sealed = core.sealOutboxEntry(ring, JSON.stringify(updatedIntent))
  const draftManager = createDraftManager({ db })
  await draftManager.saveDraft(id, sealed)

  const currentIntents = vault.getOutboxIntents().filter((i) => i.entry_id !== id)
  vault.setOutboxIntents([...currentIntents, updatedIntent])
  readEnv().emit('memlore:entries-changed')
  return targetFav
})

const moveEntryToJournal = outboxWrite(async (args, lock) => {
  assertWritesEnabled()
  const id = String(args.id ?? '')
  const journalId = String(args.journalId ?? '')
  if (!id || !journalId) throw new Error('id and journalId are required')

  const { vault, taxonomy, db, core } = await openForWrite()
  const ring = getKeyRing()

  const journal = taxonomy.journals.find((j) => j.id === journalId)
  if (!journal) throw new Error(`Journal not found or not visible: ${journalId}`)

  await ensureLoaded(vault, id)
  await lock()

  const priorIntent = vault.getOutboxIntent(id) ?? null
  const syncedEntry = writeViewOrUnavailable(vault, id)

  const device = await db.device.get()
  if (!device) throw new Error('Device record missing')

  const changeSeq = await db.device.allocateChangeSeq()
  const nowSecs = correctedNowSecs()

  let baseDocBytes: Uint8Array | null = null
  if (!priorIntent?.created_on_web) {
    const rawBase = vault.getWriteView(id).content
    if (rawBase && rawBase.length > 0) baseDocBytes = rawBase
  }

  const base = priorIntent?.fields.journal_id
    ? priorIntent.fields.journal_id.base
    : (syncedEntry?.metadata.journal_id ?? '')
  const baseUpdatedAt = priorIntent?.fields.journal_id
    ? priorIntent.fields.journal_id.base_updated_at
    : (syncedEntry?.metadata.updated_at ?? 0)

  const newFields: Partial<OutboxFields> = {
    journal_id: {
      value: journalId,
      base,
      base_updated_at: baseUpdatedAt,
      change_seq: changeSeq,
      changed_at_secs: nowSecs,
    },
  }

  const updatedIntent = buildOutboxIntent({
    entryId: id,
    webDeviceId: device.deviceId,
    createdOnWeb: priorIntent ? priorIntent.created_on_web : false,
    baseSyncedDocBytes: baseDocBytes,
    priorIntent,
    localDocBytes: null,
    contentText: null,
    previewText: null,
    newFields,
    nowSecs,
  })

  const sealed = core.sealOutboxEntry(ring, JSON.stringify(updatedIntent))
  const draftManager = createDraftManager({ db })
  await draftManager.saveDraft(id, sealed)

  const currentIntents = vault.getOutboxIntents().filter((i) => i.entry_id !== id)
  vault.setOutboxIntents([...currentIntents, updatedIntent])
  readEnv().emit('memlore:entries-changed')
})

const addTagToEntry = outboxWrite(async (args, lock) => {
  assertWritesEnabled()
  const entryId = String(args.entryId ?? '')
  const tagId = String(args.tagId ?? '')
  if (!entryId || !tagId) throw new Error('entryId and tagId are required')

  const { vault, taxonomy, db, core } = await openForWrite()
  const ring = getKeyRing()

  const tag = taxonomy.tags.find((t) => t.id === tagId)
  if (!tag) throw new Error(`Tag not found: ${tagId}`)

  await ensureLoaded(vault, entryId)
  await lock()

  const priorIntent = vault.getOutboxIntent(entryId) ?? null
  const syncedEntry = writeViewOrUnavailable(vault, entryId)

  const device = await db.device.get()
  if (!device) throw new Error('Device record missing')

  const changeSeq = await db.device.allocateChangeSeq()
  const nowSecs = correctedNowSecs()

  let baseDocBytes: Uint8Array | null = null
  if (!priorIntent?.created_on_web) {
    const rawBase = vault.getWriteView(entryId).content
    if (rawBase && rawBase.length > 0) baseDocBytes = rawBase
  }

  const priorTagChange = priorIntent?.fields.tags_add[tagId]
  const baseUpdatedAt = priorTagChange
    ? priorTagChange.base_updated_at
    : (syncedEntry?.metadata.updated_at ?? 0)
  const baseVal = priorTagChange
    ? priorTagChange.base
    : Boolean(syncedEntry?.metadata.tag_ids?.includes(tagId))

  const newFields: Partial<OutboxFields> = {
    tags_add: {
      [tagId]: {
        value: true,
        base: baseVal,
        base_updated_at: baseUpdatedAt,
        change_seq: changeSeq,
        changed_at_secs: nowSecs,
      },
    },
  }

  const updatedIntent = buildOutboxIntent({
    entryId,
    webDeviceId: device.deviceId,
    createdOnWeb: priorIntent ? priorIntent.created_on_web : false,
    baseSyncedDocBytes: baseDocBytes,
    priorIntent,
    localDocBytes: null,
    contentText: null,
    previewText: null,
    newFields,
    nowSecs,
  })

  delete updatedIntent.fields.tags_remove[tagId]

  const sealed = core.sealOutboxEntry(ring, JSON.stringify(updatedIntent))
  const draftManager = createDraftManager({ db })
  await draftManager.saveDraft(entryId, sealed)

  const currentIntents = vault.getOutboxIntents().filter((i) => i.entry_id !== entryId)
  vault.setOutboxIntents([...currentIntents, updatedIntent])
  readEnv().emit('memlore:entries-changed')
})

const removeTagFromEntry = outboxWrite(async (args, lock) => {
  assertWritesEnabled()
  const entryId = String(args.entryId ?? '')
  const tagId = String(args.tagId ?? '')
  if (!entryId || !tagId) throw new Error('entryId and tagId are required')

  const { vault, taxonomy, db, core } = await openForWrite()
  const ring = getKeyRing()

  const tag = taxonomy.tags.find((t) => t.id === tagId)
  if (!tag) throw new Error(`Tag not found: ${tagId}`)

  await ensureLoaded(vault, entryId)
  await lock()

  const priorIntent = vault.getOutboxIntent(entryId) ?? null
  const syncedEntry = writeViewOrUnavailable(vault, entryId)

  const device = await db.device.get()
  if (!device) throw new Error('Device record missing')

  const changeSeq = await db.device.allocateChangeSeq()
  const nowSecs = correctedNowSecs()

  let baseDocBytes: Uint8Array | null = null
  if (!priorIntent?.created_on_web) {
    const rawBase = vault.getWriteView(entryId).content
    if (rawBase && rawBase.length > 0) baseDocBytes = rawBase
  }

  const priorTagChange = priorIntent?.fields.tags_remove[tagId]
  const baseUpdatedAt = priorTagChange
    ? priorTagChange.base_updated_at
    : (syncedEntry?.metadata.updated_at ?? 0)
  const baseVal = priorTagChange
    ? priorTagChange.base
    : Boolean(syncedEntry?.metadata.tag_ids?.includes(tagId))

  const newFields: Partial<OutboxFields> = {
    tags_remove: {
      [tagId]: {
        value: true,
        base: baseVal,
        base_updated_at: baseUpdatedAt,
        change_seq: changeSeq,
        changed_at_secs: nowSecs,
      },
    },
  }

  const updatedIntent = buildOutboxIntent({
    entryId,
    webDeviceId: device.deviceId,
    createdOnWeb: priorIntent ? priorIntent.created_on_web : false,
    baseSyncedDocBytes: baseDocBytes,
    priorIntent,
    localDocBytes: null,
    contentText: null,
    previewText: null,
    newFields,
    nowSecs,
  })

  delete updatedIntent.fields.tags_add[tagId]

  const sealed = core.sealOutboxEntry(ring, JSON.stringify(updatedIntent))
  const draftManager = createDraftManager({ db })
  await draftManager.saveDraft(entryId, sealed)

  const currentIntents = vault.getOutboxIntents().filter((i) => i.entry_id !== entryId)
  vault.setOutboxIntents([...currentIntents, updatedIntent])
  readEnv().emit('memlore:entries-changed')
})

const getMediaUploadLimits: Handler = async () => ({
  photoBytes: DEFAULT_MEDIA_MAX_PHOTO_UPLOAD_BYTES,
  videoBytes: DEFAULT_MEDIA_MAX_VIDEO_UPLOAD_BYTES,
})

const pickMedia = (kind: 'image' | 'video'): Handler =>
  outboxWrite(async (args, lock) => {
    assertWritesEnabled()
    const entryId = String(args.entryId ?? '')
    if (!entryId) throw new Error('entryId is required')
    const mode = String(args.insertionMode ?? 'inline')
    if (mode !== 'inline' && mode !== 'attached') {
      throw new Error(`invalid insertionMode: ${mode}`)
    }

    const { vault, db, core } = await openForWrite()
    const ring = getKeyRing()

    await ensureLoaded(vault, entryId)
    writeViewOrUnavailable(vault, entryId)

    const accept = kind === 'image' ? 'image/*' : 'video/*'
    const file = await promptForFile(accept)
    if (!file) return null

    const maxBytes =
      kind === 'image' ? DEFAULT_MEDIA_MAX_PHOTO_UPLOAD_BYTES : DEFAULT_MEDIA_MAX_VIDEO_UPLOAD_BYTES
    if (file.size > maxBytes) {
      if (kind === 'image') {
        throw new Error(formatImageTooLargeError(file.size, maxBytes))
      } else {
        throw new Error(formatVideoTooLargeError(file.name, maxBytes))
      }
    }

    const mediaPlain = new Uint8Array(await file.arrayBuffer())
    const rawMime = (file.type || '').trim().toLowerCase()
    const mimeType = rawMime || (kind === 'image' ? 'image/jpeg' : 'video/mp4')
    if (!isAllowedMimeType(mimeType)) {
      throw new Error(`unsupported mime type: ${mimeType}`)
    }
    if (kind === 'image' && !mimeType.startsWith('image/')) {
      throw new Error(`expected image mime type, got: ${mimeType}`)
    }
    if (kind === 'video' && !mimeType.startsWith('video/')) {
      throw new Error(`expected video mime type, got: ${mimeType}`)
    }

    const { thumbnailBytes } =
      kind === 'image'
        ? await generateImageThumbnail(mediaPlain, mimeType)
        : await generateVideoThumbnail(mediaPlain, mimeType)

    const mediaId = crypto.randomUUID()
    const sealedMedia = core.sealOutboxMedia(ring, mediaPlain)
    const sealedThumb = core.sealOutboxThumb(ring, thumbnailBytes)

    // Outbox mutex from here (not across the picker or the thumbnail): re-read the intent,
    // a retention pass may have dropped it meanwhile.
    await lock()
    const priorIntent = vault.getOutboxIntent(entryId) ?? null
    writeViewOrUnavailable(vault, entryId)
    await db.blobs.put({
      path: `outbox/m-${mediaId}`,
      bytes: sealedMedia,
      size: sealedMedia.length,
      lastAccess: Date.now(),
    })
    await db.blobs.put({
      path: `outbox/m-${mediaId}.thumb`,
      bytes: sealedThumb,
      size: sealedThumb.length,
      lastAccess: Date.now(),
    })

    const mediaRef: OutboxMediaRef = {
      media_id: mediaId,
      file_name: file.name,
      file_type: mimeType,
      size: file.size,
      has_thumb: true,
    }

    const device = await db.device.get()
    if (!device) throw new Error('Device record missing')
    const nowSecs = correctedNowSecs()

    let baseDocBytes: Uint8Array | null = null
    if (!priorIntent?.created_on_web) {
      const rawBase = vault.getWriteView(entryId).content
      if (rawBase && rawBase.length > 0) baseDocBytes = rawBase
    }

    const updatedIntent = buildOutboxIntent({
      entryId,
      webDeviceId: device.deviceId,
      createdOnWeb: priorIntent ? priorIntent.created_on_web : false,
      baseSyncedDocBytes: baseDocBytes,
      priorIntent,
      localDocBytes: null,
      contentText: null,
      previewText: null,
      newFields: {},
      mediaRefs: [mediaRef],
      nowSecs,
    })

    const sealed = core.sealOutboxEntry(ring, JSON.stringify(updatedIntent))
    const draftManager = createDraftManager({ db })
    await draftManager.saveDraft(entryId, sealed)

    const currentIntents = vault.getOutboxIntents().filter((i) => i.entry_id !== entryId)
    vault.setOutboxIntents([...currentIntents, updatedIntent])
    readEnv().emit('memlore:entries-changed')
    readEnv().emit('media-changed')

    return {
      mediaId,
      localPath: `${WEB_MEDIA_PATH_PREFIX}${mediaId}`,
    }
  })

const savePastedImage = outboxWrite(async (args, lock) => {
  assertWritesEnabled()
  const entryId = String(args.entryId ?? '')
  if (!entryId) throw new Error('entryId is required')
  const rawBytes = args.bytes
  const mediaPlain =
    rawBytes instanceof Uint8Array
      ? rawBytes
      : Array.isArray(rawBytes)
        ? new Uint8Array(rawBytes)
        : null
  if (!mediaPlain || mediaPlain.length === 0) {
    throw new Error('bytes are required')
  }

  const { vault, db, core } = await openForWrite()
  const ring = getKeyRing()

  await ensureLoaded(vault, entryId)
  writeViewOrUnavailable(vault, entryId)

  const maxBytes = DEFAULT_MEDIA_MAX_PHOTO_UPLOAD_BYTES
  if (mediaPlain.length > maxBytes) {
    throw new Error(formatImageTooLargeError(mediaPlain.length, maxBytes))
  }

  const rawMime =
    typeof args.mime === 'string' && args.mime.trim() ? args.mime.trim().toLowerCase() : 'image/png'
  if (!isAllowedMimeType(rawMime) || !rawMime.startsWith('image/')) {
    throw new Error(`unsupported mime type: ${rawMime}`)
  }
  const mimeType = rawMime
  const { thumbnailBytes } = await generateImageThumbnail(mediaPlain, mimeType)

  const mediaId = crypto.randomUUID()
  const sealedMedia = core.sealOutboxMedia(ring, mediaPlain)
  const sealedThumb = core.sealOutboxThumb(ring, thumbnailBytes)

  // Outbox mutex from here (not across the thumbnail): re-read the intent,
  // a retention pass may have dropped it meanwhile.
  await lock()
  const priorIntent = vault.getOutboxIntent(entryId) ?? null
  writeViewOrUnavailable(vault, entryId)
  await db.blobs.put({
    path: `outbox/m-${mediaId}`,
    bytes: sealedMedia,
    size: sealedMedia.length,
    lastAccess: Date.now(),
  })
  await db.blobs.put({
    path: `outbox/m-${mediaId}.thumb`,
    bytes: sealedThumb,
    size: sealedThumb.length,
    lastAccess: Date.now(),
  })

  const mediaRef: OutboxMediaRef = {
    media_id: mediaId,
    file_name: `pasted-${mediaId}.png`,
    file_type: mimeType,
    size: mediaPlain.length,
    has_thumb: true,
  }

  const device = await db.device.get()
  if (!device) throw new Error('Device record missing')
  const nowSecs = correctedNowSecs()

  let baseDocBytes: Uint8Array | null = null
  if (!priorIntent?.created_on_web) {
    const rawBase = vault.getWriteView(entryId).content
    if (rawBase && rawBase.length > 0) baseDocBytes = rawBase
  }

  const updatedIntent = buildOutboxIntent({
    entryId,
    webDeviceId: device.deviceId,
    createdOnWeb: priorIntent ? priorIntent.created_on_web : false,
    baseSyncedDocBytes: baseDocBytes,
    priorIntent,
    localDocBytes: null,
    contentText: null,
    previewText: null,
    newFields: {},
    mediaRefs: [mediaRef],
    nowSecs,
  })

  const sealed = core.sealOutboxEntry(ring, JSON.stringify(updatedIntent))
  const draftManager = createDraftManager({ db })
  await draftManager.saveDraft(entryId, sealed)

  const currentIntents = vault.getOutboxIntents().filter((i) => i.entry_id !== entryId)
  vault.setOutboxIntents([...currentIntents, updatedIntent])
  readEnv().emit('memlore:entries-changed')
  readEnv().emit('media-changed')

  return {
    mediaId,
    localPath: `${WEB_MEDIA_PATH_PREFIX}${mediaId}`,
  }
})

/**
 * `soft_delete_entry` (Phase 22.2): moves the entry to the desktop Trash through a `trash_entry`
 * outbox v2 draft (`d-<entryId>`). The entry is hidden at once (the session's pending overlay,
 * `vault.setTrashedIds`); a final refusal drops the draft and it reappears with a notice (Phase 21
 * retention). An edit draft of the same entry is kept: push uploads it before the trash.
 *
 * `base_updated_at` = the SYNCED `updated_at` of the entry, never an overlay value, with or
 * without a pending edit. The desktop (`decide_trash_entry` / `fast_forward_from`,
 * src-tauri/src/sync/outbox_import.rs) applies the trash when the base equals the row's stamp, or
 * when the only change since is this web device's own `<entryId>.bin`, which records the stamp it
 * fast-forwarded from (the row's stamp before it = the synced stamp the web saw; 0 for a web
 * create). An entry only this browser created, with no synced copy yet, is trashed from 0.
 */
const softDeleteEntry = outboxWrite(async (args, lock) => {
  assertWritesEnabled()
  const id = String(args.id ?? '')
  if (!id) throw new Error('id is required')

  const { vault, db, core, outboxV2Capable, refreshPendingV2 } = await openForWrite()
  if (!outboxV2Capable) throw new WebUnsupportedError('soft_delete_entry')

  await ensureLoaded(vault, id)
  await lock()

  // Locked, invisible, excluded, already trashed, or another browser's: not this browser's to trash.
  writeViewOrUnavailable(vault, id)
  // The outbox file name needs a uuid; a draft without one could never be pushed.
  if (!isUuid(id)) throw new Error('This entry cannot be moved to the Trash from the web.')
  const synced = vault.getSynced(id)
  const base =
    synced.status === 'visible' && synced.metadata !== null ? synced.metadata.updated_at : 0

  const device = await db.device.get()
  if (!device) throw new Error('Device record missing')
  const sealed = sealOutboxIntentV2(core, getKeyRing(), {
    kind: 'trash_entry',
    web_device_id: device.deviceId,
    web_updated_at_secs: correctedNowSecs(),
    entry_id: id,
    base_updated_at: base,
  })
  await createDraftManager({ db }).saveDraft(`d-${id}`, sealed, 'trash')
  await refreshPendingV2()
  readEnv().emit('memlore:entries-changed')
})

export const entryHandlers: Record<string, Handler> = {
  list_entries_paged: listEntriesPaged,
  list_all_entries_paged: listAllEntriesPaged,
  list_favorite_entries_paged: listFavoriteEntriesPaged,
  list_entries_by_tag_paged: listEntriesByTagPaged,
  get_entry: getEntry,
  get_entry_content: getEntryContent,
  list_entry_dates: listEntryDates,
  list_entries_for_date_range: listEntriesForDateRange,
  get_emotion_by_date: getEmotionByDate,
  count_entries_in_journal: countEntriesInJournal,
  create_entry: createEntry,
  save_entry_content: saveEntryContent,
  update_entry: updateEntry,
  update_entry_date: updateEntryDate,
  mark_entry_date_user_edited: markEntryDateUserEdited,
  update_entry_emotion: updateEntryEmotion,
  toggle_favorite: toggleFavorite,
  move_entry_to_journal: moveEntryToJournal,
  add_tag_to_entry: addTagToEntry,
  remove_tag_from_entry: removeTagFromEntry,
  get_media_upload_limits: getMediaUploadLimits,
  pick_image: pickMedia('image'),
  pick_video: pickMedia('video'),
  save_pasted_image: savePastedImage,
  soft_delete_entry: softDeleteEntry,
}
