/**
 * Entry read commands (Phase 10.3). READ-ONLY; writes are Phase 16.
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
 * Calendar-style reads (`list_entry_dates`, `list_entries_for_date_range`, `list_on_this_day`,
 * `get_emotion_by_date`, `count_entries_in_journal`) are answered from the entries loaded so far:
 * they never trigger a download.
 */

import type { Entry, EmotionKey } from '../../../../src/types/entry'
import type { EntrySort, EntryTimeRange, PagedResult } from '../../../../src/types/pagination'
import { EntryUnavailableError, type VaultEntry } from '../vault'
import type { Handler } from '../router'
import { openForRead, readEnv, type VaultApi } from './readSession'

export const MSG_UNAVAILABLE = 'This entry is not available on the web (locked, hidden or deleted).'

/** Upper bound of load rounds for one list call (each round loads at most one page of ids). */
export const MAX_LOAD_ROUNDS = 50
const ON_THIS_DAY_LIMIT = 200

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

/** Desktop buckets by UTC month and day (`strftime(..., 'unixepoch')`) and rejects bad bounds. */
const listOnThisDay: Handler = async ({ month, day }) => {
  const m = asNumber(month)
  const d = asNumber(day)
  if (m === null || !Number.isInteger(m) || m < 1 || m > 12) {
    throw new Error(`month must be 1..=12, got ${String(month)}`)
  }
  if (d === null || !Number.isInteger(d) || d < 1 || d > 31) {
    throw new Error(`day must be 1..=31, got ${String(day)}`)
  }
  const { vault } = await openForRead()
  return vault
    .listLoaded()
    .filter((e) => {
      const date = new Date(e.metadata.entry_date * 1000)
      return date.getUTCMonth() + 1 === m && date.getUTCDate() === d
    })
    .sort(byDateDesc)
    .slice(0, ON_THIS_DAY_LIMIT)
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

export const entryHandlers: Record<string, Handler> = {
  list_entries_paged: listEntriesPaged,
  list_all_entries_paged: listAllEntriesPaged,
  list_favorite_entries_paged: listFavoriteEntriesPaged,
  list_entries_by_tag_paged: listEntriesByTagPaged,
  get_entry: getEntry,
  get_entry_content: getEntryContent,
  list_entry_dates: listEntryDates,
  list_entries_for_date_range: listEntriesForDateRange,
  list_on_this_day: listOnThisDay,
  get_emotion_by_date: getEmotionByDate,
  count_entries_in_journal: countEntriesInJournal,
}
