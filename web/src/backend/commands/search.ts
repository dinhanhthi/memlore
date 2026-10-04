/**
 * `search_entries` (Phase 10.3).
 *
 * 1. The command answers at once from the entries LOADED so far (`vault.search`, desktop token
 *    semantics, see textFold.ts).
 * 2. It then pulls the remaining TEXT payloads (entry ciphertext only, never media) in the
 *    background, a few at a time through the puller (concurrency 4), and fires
 *    `memlore:entries-changed` after a batch that added a hit. Nothing is fetched unless the user
 *    runs a search; a NEW search (or a blank one) cancels the previous scan, and a lock stops it.
 *    The search modal re-queries only when its query changes (`useSearch`), so the streamed hits
 *    show on the next run of the same query; lists listening to the event refresh at once.
 *
 * ORDERING AND LIMIT: desktop ranks by FTS rank (bm25) and returns at most 50. The web has no rank:
 * results are ordered by entry date, newest first (id desc on ties), capped at `SEARCH_LIMIT` = 50.
 * In mention mode (`mentionMode`: the last token is a prefix) title matches come first, as the
 * desktop weights titles 10:1, then by entry date. A blank query with filters lists the filtered
 * entries newest first (desktop "browse mode"). `lockedView` and `activeVaultId` are ignored: only
 * entries the vault serves are searched.
 */

import type { EmotionKey, SearchFilters, SearchResult } from '../../../../src/types/entry'
import { onLock } from '../keys'
import { foldText, matchesQuery, parseQuery } from '../textFold'
import type { VaultEntry } from '../vault'
import type { Handler } from '../router'
import { openForRead, readEnv, type VaultApi } from './readSession'

/** Desktop `LIMIT 50`. */
export const SEARCH_LIMIT = 50
/**
 * Ids per background batch: 3x the puller's concurrency of 4 (the puller, not this count, caps the
 * parallel downloads), small enough that a cancel takes effect within one batch. Not imported from
 * sync/pull.ts so the router bundle does not pull the WASM core in statically.
 */
const SCAN_BATCH = 12
const CHANGED_EVENT = 'memlore:entries-changed'

let scanToken = 0
let scanSettled: Promise<void> = Promise.resolve()

/** Cancels the running background scan (a new search, a lock or a test). */
export function cancelSearchScan(): void {
  scanToken += 1
}

/** Resolves when the most recent background scan has finished or was cancelled. */
export const whenSearchScanSettled = (): Promise<void> => scanSettled

// ---------------------------------------------------------------------------------------------
// Filters (desktop `append_filter_clauses`)
// ---------------------------------------------------------------------------------------------

interface Filters {
  from: number | null
  toExclusive: number | null
  journalIds: string[]
  tagIds: string[]
  emotions: string[]
  hasMedia: 'has' | 'none' | null
}

const stringList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []

/** Null when no dimension is active (desktop `SearchFilters::is_empty`). */
function parseFilters(raw: unknown): Filters | null {
  if (typeof raw !== 'object' || raw === null) return null
  const f = raw as SearchFilters
  const range = f.timeRange
  const filters: Filters = {
    from: range !== undefined && typeof range.from === 'number' ? range.from : null,
    toExclusive:
      range !== undefined && typeof range.toExclusive === 'number' ? range.toExclusive : null,
    journalIds: stringList(f.journalIds),
    tagIds: stringList(f.tagIds),
    emotions: stringList(f.emotions) as EmotionKey[],
    hasMedia: f.hasMedia === 'has' || f.hasMedia === 'none' ? f.hasMedia : null,
  }
  const active =
    (filters.from !== null && filters.toExclusive !== null) ||
    filters.journalIds.length > 0 ||
    filters.tagIds.length > 0 ||
    filters.emotions.length > 0 ||
    filters.hasMedia !== null
  return active ? filters : null
}

