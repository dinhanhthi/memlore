/**
 * On-demand device-bin loader (Phase 5.1): `chats.bin` and `memory.bin` of every desktop, plus the
 * `streak.bin` files the pull caches.
 *
 * - `chats.bin` / `memory.bin` are NEVER fetched by the pull. `loadDeviceBin(kind)` downloads them
 *   only when a chat or memory command runs, and only for the desktops whose cached manifest sets
 *   `chats_present` / `memory_present`, through the puller's shared limiter (which checks the lock
 *   before every download).
 * - Size guard: a file above `MAX_DEVICE_BIN_BYTES` (the WASM `MAX_BIN_BYTES`) is refused at the
 *   download layer and reported as `{ status: 'too_large_for_web' }` for that device, so the UI can
 *   say "open on desktop" instead of showing an empty list. A bin that cannot be opened or parsed
 *   is `{ status: 'unreadable' }` for that device only; both are cached for the current pull and
 *   both fail closed (never treated as "no data") in every handler.
 * - Decoded results live in RAM only (never in IndexedDB), per unlock session: `clear()` (the read
 *   session's lock hook) drops them and detaches in-flight loads. A device's result is refetched
 *   after every completed pull (`puller.pulls`): the desktop rewrites `metadata.json` only when
 *   its manifest hash changes, and that hash does not cover chats or memory, so the manifest
 *   cannot tell whether a bin changed.
 * - Memory embedding vectors are dropped right after parsing: no UI path returns them.
 */

import type { Core } from '../../core/core'
import type { ChatSession, ChatSessionMeta } from '../../../../src/types/ai'
import type { PagedResult } from '../../../../src/types/pagination'
import { VaultLockedError, getKeyRing, isUnlocked, type KeyRing } from '../keys'
import type { Handler } from '../router'
import type { WebDb } from '../storage/idb'
import type { Puller } from '../sync/pull'
import { readEnv, type VaultApi } from './readSession'

/** Largest device bin the web opens: the WASM `MAX_BIN_BYTES` (memlore-wasm lib.rs). */
export const MAX_DEVICE_BIN_BYTES = 16 * 1024 * 1024

// ---------------------------------------------------------------------------------------------
// Payloads (desktop wire types in src-tauri/src/sync/metadata.rs; only what the web reads)
// ---------------------------------------------------------------------------------------------

/** `ChatAttachmentRef` (src-tauri/src/db/queries.rs): an unknown `kind` is kept as-is. */
export type ChatAttachmentRef =
  | { kind: 'entry'; id: string }
  | { kind: 'period'; start: number; end: number; label?: string }
  | { kind: string }

export interface SyncedChatMessage {
  id: string
  role: string
  content: string
  seq: number
  created_at: number
  model_id?: string | null
  provider_id?: string | null
  endpoint_class?: string | null
  tokens_in?: number | null
  tokens_out?: number | null
  latency_ms?: number | null
  attachments?: ChatAttachmentRef[] | null
  source_entry_ids?: string[] | null
  memory_ids?: string[] | null
}

export interface SyncedChatSession {
  id: string
  title: string | null
  persona: string
  language: string
  created_at: number
  updated_at: number
  is_deleted: boolean
  title_is_ai_generated?: boolean
  used_rag?: boolean
  converted_entry_id?: string | null
  converted_through_seq?: number | null
  pinned_at?: number | null
  messages: SyncedChatMessage[]
}

export interface ChatPayload {
  device_id: string
  generated_at: number
  sessions: SyncedChatSession[]
}

export interface MemorySourceRef {
  source_type: string
  source_id: string
}

/** A memory item without its embedding vectors (dropped on load). */
export interface SyncedMemoryItem {
  id: string
  text: string
  source_type: string
  enabled: boolean
  is_deleted: boolean
  created_at: number
  updated_at: number
  sources: MemorySourceRef[]
}

export interface SyncedPersona {
  answers_json: string
  traits_text: string
  style_text: string
  enabled: boolean
  user_edited: boolean
  generated_at: number | null
  updated_at: number
}

export interface MemoryPayload {
  items: SyncedMemoryItem[]
  persona: SyncedPersona | null
}

export interface StreakPayload {
  device_id: string
  current_streak: number
  longest_streak: number
  last_entry_date: number | null
  updated_at: number
}

export type DeviceBinKind = 'chats' | 'memory'

interface PayloadOf {
  chats: ChatPayload
  memory: MemoryPayload
}

/** One flagged desktop's bin: decoded, too large or unreadable (never an empty stand-in). */
export type DeviceBinResult<K extends DeviceBinKind> =
  | { status: 'ok'; device: string; payload: PayloadOf[K] }
  | { status: 'too_large_for_web'; device: string }
  | { status: 'unreadable'; device: string }

// ---------------------------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------------------------

export interface DeviceBinDeps {
  puller: Pick<Puller, 'desktops' | 'readDeviceBin' | 'pulls'>
  db: { files: Pick<WebDb['files'], 'get'> }
  core: Pick<Core, 'openDeviceBin'>
  /** Defaults to the key holder's. */
  isUnlocked?: () => boolean
  getKeyRing?: () => KeyRing
}

export interface DeviceBinLoader {
  /** One result per desktop whose manifest flags the bin; a flagged but missing file is skipped. */
  loadDeviceBin<K extends DeviceBinKind>(kind: K): Promise<Array<DeviceBinResult<K>>>
  /** The cached `streak.bin` of every desktop; a missing or unreadable one is skipped. */
  readStreaks(): Promise<StreakPayload[]>
  /** Drops every decoded result and detaches in-flight loads (call on lock). */
  clear(): void
}

const FLAG: Record<DeviceBinKind, 'chats_present' | 'memory_present'> = {
  chats: 'chats_present',
  memory: 'memory_present',
}

const decoder = new TextDecoder()

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

type Loaded = DeviceBinResult<DeviceBinKind> | null

interface Slot {
  /** `puller.pulls` when the load started. */
  pull: number
  result: Promise<Loaded>
}

export function createDeviceBinLoader(deps: DeviceBinDeps): DeviceBinLoader {
  const { puller, db, core } = deps
  const unlocked = deps.isUnlocked ?? isUnlocked
  const ring = deps.getKeyRing ?? getKeyRing
  /** `<kind>/<device>` to the load for one pull (pending or settled). */
  let slots = new Map<string, Slot>()
  let epoch = 0

  const assertUnlocked = (started: number): void => {
    if (!unlocked() || started !== epoch) throw new VaultLockedError()
  }

  const openJson = (bytes: Uint8Array): unknown =>
    JSON.parse(decoder.decode(core.openDeviceBin(ring(), bytes))) as unknown

  /** Whether a desktop's cached manifest flags the bin, or null when the manifest is unusable. */
  async function manifestFlags(device: string, kind: DeviceBinKind): Promise<boolean | null> {
    const cached = await db.files.get(`${device}/metadata.json`)
    if (cached === undefined) return null
    try {
      const manifest = JSON.parse(decoder.decode(cached.ciphertext)) as unknown
      if (!isRecord(manifest) || typeof manifest.generated_at !== 'number') return null
      return manifest[FLAG[kind]] === true
    } catch {
      return null
    }
  }

  async function download(kind: DeviceBinKind, device: string, started: number): Promise<Loaded> {
    assertUnlocked(started)
    const bytes = await puller.readDeviceBin(`${device}/${kind}.bin`, MAX_DEVICE_BIN_BYTES)
    assertUnlocked(started)
    if (bytes === null) return null
    if (bytes === 'oversize' || bytes.length > MAX_DEVICE_BIN_BYTES) {
      return { status: 'too_large_for_web', device }
    }
    try {
      const value = openJson(bytes)
      const payload = kind === 'chats' ? toChats(value) : toMemory(value)
      return { status: 'ok', device, payload }
    } catch (error) {
      if (error instanceof VaultLockedError) throw error
      // Corrupt or foreign bytes: only this desktop's bin is lost, and it is retried next pull.
      return { status: 'unreadable', device }
    }
  }

  async function loadDeviceBin<K extends DeviceBinKind>(
    kind: K,
  ): Promise<Array<DeviceBinResult<K>>> {
    const started = epoch
    assertUnlocked(started)
    const loads = puller.desktops.manifests.map(async (device): Promise<Loaded> => {
      const present = await manifestFlags(device, kind)
      assertUnlocked(started)
      const key = `${kind}/${device}`
      if (present !== true) {
        slots.delete(key)
        return null
      }
      const pull = puller.pulls
      const current = slots.get(key)
      if (current !== undefined && current.pull === pull) return current.result
      const result = download(kind, device, started)
      const slot: Slot = { pull, result }
      slots.set(key, slot)
      // A failed load is not cached: the next call retries.
      result.catch(() => {
        if (slots.get(key) === slot) slots.delete(key)
      })
      return result
    })
    const results = await Promise.all(loads)
    assertUnlocked(started)
    return results.filter((r): r is DeviceBinResult<K> => r !== null)
  }

  async function readStreaks(): Promise<StreakPayload[]> {
    const started = epoch
    assertUnlocked(started)
    const out: StreakPayload[] = []
    for (const device of puller.desktops.manifests) {
      const cached = await db.files.get(`${device}/streak.bin`)
      assertUnlocked(started)
      if (cached === undefined) continue
      try {
        const streak = toStreak(openJson(cached.ciphertext))
        if (streak !== null) out.push(streak)
      } catch {
        // An unreadable streak file only loses that desktop's streak.
      }
    }
    return out
  }

  return {
    loadDeviceBin,
    readStreaks,
    clear: () => {
      epoch += 1
      slots = new Map()
    },
  }
}