function passesFilters(entry: VaultEntry, f: Filters | null): boolean {
  if (f === null) return true
  const m = entry.metadata
  if (f.from !== null && f.toExclusive !== null) {
    if (m.entry_date < f.from || m.entry_date >= f.toExclusive) return false
  }
  if (f.journalIds.length > 0 && !f.journalIds.includes(m.journal_id)) return false
  if (f.tagIds.length > 0 && !m.tag_ids.some((t) => f.tagIds.includes(t))) return false
  if (f.emotions.length > 0 && (m.emotion === null || !f.emotions.includes(m.emotion))) return false
  if (f.hasMedia !== null) {
    const hasMedia = Array.isArray(m.media) && m.media.length > 0
    if (hasMedia !== (f.hasMedia === 'has')) return false
  }
  return true
}

// ---------------------------------------------------------------------------------------------
// Matching and ordering
// ---------------------------------------------------------------------------------------------

interface Plan {
  query: string
  parsed: string[][]
  prefix: boolean
  filters: Filters | null
}

/** Same haystack as the vault index: the folded title and the folded body, separate streams. */
function matchesPlan(entry: VaultEntry, plan: Plan): boolean {
  if (!passesFilters(entry, plan.filters)) return false
  if (plan.parsed.length === 0) return plan.query === ''
  const m = entry.metadata
  const haystack = [foldText(m.title ?? ''), foldText(m.content_text ?? '')]
  return matchesQuery(haystack, plan.parsed, { prefix: plan.prefix })
}

const newestFirst = (a: VaultEntry, b: VaultEntry): number =>
  b.metadata.entry_date - a.metadata.entry_date ||
  (a.metadata.entry_id < b.metadata.entry_id ? 1 : -1)

function currentHits(vault: VaultApi, plan: Plan): VaultEntry[] {
  const base =
    plan.query === '' ? vault.listLoaded() : vault.search(plan.query, { prefix: plan.prefix })
  const hits = base.filter((e) => passesFilters(e, plan.filters)).sort(newestFirst)
  if (!plan.prefix || plan.parsed.length === 0) return hits
  const titleHit = (e: VaultEntry): boolean =>
    matchesQuery(foldText(e.metadata.title ?? ''), plan.parsed, { prefix: true })
  return [...hits.filter(titleHit), ...hits.filter((e) => !titleHit(e))]
}

const toResult = (e: VaultEntry): SearchResult => ({
  id: e.metadata.entry_id,
  journal_id: e.metadata.journal_id,
  title: e.metadata.title,
  preview_text: e.metadata.preview_text,
  entry_date: e.metadata.entry_date,
})

// ---------------------------------------------------------------------------------------------
// Background scan
// ---------------------------------------------------------------------------------------------

function startScan(vault: VaultApi, plan: Plan): void {
  const token = (scanToken += 1)
  const env = readEnv()
  const tried = new Set<string>()
  const stopped = (): boolean => token !== scanToken || !env.isUnlocked()
  // A lock followed by a quick unlock inside one batch must not let this scan continue.
  const offLock = onLock(cancelSearchScan)
  scanSettled = (async () => {
    while (!stopped()) {
      const batch = vault
        .listIndex()
        .filter((i) => !vault.isLoaded(i.entryId) && !tried.has(i.entryId))
        .slice(0, SCAN_BATCH)
        .map((i) => i.entryId)
      if (batch.length === 0) return
      for (const id of batch) tried.add(id)
      try {
        await vault.load(batch)
      } catch {
        return // offline, locked or revoked: the next search retries
      }
      if (stopped()) return
      const added = batch.some((id) => vault.isLoaded(id) && matchesPlan(vault.getEntry(id), plan))
      if (added) env.emit(CHANGED_EVENT)
    }
  })().finally(offLock)
}

// ---------------------------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------------------------

const searchEntries: Handler = async ({ query, filters, mentionMode }) => {
  const { vault } = await openForRead()
  cancelSearchScan()
  const text = typeof query === 'string' ? query.trim() : ''
  const parsedFilters = parseFilters(filters)
  // Desktop: a blank query without filters finds nothing; a query with no token (punctuation) too.
  const parsed = parseQuery(text)
  if ((text === '' && parsedFilters === null) || (text !== '' && parsed.length === 0)) return []
  const plan: Plan = { query: text, parsed, prefix: mentionMode === true, filters: parsedFilters }
  const results = currentHits(vault, plan).slice(0, SEARCH_LIMIT).map(toResult)
  startScan(vault, plan)
  return results
}

export const searchHandlers: Record<string, Handler> = {
  search_entries: searchEntries,
}