// ---------------------------------------------------------------------------------------------
// Payload shape checks
// ---------------------------------------------------------------------------------------------

function toChats(value: unknown): ChatPayload {
  if (!isRecord(value) || !Array.isArray(value.sessions)) {
    throw new Error('chats.bin is not a chat payload')
  }
  return value as unknown as ChatPayload
}

function toMemory(value: unknown): MemoryPayload {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    throw new Error('memory.bin is not a memory payload')
  }
  const items = (value.items as unknown[]).filter(isRecord).map((item) => {
    // Vectors can be many MB and no UI path returns them: drop them now.
    const { embeddings: _embeddings, ...rest } = item
    return rest as unknown as SyncedMemoryItem
  })
  const persona = isRecord(value.persona) ? (value.persona as unknown as SyncedPersona) : null
  return { items, persona }
}

function toStreak(value: unknown): StreakPayload | null {
  if (
    !isRecord(value) ||
    typeof value.device_id !== 'string' ||
    typeof value.current_streak !== 'number' ||
    typeof value.longest_streak !== 'number' ||
    typeof value.updated_at !== 'number'
  ) {
    return null
  }
  return {
    device_id: value.device_id,
    current_streak: value.current_streak,
    longest_streak: value.longest_streak,
    last_entry_date: typeof value.last_entry_date === 'number' ? value.last_entry_date : null,
    updated_at: value.updated_at,
  }
}

// ---------------------------------------------------------------------------------------------
// Read-only handlers (Phase 5.2-5.4)
// ---------------------------------------------------------------------------------------------
//
// CONFIRMED VISIBLE (fail closed): an entry counts as visible only when the vault serves it
// (`status === 'visible'`: loaded, not locked, invisible, deleted, trashed or in an excluded
// journal). Unknown ids are loaded on demand, at most `MAX_SOURCE_LOADS` per command call; a
// missing, failed or over-the-cap id counts as hidden.

/** Most entries one command call loads to confirm sources. */
export const MAX_SOURCE_LOADS = 20
/** Desktop `CHAT_SESSION_PAGE_SIZE` (src-tauri/src/db/queries.rs). */
const CHAT_SESSION_PAGE_SIZE = 10

/** Wire shapes of src/lib/tauri.ts (`MemoryItemRow`, `PersonaRow`, `StreakInfo`). */
interface MemoryItemRow {
  id: string
  text: string
  sourceType: string
  enabled: boolean
  isDeleted: boolean
  createdAt: number
  updatedAt: number
}

interface PersonaRow {
  answersJson: string
  traitsText: string
  styleText: string
  enabled: boolean
  userEdited: boolean
  generatedAt: number | null
  updatedAt: number
}

interface StreakInfo {
  current_streak: number
  longest_streak: number
  last_entry_date: number | null
}

type WireMessage = ChatSession['messages'][number] & { hiddenReason?: 'locked_source' }

/** `daily_chat_load_session` for a session missing while a desktop's bin is too large. */
export class TooLargeForWebError extends Error {
  readonly code = 'too_large_for_web'
  constructor() {
    super('too_large_for_web: open this on a desktop')
    this.name = 'TooLargeForWebError'
  }
}

/** `daily_chat_load_session` for a session missing while a desktop's bin is unreadable. */
export class UnreadableOnWebError extends Error {
  readonly code = 'unreadable_on_web'
  constructor() {
    super('unreadable_on_web: open this on a desktop')
    this.name = 'UnreadableOnWebError'
  }
}

const EMPTY_PERSONA: PersonaRow = {
  answersJson: '',
  traitsText: '',
  styleText: '',
  enabled: false,
  userEdited: false,
  generatedAt: null,
  updatedAt: 0,
}

/** LWW order: newer `updated_at` wins, a tie goes to the higher device id. */
const newerThan = (a: { at: number; device: string }, b: { at: number; device: string }): boolean =>
  a.at > b.at || (a.at === b.at && a.device > b.device)

async function openBins(): Promise<{ vault: VaultApi; bins: DeviceBinLoader }> {
  const env = readEnv()
  if (!env.isUnlocked()) throw new VaultLockedError()
  const session = await env.session()
  // Primes the index and the manifests the loader reads, and applies the journal exclusions.
  await session.ready()
  if (session.deviceBins === undefined) throw new Error('device bins are unavailable')
  return { vault: session.vault, bins: session.deviceBins }
}

/** Called right before a handler returns: a lock during the awaits must not leak results. */
function assertStillUnlocked(): void {
  if (!readEnv().isUnlocked()) throw new VaultLockedError()
}

/** Desktops whose bin could not be read, so the merge cannot be trusted to be complete. */
interface Gaps {
  tooLarge: boolean
  unreadable: boolean
}

function gapsOf(results: Array<DeviceBinResult<DeviceBinKind>>): Gaps {
  return {
    tooLarge: results.some((r) => r.status === 'too_large_for_web'),
    unreadable: results.some((r) => r.status === 'unreadable'),
  }
}

const incomplete = (gaps: Gaps): boolean => gaps.tooLarge || gaps.unreadable

/** The flags a handler adds so the UI says "open on desktop" instead of showing nothing. */
function gapFlags(gaps: Gaps): { tooLargeForWeb?: true; unreadableOnWeb?: true } {
  return {
    ...(gaps.tooLarge ? { tooLargeForWeb: true as const } : {}),
    ...(gaps.unreadable ? { unreadableOnWeb: true as const } : {}),
  }
}

/** Confirms entry ids against the vault with one load budget per command call. */
function createVisibility(vault: VaultApi): (ids: Iterable<string>) => Promise<Set<string>> {
  let budget = MAX_SOURCE_LOADS
  return async (ids) => {
    const unique = [...new Set(ids)]
    const toLoad = unique.filter((id) => vault.status(id) === 'not-loaded').slice(0, budget)
    if (toLoad.length > 0) {
      budget -= toLoad.length
      try {
        await vault.load(toLoad)
      } catch (error) {
        if (error instanceof VaultLockedError) throw error
        // Offline or unreadable: those sources stay unconfirmed, so hidden.
      }
    }
    return new Set(unique.filter((id) => vault.status(id) === 'visible'))
  }
}

// --- Memory -----------------------------------------------------------------------------------

interface MergedMemory {
  /** Live items (tombstones dropped), sources unioned across desktops. */
  items: SyncedMemoryItem[]
  persona: SyncedPersona | null
  gaps: Gaps
}

const isSourceRef = (value: unknown): value is MemorySourceRef =>
  isRecord(value) && typeof value.source_type === 'string' && typeof value.source_id === 'string'

function mergeMemory(results: Array<DeviceBinResult<'memory'>>): MergedMemory {
  const winners = new Map<string, { at: number; device: string; item: SyncedMemoryItem }>()
  const sources = new Map<string, Map<string, MemorySourceRef>>()
  let persona: { at: number; device: string; value: SyncedPersona } | null = null
  for (const result of results) {
    if (result.status !== 'ok') continue
    const { device, payload } = result
    for (const item of payload.items) {
      if (typeof item.id !== 'string' || typeof item.updated_at !== 'number') continue
      const candidate = { at: item.updated_at, device, item }
      const current = winners.get(item.id)
      if (current === undefined || newerThan(candidate, current)) winners.set(item.id, candidate)
      const refs = sources.get(item.id) ?? new Map<string, MemorySourceRef>()
      const list: unknown[] = Array.isArray(item.sources) ? item.sources : []
      // A malformed ref is dropped; the item is then judged on what remains (fail closed below).
      for (const ref of list.filter(isSourceRef)) {
        refs.set(`${ref.source_type}\u0000${ref.source_id}`, ref)
      }
      sources.set(item.id, refs)
    }
    const p = payload.persona
    if (p !== null && typeof p.updated_at === 'number') {
      const candidate = { at: p.updated_at, device, value: p }
      if (persona === null || newerThan(candidate, persona)) persona = candidate
    }
  }
  const items = [...winners.values()]
    .filter((w) => w.item.is_deleted !== true)
    .map((w) => ({ ...w.item, sources: [...(sources.get(w.item.id)?.values() ?? [])] }))
  return { items, persona: persona?.value ?? null, gaps: gapsOf(results) }
}

type Confirm = (ids: Iterable<string>) => Promise<Set<string>>

/**
 * The items whose provenance is confirmed visible. `journal_entry` sources go through the vault;
 * a `daily_chat` source passes only when its chat session is live and every message of it is
 * shown (`followChats`; otherwise it is hidden, which bounds the chat/memory recursion). Any
 * other source type, or an item with no source at all (provenance unknown), is hidden.
 */
async function visibleMemory(
  items: SyncedMemoryItem[],
  bins: DeviceBinLoader,
  confirm: Confirm,
  followChats: boolean,
): Promise<SyncedMemoryItem[]> {
  const sourceIds = (type: string): string[] =>
    items.flatMap((item) =>
      item.sources.filter((s) => s.source_type === type).map((s) => s.source_id),
    )
  const confirmed = await confirm(sourceIds('journal_entry'))
  const chatIds = new Set(sourceIds('daily_chat'))
  const liveChats =
    followChats && chatIds.size > 0
      ? await fullyVisibleSessions(chatIds, bins, confirm)
      : new Set<string>()
  return items.filter(
    (item) =>
      item.sources.length > 0 &&
      item.sources.every(
        (s) =>
          (s.source_type === 'daily_chat' && liveChats.has(s.source_id)) ||
          (s.source_type === 'journal_entry' && confirmed.has(s.source_id)),
      ),
  )
}

/**
 * The ids among `ids` of live chat sessions whose every message is shown. None while a desktop's
 * `chats.bin` is too large or unreadable: its copy could be a newer tombstone or hold more
 * messages.
 */
async function fullyVisibleSessions(
  ids: Set<string>,
  bins: DeviceBinLoader,
  confirm: Confirm,
): Promise<Set<string>> {
  const merged = mergeChats(await bins.loadDeviceBin('chats'))
  if (incomplete(merged.gaps)) return new Set()
  const sessions = merged.sessions.filter((s) => ids.has(s.session.id))
  const shown = await judgeMessages(
    sessions.flatMap((s) => s.messages),
    bins,
    confirm,
    false,
  )
  return new Set(sessions.filter((s) => s.messages.every(shown)).map((s) => s.session.id))
}

const toMemoryRow = (item: SyncedMemoryItem): MemoryItemRow => ({
  id: item.id,
  text: item.text,
  sourceType: item.source_type,
  enabled: item.enabled,
  isDeleted: false,
  createdAt: item.created_at,
  updatedAt: item.updated_at,
})

const listMemoryItems: Handler = async () => {
  const { vault, bins } = await openBins()
  const merged = mergeMemory(await bins.loadDeviceBin('memory'))
  // A too-large or unreadable desktop may hold a newer tombstone of any item: show none.
  // TODO(later): see docs/LATER.md - the bare array has no room for a too_large_for_web flag.
  const shown = incomplete(merged.gaps)
    ? []
    : await visibleMemory(merged.items, bins, createVisibility(vault), true)
  assertStillUnlocked()
  return shown.sort((a, b) => b.updated_at - a.updated_at).map(toMemoryRow)
}

const getPersona: Handler = async () => {
  const { bins } = await openBins()
  // `SyncedPersona` carries no entry reference (src-tauri/src/sync/metadata.rs): returned as-is.
  const { persona, gaps } = mergeMemory(await bins.loadDeviceBin('memory'))
  const row: PersonaRow & ReturnType<typeof gapFlags> =
    persona === null
      ? { ...EMPTY_PERSONA }
      : {
          answersJson: persona.answers_json,
          traitsText: persona.traits_text,
          styleText: persona.style_text,
          enabled: persona.enabled,
          userEdited: persona.user_edited,
          generatedAt: persona.generated_at ?? null,
          updatedAt: persona.updated_at,
        }
  Object.assign(row, gapFlags(gaps))
  assertStillUnlocked()
  return row
}

// --- Chats ------------------------------------------------------------------------------------

interface MergedSession {
  session: SyncedChatSession
  /** Unioned by id across copies, ordered `(seq, created_at, id)`. */
  messages: SyncedChatMessage[]
  usedRag: boolean
  convertedEntryId: string | null
  convertedThroughSeq: number | null
}

function mergeChats(results: Array<DeviceBinResult<'chats'>>): {
  sessions: MergedSession[]
  gaps: Gaps
} {
  const copies = new Map<
    string,
    Array<{ at: number; device: string; session: SyncedChatSession }>
  >()
  for (const result of results) {
    if (result.status !== 'ok') continue
    for (const session of result.payload.sessions) {
      if (!isRecord(session) || typeof session.id !== 'string') continue
      if (typeof session.updated_at !== 'number') continue
      const list = copies.get(session.id) ?? []
      list.push({ at: session.updated_at, device: result.device, session })
      copies.set(session.id, list)
    }
  }
  const sessions: MergedSession[] = []
  for (const list of copies.values()) {
    list.sort((a, b) => (newerThan(a, b) ? -1 : newerThan(b, a) ? 1 : 0))
    const winner = list[0].session
    if (winner.is_deleted === true) continue
    const messages = new Map<string, SyncedChatMessage>()
    let converted: { id: string | null; seq: number | null } = {
      id: winner.converted_entry_id ?? null,
      seq: winner.converted_through_seq ?? null,
    }
    for (const { session } of list) {
      for (const m of Array.isArray(session.messages) ? session.messages : []) {
        if (!isRecord(m) || typeof m.id !== 'string' || messages.has(m.id)) continue
        // Desktop keeps only these roles (engine.rs); a malformed content is skipped.
        if ((m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string') {
          messages.set(m.id, m)
        }
      }
      const seq = session.converted_through_seq
      if (typeof seq === 'number' && (converted.seq === null || seq > converted.seq)) {
        converted = { id: session.converted_entry_id ?? null, seq }
      }
    }
    sessions.push({
      session: winner,
      messages: [...messages.values()].sort(
        (a, b) =>
          a.seq - b.seq || a.created_at - b.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      ),
      usedRag: list.some((c) => c.session.used_rag === true),
      convertedEntryId: converted.id,
      convertedThroughSeq: converted.seq,
    })
  }
  // Desktop: `pinned_at DESC` (nulls last), `updated_at DESC`, `id DESC`.
  sessions.sort((a, b) => {
    const pa = a.session.pinned_at ?? null
    const pb = b.session.pinned_at ?? null
    if (pa !== pb) {
      if (pa === null) return 1
      if (pb === null) return -1
      return pb - pa
    }
    const byUpdated = b.session.updated_at - a.session.updated_at
    if (byUpdated !== 0) return byUpdated
    return a.session.id < b.session.id ? 1 : a.session.id > b.session.id ? -1 : 0
  })
  return { sessions, gaps: gapsOf(results) }
}

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((v) => typeof v === 'string')

/**
 * Entry ids a message depends on, or null (hidden) when it carries an attachment of an unknown
 * kind or a malformed id list.
 */
function messageEntryIds(m: SyncedChatMessage): string[] | null {
  const sources: unknown = m.source_entry_ids ?? []
  const attachments: unknown = m.attachments ?? []
  if (!isStringArray(sources) || !Array.isArray(attachments)) return null
  const ids = [...sources]
  for (const a of attachments as unknown[]) {
    if (!isRecord(a)) return null
    if (a.kind === 'period') continue
    if (a.kind !== 'entry' || typeof a.id !== 'string') return null
    ids.push(a.id)
  }
  return ids
}

/** Memory ids a message used, or null (hidden) when the list is malformed. */
function messageMemoryIds(m: SyncedChatMessage): string[] | null {
  const ids: unknown = m.memory_ids ?? []
  return isStringArray(ids) ? ids : null
}

/**
 * Decides which messages are shown. Memory ids are judged with the memory rule: an id outside the
 * set of visible memory items (hidden, tombstoned or unknown) hides the message, and while any
 * desktop's `memory.bin` is too large or unreadable every memory id hides it (that desktop may
 * hold a newer tombstone). `memory.bin` is only loaded when a message references a memory item.
 * `followChats` is passed to `visibleMemory` (false inside a `daily_chat` provenance check).
 */
async function judgeMessages(
  messages: SyncedChatMessage[],
  bins: DeviceBinLoader,
  confirm: Confirm,
  followChats = true,
): Promise<(m: SyncedChatMessage) => boolean> {
  const entryIds = messages.flatMap((m) => messageEntryIds(m) ?? [])
  const confirmed = await confirm(entryIds)
  const memoryIds = new Set(messages.flatMap((m) => messageMemoryIds(m) ?? []))
  let visibleMemoryIds = new Set<string>()
  if (memoryIds.size > 0) {
    const merged = mergeMemory(await bins.loadDeviceBin('memory'))
    const referenced = incomplete(merged.gaps)
      ? []
      : merged.items.filter((item) => memoryIds.has(item.id))
    const shown = await visibleMemory(referenced, bins, confirm, followChats)
    visibleMemoryIds = new Set(shown.map((i) => i.id))
  }
  return (m) => {
    const ids = messageEntryIds(m)
    const memory = messageMemoryIds(m)
    if (ids === null || memory === null || !ids.every((id) => confirmed.has(id))) return false
    return memory.every((id) => visibleMemoryIds.has(id))
  }
}

/**
 * Ids of AI-titled sessions with a hidden message: the title may summarize the hidden text, so
 * it is blanked and never matched by search.
 */
async function blankedTitles(
  sessions: MergedSession[],
  bins: DeviceBinLoader,
  confirm: Confirm,
): Promise<Set<string>> {
  const ai = sessions.filter((s) => s.session.title_is_ai_generated === true)
  if (ai.length === 0) return new Set()
  const shown = await judgeMessages(
    ai.flatMap((s) => s.messages),
    bins,
    confirm,
  )
  return new Set(ai.filter((s) => !s.messages.every(shown)).map((s) => s.session.id))
}

/** The session title, or null when it is missing or malformed. */
const titleOf = (s: SyncedChatSession): string | null =>
  typeof s.title === 'string' ? s.title : null

/** The session's converted entry id when that entry is confirmed visible, else null. */
const convertedIfVisible = (s: MergedSession, visible: Set<string>): string | null =>
  s.convertedEntryId !== null && visible.has(s.convertedEntryId) ? s.convertedEntryId : null

function toWireMessage(m: SyncedChatMessage, shown: boolean): WireMessage {
  const role = m.role as WireMessage['role']
  if (!shown) {
    return {
      id: m.id,
      role,
      content: '',
      seq: m.seq,
      createdAt: m.created_at,
      attachments: [],
      sourceEntryIds: null,
      memoryIds: null,
      hiddenReason: 'locked_source',
    }
  }
  return {
    id: m.id,
    role,
    content: m.content,
    seq: m.seq,
    createdAt: m.created_at,
    modelId: m.model_id ?? null,
    providerId: m.provider_id ?? null,
    endpointClass: (m.endpoint_class ?? null) as WireMessage['endpointClass'],
    tokensIn: m.tokens_in ?? null,
    tokensOut: m.tokens_out ?? null,
    latencyMs: m.latency_ms ?? null,
    attachments: (m.attachments ?? null) as WireMessage['attachments'],
    sourceEntryIds: m.source_entry_ids ?? null,
    memoryIds: m.memory_ids ?? null,
  }
}

const toMeta = (
  s: MergedSession,
  blanked: Set<string>,
  visibleEntries: Set<string>,
): ChatSessionMeta => ({
  id: s.session.id,
  title: blanked.has(s.session.id) ? null : titleOf(s.session),
  createdAt: s.session.created_at,
  updatedAt: s.session.updated_at,
  messageCount: s.messages.length,
  usedRag: s.usedRag,
  pinnedAt: s.session.pinned_at ?? null,
  convertedEntryId: convertedIfVisible(s, visibleEntries),
})

/** Desktop `normalize_chat_search_text`: lowercase, Latin/Vietnamese diacritics folded. */
function normalizeChatSearchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[đð]/g, 'd')
    .replace(/ø/g, 'o')
    .replace(/ł/g, 'l')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
}

/** Desktop `chat_search_is_subsequence`. */
function isSubsequence(query: string, candidate: string): boolean {
  const chars = [...query]
  let i = 0
  for (const c of candidate) {
    if (i < chars.length && c === chars[i]) i += 1
  }
  return i === chars.length
}

const listSessionsPaged: Handler = async ({ page, query }) => {
  const { vault, bins } = await openBins()
  const merged = mergeChats(await bins.loadDeviceBin('chats'))
  const pageNo = Math.max(1, Math.trunc(Number(page) || 1))
  const trimmed = typeof query === 'string' ? query.trim() : ''
  const confirm = createVisibility(vault)
  let matching = merged.sessions
  if (trimmed !== '') {
    const q = normalizeChatSearchText(trimmed)
    const titleHit = (s: MergedSession): boolean => {
      const title = titleOf(s.session)
      return title !== null && isSubsequence(q, normalizeChatSearchText(title))
    }
    const blanked = await blankedTitles(merged.sessions.filter(titleHit), bins, confirm)
    const byTitle = (s: MergedSession): boolean => !blanked.has(s.session.id) && titleHit(s)
    const rest = merged.sessions.filter((s) => !byTitle(s))
    const candidates = rest.flatMap((s) =>
      s.messages.filter((m) => isSubsequence(q, normalizeChatSearchText(m.content))),
    )
    // Only content the user may see can match: a hit on hidden text would reveal it exists.
    const shown = await judgeMessages(candidates, bins, confirm)
    const hits = new Set(candidates.filter(shown).map((m) => m.id))
    matching = merged.sessions.filter((s) => byTitle(s) || s.messages.some((m) => hits.has(m.id)))
  }
  const offset = (pageNo - 1) * CHAT_SESSION_PAGE_SIZE
  const pageItems = matching.slice(offset, offset + CHAT_SESSION_PAGE_SIZE)
  const blanked = await blankedTitles(pageItems, bins, confirm)
  const converted = await confirm(
    pageItems.flatMap((s) => (s.convertedEntryId === null ? [] : [s.convertedEntryId])),
  )
  const result: PagedResult<ChatSessionMeta> & ReturnType<typeof gapFlags> = {
    items: pageItems.map((s) => toMeta(s, blanked, converted)),
    total: matching.length,
    ...gapFlags(merged.gaps),
  }
  assertStillUnlocked()
  return result
}

const loadSession: Handler = async ({ sessionId }) => {
  const { vault, bins } = await openBins()
  const merged = mergeChats(await bins.loadDeviceBin('chats'))
  const found = merged.sessions.find((s) => s.session.id === String(sessionId))
  if (found === undefined) {
    if (merged.gaps.tooLarge) throw new TooLargeForWebError()
    if (merged.gaps.unreadable) throw new UnreadableOnWebError()
    throw new Error('AI_DAILY_CHAT_SESSION_NOT_FOUND')
  }
  const confirm = createVisibility(vault)
  const shown = await judgeMessages(found.messages, bins, confirm)
  const titleHidden = found.session.title_is_ai_generated === true && !found.messages.every(shown)
  const converted = await confirm(found.convertedEntryId === null ? [] : [found.convertedEntryId])
  const result: ChatSession & ReturnType<typeof gapFlags> = {
    id: found.session.id,
    title: titleHidden ? null : titleOf(found.session),
    persona: found.session.persona,
    language: found.session.language,
    createdAt: found.session.created_at,
    updatedAt: found.session.updated_at,
    messages: found.messages.map((m) => toWireMessage(m, shown(m))),
    convertedEntryId: convertedIfVisible(found, converted),
    convertedThroughSeq: found.convertedThroughSeq,
    ...gapFlags(merged.gaps),
  }
  assertStillUnlocked()
  return result
}

// --- Streak -----------------------------------------------------------------------------------

/**
 * The newest desktop's current streak; the longest streak is the max across desktops (a
 * high-water mark, like desktop's ratchet). Zeros when no desktop has one. The web cannot
 * recompute from the whole history, so `recalculate_streak` answers the same.
 */
const getStreak: Handler = async () => {
  const { bins } = await openBins()
  let newest: StreakPayload | null = null
  let longest = 0
  for (const s of await bins.readStreaks()) {
    longest = Math.max(longest, s.longest_streak, s.current_streak)
    const candidate = { at: s.updated_at, device: s.device_id }
    if (
      newest === null ||
      newerThan(candidate, { at: newest.updated_at, device: newest.device_id })
    ) {
      newest = s
    }
  }
  assertStillUnlocked()
  return {
    current_streak: newest?.current_streak ?? 0,
    longest_streak: longest,
    last_entry_date: newest?.last_entry_date ?? null,
  } satisfies StreakInfo
}

export const deviceBinHandlers: Record<string, Handler> = {
  daily_chat_list_sessions_paged: listSessionsPaged,
  daily_chat_load_session: loadSession,
  list_memory_items: listMemoryItems,
  get_persona: getPersona,
  get_streak: getStreak,
  recalculate_streak: getStreak,
}
