import { invoke } from '@tauri-apps/api/core'
import { emitMediaChanged } from './mediaEvents'
import { toUint8Array } from './toUint8Array'
import type {
  Entry,
  CreateEntryParams,
  EmotionKey,
  EmotionScore,
  SearchResult,
  SearchFilters,
  SemanticHit,
} from '../types/entry'
import type { Journal, Tag } from '../types/journal'
import type { Reminder, WeekdayMask } from '../types/reminder'
import type { Template } from '../types/template'
import type { LocationAlias } from '../types/location'
import type { MapPin } from '../types/map'
import type { GeocodeSuggestion } from '../types/geocoding'
import type {
  AIEmbedProviderConfigInput,
  AIFeature,
  AIFullSettings,
  AIGenProviderConfigInput,
  AIImageProviderConfigInput,
  AIMemoryEmbedProviderConfigInput,
  AIMemoryGenProviderConfigInput,
  AIProvidersConfig,
  BackfillStatus,
  EmbeddingIndexStats,
  EmbeddingSyncDecisionsResponse,
  MigrationOutcome,
  ResolveEmbeddingSyncDecisionArgs,
  ResolveEmbeddingSyncDecisionResult,
  PeriodReviewKind,
  PeriodReviewResult,
  ProviderCredential,
  SetCredentialOutcome,
  SetProviderResult,
  SlotTestResult,
  TestCredentialOutcome,
} from '../types/ai'

// Note: Tauri 2 #[tauri::command] applies camelCase renaming by default via serde.
// Rust snake_case param names (e.g. journal_id) become camelCase (journalId) on the JS side.

// Journals
export const listJournals = (activeVaultId: string | null = null): Promise<Journal[]> =>
  invoke('list_journals', { activeVaultId })
export const getJournal = (
  id: string,
  activeVaultId: string | null = null,
): Promise<Journal | null> => invoke('get_journal', { id, activeVaultId })

/** Create a journal. `autoTagIds` (optional, defaults to no auto-apply
 *  tags) lists the tag ids automatically attached to every new entry
 *  created in this journal. */
export const createJournal = (
  name: string,
  color?: string,
  autoTagIds: string[] = [],
): Promise<Journal> =>
  invoke('create_journal', {
    payload: { name, color, autoTagIds },
  })

/** Update a journal. `autoTagIds` is optional:
 *  - `undefined` → leave the auto-apply set unchanged.
 *  - `string[]`  → replace the set with exactly this list (empty array
 *                  clears auto-apply entirely).
 *  The backend distinguishes the two cases via serde's default-skip
 *  behaviour: an omitted `autoTagIds` key decodes to `None` and is
 *  left as-is, while `[]` decodes to `Some(vec![])` and clears. */
export const updateJournal = (
  id: string,
  name: string,
  color?: string,
  autoTagIds?: string[],
): Promise<Journal> => {
  const payload: Record<string, unknown> = { id, name, color }
  if (autoTagIds !== undefined) {
    payload.autoTagIds = autoTagIds
  }
  return invoke('update_journal', { payload })
}

export const deleteJournal = (id: string): Promise<void> => invoke('delete_journal', { id })

/** Return the tags currently configured as auto-apply for `journalId`,
 *  ordered by tag name ASC. */
export const listJournalAutoTags = (journalId: string): Promise<Tag[]> =>
  invoke('list_journal_auto_tags', { journalId })

// Entries
export type LockedView = 'hidden' | 'covered' | 'revealed'

/// Return non-deleted entries whose entry_date falls on the given (month, day)
/// in any year, across every journal, newest first. Used by the "On This Day"
/// throwback view. Requires the app to be unlocked — the backend rejects
/// out-of-range month/day values.
export const listOnThisDay = (
  month: number,
  day: number,
  lockedView: LockedView = 'revealed',
  activeVaultId: string | null = null,
): Promise<Entry[]> => invoke('list_on_this_day', { month, day, lockedView, activeVaultId })
export const countEntriesInJournal = (journalId: string): Promise<number> =>
  invoke('count_entries_in_journal', { journalId })
export const getEntry = (id: string, activeVaultId: string | null = null): Promise<Entry | null> =>
  invoke('get_entry', { id, activeVaultId })
export const createEntry = (params: CreateEntryParams): Promise<Entry> =>
  invoke('create_entry', {
    journalId: params.journal_id,
    title: params.title,
    contentText: params.content_text,
    previewText: params.preview_text,
    entryDate: params.entry_date,
  })
export const updateEntry = (
  id: string,
  title?: string,
  contentText?: string,
  previewText?: string,
): Promise<Entry> => invoke('update_entry', { id, title, contentText, previewText })
export const softDeleteEntry = (id: string): Promise<void> => invoke('soft_delete_entry', { id })
export const toggleFavorite = (id: string): Promise<boolean> => invoke('toggle_favorite', { id })
export const updateEntryEmotion = (id: string, emotion: EmotionKey | null): Promise<Entry> =>
  invoke('update_entry_emotion', { id, emotion })

/** Per-day emotion lookup for `year`. Returns `(date_iso, emotion)` pairs,
 * one per tagged day (most-recently-updated wins for multi-entry days).
 * Days without any emotion-tagged entry are omitted. Used by the Calendar
 * month-view dot indicator and the Stats year-long emotion heatmap. */
export const getEmotionByDate = (
  year: number,
  lockedView: LockedView = 'revealed',
  activeVaultId: string | null = null,
): Promise<Array<[string, EmotionKey]>> =>
  invoke('get_emotion_by_date', { year, lockedView, activeVaultId })

// Entry content (Yjs binary blobs)
// Tauri 2 serializes Vec<u8> as a JSON number array.
// Pass bytes as number[] (Array.from(uint8Array)) to Rust.
// Receive as number[] then convert: new Uint8Array(arr).
export const saveEntryContent = (
  id: string,
  yjsDoc: number[],
  contentText: string,
  previewText: string,
): Promise<void> => invoke('save_entry_content', { id, yjsDoc, contentText, previewText })

export const getEntryContent = (
  id: string,
  activeVaultId: string | null = null,
): Promise<number[] | null> => invoke('get_entry_content', { id, activeVaultId })

// Tags
export const listTags = (activeVaultId: string | null = null): Promise<Tag[]> =>
  invoke('list_tags', { activeVaultId })
export const createTag = (name: string, color?: string): Promise<Tag> =>
  invoke('create_tag', { name, color })
export const deleteTag = (id: string): Promise<void> => invoke('delete_tag', { id })

/**
 * Update tag name and/or color. Omit a field to keep its current value.
 * Pass `color: null` to clear the color back to "no color".
 *
 * Wire shape: the Rust command takes a single `payload` struct, so we wrap
 * here. `color === null` survives as JSON `null` (the backend uses a
 * `double_option` deserializer to distinguish "absent" from "null").
 */
export const updateTag = (
  id: string,
  patch: { name?: string; color?: string | null },
): Promise<Tag> => invoke('update_tag', { payload: { id, ...patch } })
export const addTagToEntry = (entryId: string, tagId: string): Promise<void> =>
  invoke('add_tag_to_entry', { entryId, tagId })
export const removeTagFromEntry = (entryId: string, tagId: string): Promise<void> =>
  invoke('remove_tag_from_entry', { entryId, tagId })
export const getTagsForEntry = (
  entryId: string,
  activeVaultId: string | null = null,
): Promise<Tag[]> => invoke('get_tags_for_entry', { entryId, activeVaultId })
export const getTagsForEntries = (
  entryIds: string[],
  activeVaultId: string | null = null,
): Promise<Record<string, Tag[]>> => invoke('get_tags_for_entries', { entryIds, activeVaultId })

/**
 * Fetch all tags with their non-deleted entry counts.
 * Rust returns `Vec<(Tag, u64)>` which serialises as `Array<[Tag, number]>`.
 */
export const getTagsWithCounts = (
  activeVaultId: string | null = null,
): Promise<Array<[Tag, number]>> => invoke('get_tags_with_counts', { activeVaultId })

// Settings
export const getSetting = (key: string): Promise<string | null> => invoke('get_setting', { key })
export const setSetting = (key: string, value: string): Promise<void> =>
  invoke('set_setting', { key, value })
export const deleteSetting = (key: string): Promise<void> => invoke('delete_setting', { key })

// Second lock
export const secondLockStatus = (): Promise<boolean> => invoke('second_lock_status')
export const setSecondLockPassword = (password: string): Promise<void> =>
  invoke('set_second_lock_password', { password })
export const changeSecondLockPassword = (oldPassword: string, newPassword: string): Promise<void> =>
  invoke('change_second_lock_password', { oldPassword, newPassword })
export const verifySecondLockPassword = (password: string): Promise<boolean> =>
  invoke('verify_second_lock_password', { password })
export const disableSecondLock = (password: string): Promise<void> =>
  invoke('disable_second_lock', { password })
export const setEntryLocked = (entryId: string, locked: boolean): Promise<void> =>
  invoke('set_entry_locked', { entryId, locked })
export const setJournalLocked = (journalId: string, locked: boolean): Promise<void> =>
  invoke('set_journal_locked', { journalId, locked })

// Invisible lock (multi-vault)
/** Open matching vault or create a new empty vault. Returns vault id only
 *  (never whether matched vs created — deniability). */
export const openOrCreateInvisibleVault = (password: string): Promise<string> =>
  invoke('open_or_create_invisible_vault', { password })
/** Change password for an open vault. Returns the vault id to keep open
 *  (may differ after merge into another vault that already uses `new`). */
export const changeInvisibleVaultPassword = (
  vaultId: string,
  current: string,
  newPassword: string,
): Promise<string> =>
  invoke('change_invisible_vault_password', {
    vaultId,
    current,
    new: newPassword,
  })
/** Delete vaults with zero entries and zero journals. No counts returned. */
export const removeEmptyInvisibleVaults = (): Promise<void> =>
  invoke('remove_empty_invisible_vaults')
/** Mark entry invisible into `activeVaultId` (required when invisible=true). */
export const setEntryInvisible = (
  entryId: string,
  invisible: boolean,
  activeVaultId: string | null = null,
): Promise<void> => invoke('set_entry_invisible', { entryId, invisible, activeVaultId })
/** Mark journal invisible into `activeVaultId` (required when invisible=true). */
export const setJournalInvisible = (
  journalId: string,
  invisible: boolean,
  activeVaultId: string | null = null,
): Promise<void> => invoke('set_journal_invisible', { journalId, invisible, activeVaultId })

// Custom Google Fonts
export interface DownloadedFont {
  family: string
  weight: number
  localPath: string
}

export interface FontCacheStats {
  usedBytes: number
  fontCount: number
}

/** One font family from the Google Fonts catalog cache. */
export interface GoogleFontCatalogEntry {
  family: string
  category: string
  /** All variants reported by the API, e.g. ["regular", "700", "italic"]. */
  variants: string[]
  /** Map from variant key to TTF download URL (e.g. { regular: "https://..." }). */
  files: Record<string, string>
}

/** Metadata about the Google Fonts catalog cache. */
export interface GoogleFontCatalogMeta {
  /** Unix timestamp (seconds) of last successful fetch; null if never fetched. */
  fetchedAt: number | null
  /** Number of families currently in the cache. */
  count: number
}

export const downloadGoogleFont = (
  family: string,
  weight: number,
  url?: string,
): Promise<DownloadedFont> => invoke('download_google_font', { family, weight, url })

export const getFontCacheStats = (): Promise<FontCacheStats> => invoke('get_font_cache_stats')

export const clearFontCache = (): Promise<FontCacheStats> => invoke('clear_font_cache')

/** Fetch the Google Fonts catalog from the API and store it in SQLite. */
export const refreshGoogleFontsCatalog = (): Promise<GoogleFontCatalogMeta> =>
  invoke('refresh_google_fonts_catalog')

/** Search the cached catalog by family name substring (empty query → empty list). */
export const searchGoogleFontsCatalog = (
  query: string,
  limit = 100,
): Promise<GoogleFontCatalogEntry[]> => invoke('search_google_fonts_catalog', { query, limit })

/** Return the catalog metadata (last fetch timestamp and count). */
export const getGoogleFontsCatalogMeta = (): Promise<GoogleFontCatalogMeta> =>
  invoke('get_google_fonts_catalog_meta')

// Search
export const searchEntries = (
  query: string,
  filters?: SearchFilters,
  lockedView: LockedView = 'revealed',
  activeVaultId: string | null = null,
): Promise<SearchResult[]> =>
  invoke('search_entries', { query, filters, lockedView, activeVaultId })

export const semanticSearch = (
  query: string,
  limit: number,
  filters?: SearchFilters,
  lockedView: LockedView = 'revealed',
  activeVaultId: string | null = null,
): Promise<SemanticHit[]> =>
  invoke('semantic_search', { query, limit, filters, lockedView, activeVaultId })

/** Hot-swap the active embedding backend behind the indexer's
 * `SwappableEmbedder`. Called when the user opts in to Semantic
 * Search OR Emotion Suggestions and the embedding model is installed
 * — without this, the indexer stays on `StubEmbedder` and every
 * downstream cosine call returns near-zero, so suggestions never
 * surface (top score below the 0.4 threshold).
 *
 * Returns the now-active model id on success. Errors:
 * `AI_MODEL_NOT_FOUND`, `AI_MODEL_NOT_INSTALLED`, or runtime errors
 * from the ONNX loader. */
// `initEmbeddingService` / `disposeEmbeddingService` were the on-device
// session lifecycle commands shipped with Phase 6 v1. The pivot to external
// providers (R2) replaced session-loading with stateless HTTP, so the
// frontend wrappers are gone. The backend stubs remain (`commands::ai`)
// only for backwards-compatible IPC handler-list stability and will be
// removed once R4–R10 finish migrating their consumers.

/** Cosine-rank the entry's embedding against 8 prototype emotion
 * prompts. Returns `null` when no prototype scores above the
 * suggestion threshold (entry vector is too dissimilar from every
 * emotion). Used by the EmotionPicker's "Suggested" chip. */
export const suggestEmotion = (entryId: string): Promise<EmotionScore | null> =>
  invoke('suggest_emotion', { entryId })

/** Start a streaming title suggestion for an entry (Phase 6 v2 R6).
 *  Returns immediately once the backend has spawned the streaming
 *  task; tokens stream via `ai:suggest-title-token` events keyed by
 *  `entry_id`. Final string arrives in `ai:suggest-title-complete`;
 *  errors surface as `ai:suggest-title-error`; user-cancelled streams
 *  emit `ai:suggest-title-cancelled`. The promise rejects on
 *  precondition errors (provider unconfigured, privacy not accepted,
 *  toggle off via `AI_TITLE_SUGGESTIONS_DISABLED`). */
export const suggestTitle = (entryId: string): Promise<void> => invoke('suggest_title', { entryId })

/** Cancel an in-flight `suggest_title` stream for `entry_id`. Returns
 *  `true` if a stream was actually running, `false` otherwise. */
export const cancelSuggestion = (entryId: string): Promise<boolean> =>
  invoke('cancel_suggestion', { entryId })

// ─── Phase 6 v2 R7 — Entry highlights ───────────────────────────────────────

/** Cached AI highlights row for an entry. `markdown` is `null` when
 *  the entry has never had highlights generated, OR when a content
 *  edit invalidated the prior cache (the save-path UPDATE in
 *  `db::queries::save_entry_content` wipes the triplet whenever
 *  `content_text` changes). */
export interface EntryHighlights {
  entryId: string
  markdown: string | null
  generatedAt: number | null
  modelId: string | null
}

/** Read the cached highlights for an entry. Returns `null` when the
 *  entry doesn't exist; returns an `EntryHighlights` row with
 *  `markdown: null` when the entry exists but has no cached
 *  highlights. */
export const getEntryHighlights = (
  entryId: string,
  activeVaultId: string | null = null,
): Promise<EntryHighlights | null> => invoke('get_entry_highlights', { entryId, activeVaultId })

/** Wipe the cached highlights triplet. Idempotent. */
export const clearEntryHighlights = (entryId: string): Promise<void> =>
  invoke('clear_entry_highlights', { entryId })

/** Generate (or re-generate) AI highlights for an entry. With
 *  `force=false` and a cache hit for the active provider's chat
 *  model, the backend emits a synthetic `ai:highlights-complete`
 *  event with `from_cache: true` and skips the HTTP call. With
 *  `force=true`, always re-generates. The promise resolves once the
 *  backend has spawned the streaming task; tokens stream via
 *  `ai:highlights-token` events keyed by `entry_id`. */
export const generateEntryHighlights = (entryId: string, force = false): Promise<void> =>
  invoke('generate_entry_highlights', { entryId, force })

/** Generate a summary capped at `maxWords` words. Reuses the same
 * model + single-flight gate as `suggestTitle`; available for future
 * stats / persona work. */
export const summariseEntry = (entryId: string, maxWords: number): Promise<string | null> =>
  invoke('summarise_entry', { entryId, maxWords })

// ─── Phase 6 v2 R10 — image gen + multi-entry summary ──────────────────────

export interface GenerateImageResult {
  mediaId: string
  localPath: string
  /** Where the media row was saved: editor body (`inline`) or strip (`attached`). */
  insertionMode: MediaInsertionMode
}

/** Generate an image from a prompt and save it on the entry.
 *  Goes through the same `save_media_to_media_dir` pipeline as
 *  `pickImage` / `savePastedImage`, so the resulting bytes are encrypted,
 *  thumbnailed, and queued for cloud sync — identical to a user-uploaded
 *  image. `insertionMode` defaults to `"attached"` (strip only); pass
 *  `"inline"` to also insert a TipTap image node at the caret. */
export const generateInlineImage = async (
  entryId: string,
  prompt: string,
  size?: string,
  insertionMode: MediaInsertionMode = 'attached',
): Promise<GenerateImageResult> => {
  const result = await invoke<GenerateImageResult>('generate_inline_image', {
    entryId,
    prompt,
    size,
    insertionMode,
  })
  emitMediaChanged()
  return result
}

/** Generate an AI summary for an arbitrary set of entries.
 *  Returns plain markdown — caller is responsible for rendering.
 *  `mode = 'truncate'` applies a per-entry soft cap (48 KB total);
 *  `mode = 'raw'` sends full content up to the 1 MB hard cap.
 *  Backend errors: `AI_MULTI_ENTRY_SUMMARY_DISABLED`, `AI_NO_ENTRIES`,
 *  `AI_NO_ENTRIES_WITH_CONTENT`, `AI_PAYLOAD_TOO_LARGE`. */
export const summariseEntries = (entryIds: string[], mode: 'truncate' | 'raw'): Promise<string> =>
  invoke('summarise_entries', { entryIds, mode })

/** Generate a structured weekly/monthly period review for `[start, end)`.
 *  Set `regenerate` to bypass the `ai_reviews` cache. */
export const generatePeriodReview = (
  start: number,
  end: number,
  kind: PeriodReviewKind,
  regenerate = false,
): Promise<PeriodReviewResult> => invoke('generate_period_review', { start, end, kind, regenerate })

/** Read a stored weekly/monthly review for `[start, end)`. No provider,
 *  privacy, or toggle gates — miss returns `null`. */
export const getPeriodReview = (
  start: number,
  end: number,
  kind: PeriodReviewKind,
): Promise<PeriodReviewResult | null> => invoke('get_period_review', { start, end, kind })

/** Generate recurring themes + mood drivers for a date range. Cached in
 *  `ai_reviews` with `kind = 'insights'`. */
export const generateThemeInsights = (
  start: number,
  end: number,
  regenerate = false,
): Promise<import('../types/ai').ThemeInsightsResult> =>
  invoke('generate_theme_insights', { start, end, regenerate })

/** Read a stored theme-insights row for `[start, end)`. No provider,
 *  privacy, or toggle gates — miss returns `null`. */
export const getCachedThemeInsights = (
  start: number,
  end: number,
): Promise<import('../types/ai').ThemeInsightsResult | null> =>
  invoke('get_cached_theme_insights', { start, end })

// ─── Phase 6 v2 R9 — Daily Chat ─────────────────────────────────────────────

/** Stream one assistant turn for the Daily Chat view. The backend
 *  loads the session's prior messages from the DB, resolves the
 *  attachment + auto-RAG context via `resolve_chat_context`, persists
 *  the new `userText` (+ `attachments`) as a `user` row, then streams
 *  the assistant reply. Tokens arrive via `ai:daily-chat-token` events
 *  keyed by `turnId`. The final text arrives in `ai:daily-chat-complete`;
 *  errors surface as `ai:daily-chat-error`; cancellation as
 *  `ai:daily-chat-cancelled`. Cancel via
 *  `cancelSuggestion("daily-chat:" + turnId)`.
 *
 *  Rejects with `AiError::ChatContextRefused` when the resolved context
 *  either can't fit (`period_too_large` / `period_no_budget` /
 *  `consent_required`) or crosses the warn threshold without
 *  `oversizeConfirmed: true` (`needs_confirmation`) — that string is the
 *  refusal's own raw JSON, parseable straight into `ChatContextRefusal`
 *  (see `useDailyChat`'s `parseChatContextRefusal`). `oversizeConfirmed`
 *  never raises the hard caps; it only accepts a plan the backend has
 *  already trimmed and flagged for confirmation (README decision 17 —
 *  the oversize gate lives here, not in the frontend, because the
 *  client's preflight estimate is debounced and may be stale). */
export const dailyChatSendTurn = (
  sessionId: string,
  turnId: string,
  userText: string,
  attachments: import('../types/ai').ChatAttachmentRef[],
  oversizeConfirmed = false,
): Promise<void> =>
  invoke('daily_chat_send_turn', { sessionId, turnId, userText, attachments, oversizeConfirmed })

/** Shape returned by the convert-chat-to-entry IPC calls. `throughSeq`
 *  is the highest persisted assistant message seq consumed by the
 *  conversion — the caller can later persist it via
 *  {@link dailyChatMarkConverted} so a re-convert skips already-saved
 *  turns. */
export interface ConvertChatResult {
  markdown: string
  throughSeq: number
}

/** Convert the persisted session into a polished first-person journal
 *  entry markdown. Single non-streaming chat call; the result is
 *  returned and the user accepts via the normal `create_entry` +
 *  `save_entry_content` pipeline. */
export const convertChatToEntry = (sessionId: string): Promise<ConvertChatResult> =>
  invoke('convert_chat_to_entry', { sessionId })

/** Like {@link convertChatToEntry} but only drafts the assistant turns
 *  persisted since the last conversion (seq > the stored
 *  `converted_through_seq`). Returns the delta markdown and the new
 *  high-water seq. */
export const convertChatDeltaToEntry = (sessionId: string): Promise<ConvertChatResult> =>
  invoke('convert_chat_delta_to_entry', { sessionId })

/** Record that `entryId` is now the entry produced from `sessionId`,
 *  with `throughSeq` as the highest consumed assistant seq. Subsequent
 *  delta converts and the entry↔chat link state read from this. */
export const dailyChatMarkConverted = (
  sessionId: string,
  entryId: string,
  throughSeq: number,
): Promise<void> => invoke('daily_chat_mark_converted', { sessionId, entryId, throughSeq })

/** Resolve the chat session that produced `entryId`, if any. Returns
 *  `null` when the entry has no linked session. */
export const chatSessionForEntry = (
  entryId: string,
): Promise<{ sessionId: string; title: string | null } | null> =>
  invoke('chat_session_for_entry', { entryId })

// ─── Phase 6 v2 R9 v2 — Persistent chat sessions ────────────────────────────

/** Load a single chat session with its full message history. */
export const dailyChatLoadSession = (
  sessionId: string,
): Promise<import('../types/ai').ChatSession> => invoke('daily_chat_load_session', { sessionId })

/** Delete a chat session and its messages (CASCADE). */
export const dailyChatDeleteSession = (sessionId: string): Promise<void> =>
  invoke('daily_chat_delete_session', { sessionId })

/** Set a new title on a chat session. Empty / whitespace-only titles
 *  are rejected; titles longer than 80 chars are truncated. */
export const dailyChatRenameSession = (sessionId: string, title: string): Promise<void> =>
  invoke('daily_chat_rename_session', { sessionId, title })

/** Pin or unpin a chat session. Pinned sessions sort above the rest;
 *  the backend stamps `pinned_at` (epoch seconds) or clears it to NULL. */
export const dailyChatSetSessionPinned = (sessionId: string, pinned: boolean): Promise<void> =>
  invoke('daily_chat_set_session_pinned', { sessionId, pinned })

/** Fire-and-forget: ask the backend to generate an AI title for the
 *  session. Idempotent — backend short-circuits if already generated.
 *  On success the backend emits `dc:title-updated`. */
export const dailyChatGenerateTitle = (sessionId: string): Promise<void> =>
  invoke('daily_chat_generate_title', { sessionId })

// ─── RAG in Daily Chat — attachment picker + context preflight ─────────────
//
// NOTE: the three commands below (`chat_search_attachable_entries`,
// `chat_count_entries_in_range`, `chat_rag_preflight`) do not exist on the
// backend yet — they land in Phase 4. Declared here ahead of time so
// Phase 5's hooks have a stable surface to compile against.

/** One row returned by the attachment picker's Entries tab. Mirrors
 *  Rust's `AttachableEntry { id, title, entry_date }`. Locked and
 *  invisible entries are excluded server-side, with no `LockedView`
 *  override — the picker never shows them. */
export interface ChatAttachableEntry {
  id: string
  title: string | null
  entryDate: number
}

/** Result of `chat_count_entries_in_range` — backs the "N entries" line
 *  shown in the Date tab before the user commits to a period attachment.
 *  Same locked/invisible exclusions as `ChatAttachableEntry`. */
export interface ChatEntriesInRangeCount {
  entryCount: number
  totalBytes: number
}

/** Search (or, for an empty query, list the most recent) entries eligible
 *  for attachment to a Daily Chat turn. */
export const chatSearchAttachableEntries = (
  query: string,
  limit: number,
): Promise<ChatAttachableEntry[]> => invoke('chat_search_attachable_entries', { query, limit })

/** Count entries (and their total content size) inside `[start, end)` —
 *  `start` inclusive, `end` exclusive, Unix seconds — for the Date tab's
 *  pre-commit entry count. */
export const chatCountEntriesInRange = (
  start: number,
  end: number,
): Promise<ChatEntriesInRangeCount> => invoke('chat_count_entries_in_range', { start, end })

/** Metadata-only preflight for the context a turn would inject — same
 *  underlying `resolve_chat_context` the real send path uses, so the
 *  estimate never drifts from what actually ships. Display only: it is
 *  never what decides whether a send proceeds (see `dailyChatSendTurn`). */
export const chatRagPreflight = (
  attachments: import('../types/ai').ChatAttachmentRef[],
  question: string,
): Promise<import('../types/ai').ChatContextPreflight> =>
  invoke('chat_rag_preflight', { attachments, question })

// ─── Phase 6 v2 R8 — Go Deeper prompts ──────────────────────────────────────

/** Generate 3-5 short reflection prompts for the entry. Non-streaming
 *  — the backend makes a single chat call, parses the JSON response
 *  (with newline-split fallback), and returns the array. The
 *  frontend must already gate the call on:
 *    1. `aiGoDeeperEnabled` true
 *    2. provider configured + privacy accepted
 *    3. entry word-count ≥80
 *  but the backend re-validates each gate — the IPC surface is the
 *  trust boundary. */
export const goDeeper = (
  entryId: string,
  lens?: import('../types/ai').ReflectionLens | null,
): Promise<string[]> => invoke('go_deeper', { entryId, lens: lens ?? null })

/** Rewrite live selected editor prose. The backend validates `entryId` for
 * visibility/privacy but intentionally receives the unsaved selection text. */
export const rewriteSelection = (entryId: string, selectedText: string): Promise<string> =>
  invoke('rewrite_selection', { entryId, selectedText })

/** Continue from the current live editor context and return prose to append. */
export const continueWriting = (entryId: string, context: string): Promise<string> =>
  invoke('continue_writing', { entryId, context })

/** Suggest tags for an entry from its text. Returns tag name strings. */
export const suggestTags = (entryId: string): Promise<string[]> =>
  invoke('suggest_tags', { entryId })

// Crypto (Authentication)
export const verifyPassword = (password: string): Promise<boolean> =>
  invoke('verify_password', { password })
export const changePassword = (oldPassword: string, newPassword: string): Promise<void> =>
  invoke('change_password', { oldPassword, newPassword })

// Crypto — Password-only encryption model

// ─── First-time setup (Phase 2 — per-device password sync-chain) ─────────────

/**
 * Returned by `begin_first_time_setup`.
 * The backend picks 4 random challenge indices into the mnemonic for the
 * confirmation step.
 */
export interface FirstTimeSetupHandle {
  setup_id: string
  mnemonic: string[]
  challenge_indices: number[]
}

/**
 * Step 1 of first-time setup: generates a master key + 24-word recovery
 * mnemonic and writes a pending row to the local DB. Returns the mnemonic and
 * 4 random challenge indices so the frontend can show the reveal screen.
 * Does NOT upload anything yet — upload happens on confirm.
 */
export const beginFirstTimeSetup = (
  password: string,
  deviceName: string,
): Promise<FirstTimeSetupHandle> => invoke('begin_first_time_setup', { password, deviceName })

/**
 * How this device unlocks the vault, as accepted by the backend's
 * `resolve_unlock_method_with_os_kek` (`commands/crypto.rs`).
 *
 * - `password` — password KEK only.
 * - `os_kek`   — accepted by the backend but it resolves to the SAME state as
 *                `both`: setup always writes the password wrap too. Never sent
 *                by the UI, which uses `both` so the string matches reality.
 * - `both`     — OS keystore key (Touch ID) **plus** the password fallback.
 *
 * There is deliberately no value that leaves a device without a password:
 * cancelling the biometric prompt must always fall back to typing it.
 */
export type UnlockMethod = 'password' | 'os_kek' | 'both'

/**
 * Step 2: validate the 4 challenge word answers + re-entered password, then
 * finalise key derivation, re-key SQLCipher, and (if Drive is connected) upload
 * the V2 keyring files. Deletes the pending row on success.
 *
 * `unlockMethod` is optional; omitted means password-only (backend default).
 */
export const confirmFirstTimeSetup = (
  setupId: string,
  answers: string[],
  password: string,
  sessionId?: string,
  unlockMethod?: UnlockMethod,
): Promise<void> =>
  invoke('confirm_first_time_setup', {
    setupId,
    answers,
    password,
    sessionId: sessionId ?? null,
    unlockMethod: unlockMethod ?? null,
  })

/**
 * Cancel the pending setup: wipes the pending row + revealed mnemonic.
 * Call when the user explicitly backs out before confirming.
 */
export const cancelFirstTimeSetup = (setupId: string): Promise<void> =>
  invoke('cancel_first_time_setup', { setupId })

/**
 * Crash-recovery probe: returns the pending setup handle if one exists from a
 * previous interrupted run (app was killed between begin and confirm), or null.
 */
export const getPendingFirstTimeSetup = (): Promise<FirstTimeSetupHandle | null> =>
  invoke('get_pending_first_time_setup')

// ─── Recovery sheet (Phase 4 Group A) ────────────────────────────────────────

/**
 * Render a self-contained, printable recovery sheet for `mnemonic` (the 24
 * words, space-separated). Returns PDF bytes: the words as text plus a QR of
 * the same string embedded from raw pixels (no bundled font, no external
 * asset).
 *
 * The command never touches disk — the caller picks the destination via the
 * native save dialog and writes the bytes (see `useRecoverySheet`). The
 * mnemonic is always an argument, never a lookup: the backend only holds it
 * during the short pending-setup window and clears it on confirmation
 * (`commands/recovery_sheet.rs` module docs).
 *
 * Rust returns `Vec<u8>`, which crosses the IPC boundary as `number[]` — see
 * the Entry-content note above — so it is converted here.
 */
export const renderRecoverySheet = (mnemonic: string): Promise<Uint8Array> =>
  invoke<number[]>('render_recovery_sheet', { mnemonic }).then((bytes) => new Uint8Array(bytes))

/**
 * Decode the 24-word phrase out of a recovery-sheet QR image the user picked
 * in the native open dialog.
 *
 * The backend reads the file itself: this app ships no `tauri-plugin-fs`, and
 * adding a generic "read any file" command just to feed
 * `decode_recovery_qr_image` would hand the webview an arbitrary-file-read
 * primitive. Only the decoded phrase crosses the IPC boundary.
 *
 * The result is BIP39-valid but **unverified against the vault** — the caller
 * must still run it through `onboardValidatePassphrase` (see
 * `commands/recovery_sheet.rs` module docs).
 */
export const decodeRecoveryQrFile = (path: string): Promise<string> =>
  invoke('decode_recovery_qr_file', { path })

/**
 * Encryption mode values returned by the `get_encryption_mode` Tauri command.
 * Matches the Rust `EncryptionMode` serde output (lowercase strings).
 */
export type EncryptionMode = 'unset' | 'password'

/**
 * Startup branch captured in Tauri `.setup()` via `startup_init`.
 * Matches Rust `StartupMode` serde (`snake_case`).
 */
export type StartupMode = 'first_launch' | 'password_locked' | 'boot_file_corrupt'

/**
 * Returns the current encryption mode:
 * - `'unset'`    — no mode chosen yet; fresh install, onboarding needed.
 * - `'password'` — password-locked; shows LockScreen.
 */
export const getEncryptionMode = (): Promise<EncryptionMode> => invoke('get_encryption_mode')

/**
 * Returns the startup branch:
 * - `'first_launch'`       — fresh install / onboarding
 * - `'password_locked'`    — normal password vault (LockScreen)
 * - `'boot_file_corrupt'`  — boot sidecar invalid; vault intact, recovery UI
 *
 * Not safe to cache across the session: unlike `getEncryptionMode`, this can
 * change while the app is running — `recoverWithPassphrase` flips the
 * backend value from `'boot_file_corrupt'` to `'password_locked'` on a
 * successful recovery (see `mark_startup_recovered` in `commands/crypto.rs`),
 * so any later caller re-probing this must see the updated value, not a
 * stale one from earlier in the session.
 */
export const getStartupMode = (): Promise<StartupMode> => invoke('get_startup_mode')

// Crypto (Encryption)
export async function initializeEncryption(password: string): Promise<void> {
  return invoke('initialize_encryption', { password })
}
/**
 * Reset a forgotten password using the 24-word recovery phrase. Works fully
 * offline (no Google Drive). Unlocks the app on success.
 */
export async function recoverWithPassphrase(
  recoveryMnemonic: string,
  newPassword: string,
): Promise<void> {
  return invoke('recover_with_passphrase', { recoveryMnemonic, newPassword })
}
export async function lockEncryption(): Promise<void> {
  return invoke('lock_encryption')
}
export async function isEncryptionInitialized(): Promise<boolean> {
  return invoke('is_encryption_initialized')
}

// Keychain (Biometric Unlock)
export const isBiometricAvailable = (): Promise<boolean> => invoke('is_biometric_available')
export const isBiometricUnlockEnabled = (): Promise<boolean> =>
  invoke('is_biometric_unlock_enabled')
export const enableBiometricUnlock = (): Promise<void> => invoke('enable_biometric_unlock')
export const disableBiometricUnlock = (): Promise<void> => invoke('disable_biometric_unlock')
export const unlockWithBiometric = (): Promise<void> => invoke('unlock_with_biometric')

// Media
export interface PickImageResult {
  mediaId: string
  localPath: string
}

/// Alias used by generic media pickers (image, video, and — later — audio).
/// The backend returns the same `{ mediaId, localPath }` shape for every kind.
export type PickMediaResult = PickImageResult

/// Whether a media item is embedded inline in the editor or attached to the
/// entry's attachment strip at the bottom.
export type MediaInsertionMode = 'inline' | 'attached'

export const pickImage = async (
  entryId: string,
  insertionMode?: MediaInsertionMode,
): Promise<PickImageResult | null> => {
  const result = await invoke<PickImageResult | null>('pick_image', { entryId, insertionMode })
  if (result) emitMediaChanged()
  return result
}

/// Open the macOS PHPicker (Photo Library) and save each selected photo.
/// Returns one `PickImageResult` per saved photo; an empty array means the
/// user cancelled. Rejects with an error on non-macOS or bridge failure.
export const pickImagesFromLibrary = async (
  entryId: string,
  insertionMode: MediaInsertionMode,
): Promise<PickImageResult[]> => {
  const results = await invoke<PickImageResult[]>('pick_images_from_library', {
    entryId,
    insertionMode,
  })
  if (results.length > 0) emitMediaChanged()
  return results
}

/// Open a native file picker for a video (`mp4` / `mov` / `webm` / `m4v`),
/// copy it into the media directory, insert a `media` row, and return
/// `{ mediaId, localPath }`. Returns `null` if the user cancelled.
///
/// `insertionMode` mirrors `pickImage`: defaults to `"inline"` on the
/// backend if omitted. Rejects with a `VIDEO_TOO_LARGE:<name>:<mb>` error
/// string when the source clip exceeds the backend cap; callers should
/// parse via {@link parseVideoError}.
export const pickVideo = async (
  entryId: string,
  insertionMode?: MediaInsertionMode,
): Promise<PickMediaResult | null> => {
  const result = await invoke<PickMediaResult | null>('pick_video', { entryId, insertionMode })
  if (result) emitMediaChanged()
  return result
}

/// Result of a multi-clip video pick. `saved` is every clip that was written;
/// `rejected` is each oversized filename. Empty `saved` + empty `rejected`
/// means the user cancelled.
export interface PickVideosResult {
  saved: PickMediaResult[]
  rejected: string[]
}

/// Open the macOS PHPicker filtered to videos and save each selected clip.
/// Empty `saved` + empty `rejected` means the user cancelled. Rejects with
/// `VIDEO_TOO_LARGE:<name>:<mb>` when every clip is over-size, or a
/// bridge-unavailable error on non-macOS.
export const pickVideosFromLibrary = async (
  entryId: string,
  insertionMode: MediaInsertionMode,
): Promise<PickVideosResult> => {
  const result = await invoke<PickVideosResult>('pick_videos_from_library', {
    entryId,
    insertionMode,
  })
  if (result.saved.length > 0) emitMediaChanged()
  return result
}

/// On-demand backfill for a video row whose `thumbnail_path` is missing.
/// Returns `true` when a fresh poster JPEG was extracted and persisted;
/// `false` when no work was needed (already had a thumbnail, not a video,
/// or extraction silently failed). Emits `media-changed` on success so the
/// caller can refetch + re-render.
export const ensureVideoThumbnail = async (mediaId: string): Promise<boolean> => {
  const generated = await invoke<boolean>('ensure_video_thumbnail', { mediaId })
  if (generated) emitMediaChanged()
  return generated
}

/// Open a native multi-file picker for generic (non-media) files. The
/// backend refuses any image/video/audio selection and enforces a 50 MB
/// per-file cap; failures surface as error strings prefixed with
/// `MEDIA_NOT_ALLOWED:` or `FILE_TOO_LARGE:` so the caller can render a
/// localized toast. An empty array means the user cancelled.
export const pickFilesToAttach = async (entryId: string): Promise<PickImageResult[]> => {
  const results = await invoke<PickImageResult[]>('pick_files_to_attach', { entryId })
  if (results.length > 0) emitMediaChanged()
  return results
}

export const resolveMedia = (mediaId: string): Promise<string> =>
  invoke('resolve_media', { mediaId })

/** Download (or fast-path read) the cloud-stored thumbnail JPEG for a media
 *  row and return its local path. Currently has no active UI consumer —
 *  the backend is ready when we wire cloud-only image previews in
 *  `MediaAttachment`. */
export const resolveMediaThumbnail = (mediaId: string): Promise<string> =>
  invoke('resolve_media_thumbnail', { mediaId })

export const savePastedImage = async (
  entryId: string,
  bytes: number[],
  mimeType: string,
  insertionMode?: MediaInsertionMode,
): Promise<PickImageResult> => {
  const result = await invoke<PickImageResult>('save_pasted_image', {
    entryId,
    bytes,
    mime: mimeType,
    insertionMode,
  })
  emitMediaChanged()
  return result
}

export interface MediaStatus {
  mediaId: string
  cachedLocally: boolean
  hasCloudCopy: boolean
  localPath: string | null
  thumbnailPath: string | null
  fileType: string
  /** On-disk byte size of the current file (compressed size once swapped). */
  fileSize: number | null
  /** True when the file was replaced by a smaller background-compressed copy. */
  compressed: boolean
  /**
   * Intrinsic pixel dimensions of the original image, when the backend was
   * able to read them at insert time. Use to set `aspect-ratio` on the
   * loading skeleton so the placeholder reserves the same box the decoded
   * `<img>` will occupy — eliminates layout shift on pop-in. `null` for
   * video/audio, SVG, HEIC, or images inserted before the schema gained
   * these columns (fall back to a fixed-height skeleton).
   */
  width: number | null
  height: number | null
}
export const getMediaStatus = (mediaId: string): Promise<MediaStatus> =>
  invoke('get_media_status', { mediaId })

export const readMediaBytes = (mediaId: string): Promise<number[]> =>
  invoke('read_media_bytes', { mediaId })

/** Copy the decrypted on-disk bytes for `mediaId` to `destPath`. The
 *  frontend drives the native Save As… dialog and passes the chosen
 *  path here. Errors propagate as rejected promises. */
export const exportMediaToPath = (mediaId: string, destPath: string): Promise<void> =>
  invoke('export_media_to_path', { mediaId, destPath })

/** Read THUMBNAIL bytes for the given media id, falling back to the full
 * file when no thumbnail exists on disk. Used by the gallery to keep cell
 * decoding fast — editor and lightbox should use {@link readMediaBytes}
 * for full resolution. */
export const readMediaThumbnailBytes = (mediaId: string): Promise<number[]> =>
  invoke('read_media_thumbnail_bytes', { mediaId })

export interface MediaRow {
  id: string
  entry_id: string
  file_name: string
  file_type: string
  storage_provider: string
  storage_path: string
  thumbnail_path: string | null
  upload_status: string
  uploaded_at: number | null
  file_size: number | null
  cloud_path: string | null
  last_accessed_at: number | null
  sort_order: number
  created_at: number
  exif_date: number | null
  exif_latitude: number | null
  exif_longitude: number | null
  insertion_mode: string
  duration_seconds: number | null
}
export const listMediaForEntry = (
  entryId: string,
  modeFilter?: MediaInsertionMode,
  activeVaultId: string | null = null,
): Promise<MediaRow[]> => invoke('list_media_for_entry', { entryId, modeFilter, activeVaultId })

export const deleteMedia = async (mediaId: string): Promise<void> => {
  await invoke('delete_media', { mediaId })
  emitMediaChanged()
}

export const updateMediaInsertionMode = (
  mediaId: string,
  mode: MediaInsertionMode,
): Promise<void> => invoke('update_media_insertion_mode', { mediaId, mode })

/// Return distinct UTC calendar days (as Unix timestamps) of EXIF dates for
/// all images attached to `entryId`. Used by the multi-date picker suggestion.
export const collectEntryExifDates = (entryId: string): Promise<number[]> =>
  invoke('collect_entry_exif_dates', { entryId })

export interface ExifLocation {
  latitude: number
  longitude: number
}

/// Return one `(latitude, longitude)` pair per distinct EXIF GPS group
/// attached to the entry. Distinctness is computed at ~11m granularity
/// (4 decimal places). Backend command: `collect_entry_exif_locations`.
export const collectEntryExifLocations = (entryId: string): Promise<ExifLocation[]> =>
  invoke('collect_entry_exif_locations', { entryId })

/// One row in the Media Gallery — mirrors the Rust `GalleryMediaRow` struct
/// with `#[serde(rename_all = "camelCase")]`. `storagePath` is a local
/// filesystem path that must be fed to `convertFileSrc` before rendering.
export interface GalleryMediaRow {
  id: string
  entryId: string
  journalId: string
  fileType: string
  storagePath: string
  thumbnailPath: string | null
  cloudPath: string | null
  uploadStatus: string
  createdAt: number
  entryDate: number
  /** Audio playback length, in seconds. `null` for images and for rows
   * that pre-date duration capture. Surfaced so audio tiles in the
   * Media Gallery can render the same "0:23" label as the Attachment
   * Strip in the editor. */
  durationSeconds: number | null
  /** Parent entry's title — `''` when untitled or when the row is a locked placeholder. */
  entryTitle: string
  /** Parent entry's excerpt (`preview_text`) — same redaction rule as `entryTitle`. */
  entryPreview: string
}

/// Paginated list of every media row attached to a non-deleted entry across
/// Returns every pin for the Locations Map — entry-level pins (location label)
/// plus photo-level GPS pins, merged newest-first and soft-capped at 1000 rows
/// in the backend. Requires the app to be unlocked. The backend serializes
/// with `camelCase` renaming, which matches the TS `MapPin` interface verbatim.
export const listMapPins = (
  lockedView: LockedView = 'revealed',
  activeVaultId: string | null = null,
): Promise<MapPin[]> => invoke('list_map_pins', { lockedView, activeVaultId })

/// Overwrite the `entry_date` field on the entry. Called when the user accepts
/// an EXIF date suggestion (silent single-date path) or picks from the modal.
export const updateEntryDate = (id: string, entryDate: number): Promise<void> =>
  invoke('update_entry_date', { id, entryDate })

/// Move an entry to a different journal. Wired up to the right-click
/// "Move to another journal" submenu on each entry card.
export const moveEntryToJournal = (id: string, journalId: string): Promise<void> =>
  invoke('move_entry_to_journal', { id, journalId })

/// Set `entry_date_user_edited = 1` durably so the multi-EXIF date modal
/// no longer auto-pops for this entry. Call after the user (a) manually
/// edits the date pill, (b) confirms a date in the suggestion modal, or
/// (c) closes / cancels the modal. Pure flag-flip — does NOT change the
/// entry's date.
export const markEntryDateUserEdited = (id: string): Promise<void> =>
  invoke('mark_entry_date_user_edited', { id })

// Media cache
export interface MediaCacheStats {
  usedBytes: number
  maxBytes: number
}
export const getMediaCacheStats = (): Promise<MediaCacheStats> => invoke('get_media_cache_stats')
export const setMediaCacheLimit = (bytes: number): Promise<MediaCacheStats> =>
  invoke('set_media_cache_limit', { bytes })
export const clearMediaCache = (): Promise<MediaCacheStats> => invoke('clear_media_cache')

// Media upload size limits. `-1` is the "unlimited" sentinel on both the read
// and the write side — the backend never sends `i64::MAX` across IPC because
// it would lose precision as an f64 and fail to deserialize on the way back.
export interface MediaUploadLimits {
  photoBytes: number
  videoBytes: number
}
export const getMediaUploadLimits = (): Promise<MediaUploadLimits> =>
  invoke('get_media_upload_limits')
export const setMediaUploadLimits = (
  photoBytes: number,
  videoBytes: number,
): Promise<MediaUploadLimits> => invoke('set_media_upload_limits', { photoBytes, videoBytes })

/// Tauri event name emitted whenever the media cache ceiling or usage changes.
/// Payload matches `MediaCacheStats`. Listeners should use `@tauri-apps/api/event`'s
/// `listen(MEDIA_CACHE_STATS_EVENT, ...)`.
export const MEDIA_CACHE_STATS_EVENT = 'media-cache:stats-changed'

// EXIF
export interface ExifData {
  latitude: number | null
  longitude: number | null
  date: number | null
  camera: string | null
}
export const readImageExif = (path: string): Promise<ExifData> =>
  invoke('read_image_exif', { path })

// Weather
export interface WeatherData {
  summary: string
  icon: string
  temperature: number
}

export const fetchWeather = (
  latitude: number,
  longitude: number,
  entryDate?: number,
): Promise<WeatherData> => invoke('fetch_weather', { latitude, longitude, entryDate })

export const updateEntryWeather = (
  id: string,
  weatherSummary: string | null,
  weatherIcon: string | null,
): Promise<Entry> => invoke('update_entry_weather', { id, weatherSummary, weatherIcon })

// Location
export const updateEntryLocation = (
  id: string,
  latitude: number | null,
  longitude: number | null,
  locationLabel: string | null,
  locationAddress: string | null,
): Promise<Entry> =>
  invoke('update_entry_location', { id, latitude, longitude, locationLabel, locationAddress })

// Streaks
export interface StreakInfo {
  current_streak: number
  longest_streak: number
  last_entry_date: number | null
}

export const getStreak = (): Promise<StreakInfo> => invoke('get_streak')
export const recalculateStreak = (): Promise<StreakInfo> => invoke('recalculate_streak')

// Templates
export const listTemplates = (): Promise<Template[]> => invoke('list_templates')
export const getTemplate = (id: string): Promise<Template | null> => invoke('get_template', { id })
export const createTemplate = (
  name: string,
  description?: string,
  content?: number[],
): Promise<Template> => invoke('create_template', { name, description, content })
export const updateTemplate = (
  id: string,
  name: string,
  description?: string,
  content?: number[],
): Promise<Template> => invoke('update_template', { id, name, description, content })
export const deleteTemplate = (id: string): Promise<void> => invoke('delete_template', { id })

// Cloud sync providers. Google Drive keeps the historical `gdrive_*` IPC
// names; iCloud / local folder use `icloud_availability` + `cloud_folder_connect`.
export type CloudProviderKind = 'gdrive' | 'icloud' | 'local'

export interface IcloudAvailability {
  available: boolean
  path: string
}

export const icloudAvailability = (): Promise<IcloudAvailability> => invoke('icloud_availability')

// Google Drive (Chunk 4)
export interface GDriveStatus {
  connected: boolean
  email?: string
  /** Account-wide Google Drive usage (all services sharing the quota). */
  storageUsed?: number
  storageTotal?: number
  /** Bytes occupied by Memlore in Drive appDataFolder (this app only). */
  storageAppUsed?: number
  lastSync?: number
  /** Persisted sync_provider: 'gdrive' | 'icloud' | 'local'. */
  provider?: string | null
  /** Folder-provider root from sync_config_json. Absent for Drive. */
  rootPath?: string
}

export interface BeginConnectResponse {
  authUrl: string
  sessionId: string
}

/** Typed outcome of `gdrive_complete_connect`. */
export type GdriveConnectOutcome =
  | { outcome: 'ready' }
  | { outcome: 'needs_first_time_setup' }
  | { outcome: 'needs_onboarding' }
  | { outcome: 'needs_force_re_pair'; reason: string; cloud_epoch: number }
  | { outcome: 'v1_wiped_reconnect_required' }

export const gdriveBeginConnect = (): Promise<BeginConnectResponse> =>
  invoke('gdrive_begin_connect')
/**
 * Returns true if the backend successfully removed the pending OAuth
 * session, false if the session was already consumed by a concurrent
 * `gdrive_complete_connect` (or never existed). The caller must respect
 * the false case: if complete already won the race, the connect must
 * be allowed to finish — cancelling the local promise would leave the
 * backend in a connected state while the UI shows disconnected.
 */
export const gdriveCancelConnect = (sessionId: string): Promise<boolean> =>
  invoke('gdrive_cancel_connect', { sessionId })
export const gdriveCompleteConnect = (
  sessionId: string,
  password: string,
): Promise<GdriveConnectOutcome> => invoke('gdrive_complete_connect', { sessionId, password })

export const cloudFolderConnect = (
  sessionId: string,
  provider: 'icloud' | 'local',
  rootPath: string | null,
  password: string,
): Promise<GdriveConnectOutcome> =>
  invoke('cloud_folder_connect', { sessionId, provider, rootPath, password })

/** Validate the 24-word recovery passphrase against the cloud vault (stateless).
 *  Pass `sessionId` when the user arrived via Drive OAuth in Unset mode — the
 *  backend will peek the pending Drive session (NOT consume — `onboard_complete`
 *  consumes it post-rekey) so the cloud read can succeed before any token has
 *  been persisted to the DB. */
export const onboardValidatePassphrase = (mnemonic: string, sessionId?: string): Promise<void> =>
  invoke('onboard_validate_passphrase', { mnemonic, sessionId })

/** Complete new-device onboarding: set local password, upload device slot, unlock.
 *  Pass `sessionId` when the user arrived via Drive OAuth in Unset mode — the
 *  backend will consume the pending Drive session and persist sync settings
 *  atomically with the password flip. Omit (undefined) for the legacy path
 *  used by GoogleDriveSettings.
 *
 *  `unlockMethod` is this device's own choice — it is local, not inherited from
 *  the vault's other devices. Omitted means password-only (backend default). */
export const onboardComplete = (
  mnemonic: string,
  newLocalPassword: string,
  deviceName: string,
  sessionId?: string,
  unlockMethod?: UnlockMethod,
): Promise<void> =>
  invoke('onboard_complete', {
    mnemonic,
    newLocalPassword,
    deviceName,
    sessionId,
    unlockMethod: unlockMethod ?? null,
  })

/**
 * Revoke a device's access to the vault. Triggers a full key rotation:
 * the master key is re-wrapped for remaining devices and all entries
 * are re-encrypted. Other devices will be forced to re-pair.
 */
export const revokeDevice = (
  targetDeviceId: string,
  currentPassword: string,
  recoveryMnemonic: string,
): Promise<void> => invoke('revoke_device', { targetDeviceId, currentPassword, recoveryMnemonic })

/**
 * Remove a peer device from the device list without any key rotation.
 * No credentials required — the device keeps its data and access; it only
 * disappears from the registry. If it syncs again it reappears.
 */
export const removeDevice = (targetDeviceId: string): Promise<void> =>
  invoke('remove_device', { targetDeviceId })

/**
 * Rotate the master key for the current device without revoking a specific
 * device. Appends a new content key epoch and re-wraps the key for all other
 * registered devices (lazy rotation — old cloud envelopes are not re-encrypted).
 *
 * The recovery phrase is UNCHANGED (reuse-current model). The caller must
 * supply the current 24-word phrase so it can be written to `_recovery.json`.
 * Other devices will need to re-pair after this operation.
 */
export const rotateMasterKey = (currentPassword: string, recoveryMnemonic: string): Promise<void> =>
  invoke('rotate_master_key', { currentPassword, recoveryMnemonic })

/**
 * Reset the recovery phrase (Flow G): mint a NEW master key AND a NEW 24-word
 * phrase together, forward-only. Returns the new mnemonic — this is the ONLY
 * surviving copy, because the backend clears the rotation stash in the same
 * transaction that finalises the reset, so `getPendingRotationRecovery` can
 * never hand it back. The caller MUST surface the returned words immediately.
 */
export const resetRecoveryPhrase = (currentPassword: string): Promise<string> =>
  invoke('reset_recovery_phrase', { currentPassword })

/**
 * Retrieve the new 24-word recovery phrase that was generated during the most
 * recent key rotation, if the user has not yet confirmed saving it. Returns
 * `null` once the phrase has been cleared (i.e. after
 * `confirmRotationRecoverySaved` is called, or if no rotation is pending).
 */
export const getPendingRotationRecovery = (): Promise<string | null> =>
  invoke('get_pending_rotation_recovery')

/**
 * Acknowledge that the user has saved the new recovery phrase produced by
 * `rotateMasterKey`. This clears the stashed mnemonic from the database so it
 * is no longer returned by `getPendingRotationRecovery`.
 */
export const confirmRotationRecoverySaved = (): Promise<void> =>
  invoke('confirm_rotation_recovery_saved')

/**
 * Resume an in-progress rotation that was interrupted (e.g. app crash).
 * Returns `true` if rotation was successfully resumed and completed,
 * `false` if there was nothing to resume.
 */
export const resumeRotation = (
  currentPassword: string,
  recoveryMnemonic?: string,
): Promise<boolean> => invoke('resume_rotation', { currentPassword, recoveryMnemonic })

/**
 * Complete force re-pair: re-derive the local device slot from the cloud
 * vault using the recovery mnemonic and set a new local password.
 */
export const completeForceRePair = (
  recoveryMnemonic: string,
  newLocalPassword: string,
): Promise<void> => invoke('complete_force_re_pair', { recoveryMnemonic, newLocalPassword })

/**
 * Read the persisted `force_re_pair_required` flag. Returns the reason string
 * when the vault was rotated on another device and this device has not yet
 * re-paired; returns `null` otherwise.
 *
 * The flag lives in the DB settings table and survives app restarts, so the
 * frontend calls this on mount to hydrate the `useForceRePair` Zustand store.
 * Without the hydration the store reverts to its default after every restart
 * and the user is silently dropped back into the (now-broken) lock-screen
 * flow — see the bug fix note in `useForceRePair.ts`.
 */
export const getForceRePairStatus = (): Promise<string | null> => invoke('get_force_re_pair_status')

/**
 * Re-check the cloud keyring and clear a stale force-re-pair flag if — and only
 * if — the fingerprint positively verifies. Resolves `true` when the flag was
 * cleared (the vault is in sync and the user can proceed), `false` when the flag
 * stands (genuine rotation, or nothing to compare). Rejects on I/O failure, in
 * which case the flag stands.
 *
 * This is the recovery path for a flag written by a transient Drive error: the
 * re-pair screen renders ahead of LockScreen, so the unlock-time reconcile that
 * would otherwise re-evaluate never runs. See `recheck_force_re_pair` in
 * `gdrive.rs` for why this check must not be preceded by a keyring re-upload.
 */
export const recheckForceRePair = (): Promise<boolean> => invoke('recheck_force_re_pair')

export const gdriveDisconnect = (): Promise<void> => invoke('gdrive_disconnect')
/**
 * Wipe the cloud Application Data folder (cascade-delete every file under
 * the Memlore root). The `disconnect` flag controls the local side:
 *   - `true`: also clear OAuth credentials + revoke token. User ends up
 *     in a fresh "not connected" state.
 *   - `false`: keep credentials; reset local `sync_state` rows so the
 *     next sync re-pushes the device's local data into the empty cloud.
 */
export const gdriveWipeCloud = (disconnect: boolean): Promise<void> =>
  invoke('gdrive_wipe_cloud', { disconnect })
export const gdriveGetStatus = (): Promise<GDriveStatus> => invoke('gdrive_get_status')
export const gdriveRefreshStorageQuota = (): Promise<GDriveStatus> =>
  invoke('gdrive_refresh_storage_quota')
export const gdriveTestConnection = (): Promise<boolean> => invoke('gdrive_test_connection')

// ─── Authoritative Google Drive recovery (Phase 4) ───────────────────────────

/** Next step for an interrupted recovery job — matches Rust `SyncRecoveryStep`. */
export type SyncRecoveryStep =
  | 'local_preflight'
  | 'local_rebuild'
  | 'local_finalize'
  | 'cloud_begin_staging'
  | 'cloud_materialize'
  | 'cloud_commit'

/** Failure class for recovery UI enablement — matches Rust `SyncRecoveryErrorClass`. */
export type SyncRecoveryErrorClass = 'retryable' | 'terminal' | 'preflight_blocker'

/**
 * Active/interrupted recovery job snapshot. When non-null, Settings must keep
 * recovery progress visible even if the help disclosure is collapsed, and
 * normal Sync Now controls must stay disabled while `blocksNormalSync` is true.
 */
export interface SyncRecoveryStatus {
  jobId: number
  /** `local_to_cloud` | `cloud_to_local` */
  operation: 'local_to_cloud' | 'cloud_to_local' | string
  phase: string
  status: 'pending' | 'running' | 'failed' | 'completed' | string
  recoveryGeneration: number
  backupPath: string | null
  stagingPath: string | null
  /** Job-row verified_counts JSON (channel/media counts; keys as stored). */
  verifiedCounts: Record<string, unknown>
  lastError: string | null
  isActive: boolean
  blocksNormalSync: boolean
  canResume: boolean
  canCancelSafely: boolean
  nextStep: SyncRecoveryStep | null
  errorClass: SyncRecoveryErrorClass | null
  createdAt: number
  updatedAt: number
}

/** Local-authoritative preflight result (camelCase from Rust). */
export interface LocalAuthoritativePreflightResult {
  jobId: number
  backupPath: string
  stagingPath: string
  mediaTotal: number
  mediaLocal: number
  mediaDownloaded: number
}

export interface LocalAuthoritativeRebuildResult {
  jobId: number
  phase: string
  recoveryGeneration: number
  entriesAdopted: number
  journalsAdopted: number
  mediaPathsBound: number
  mediaReset: number
  versionsReset: number
  pushedEntries: number
  mediaUploaded: number
  versionsUploaded: number
  embeddingBatches: number
  pushErrors: string[]
  keyringPublished: boolean
}

export interface LocalAuthoritativeVerifyResult {
  jobId: number
  phase: string
  status: string
  recoveryGeneration: number
  postReleaseSyncErrors: string[]
}

export interface CloudAuthoritativeStagingResult {
  jobId: number
  backupPath: string
  stagingPath: string
  stagingDbPath: string
  stagingMediaPath: string
  preservedSettingsPath: string
  cloudRecoveryGeneration: number
  jobRecoveryGeneration: number
}

export interface CloudAuthoritativeChannelCount {
  name: string
  records: number
}

export interface CloudAuthoritativeMaterializeResult {
  jobId: number
  channels: CloudAuthoritativeChannelCount[]
  mediaDownloaded: number
  mediaThumbnailsDownloaded: number
  selfOwnedEntries: number
  selfOwnedJournals: number
  peerEntries: number
  peerJournals: number
  pullPulled: number
  pullMerged: number
}

export interface CloudAuthoritativeCommitResult {
  jobId: number
  phase: string
  status: string
  activeDbPath: string
  activeMediaPath: string
  rollbackDbPath: string
  rollbackMediaPath: string
  backupPath: string
  rollbackRetained: boolean
  postCommitSyncRan: boolean
}

/** Event name for recovery status snapshots (null payload = no active job). */
export const SYNC_RECOVERY_STATUS_EVENT = 'sync:recovery-status-changed'

export const getSyncRecoveryStatus = (): Promise<SyncRecoveryStatus | null> =>
  invoke('get_sync_recovery_status')

export const gdriveCancelSyncRecovery = (): Promise<SyncRecoveryStatus> =>
  invoke('gdrive_cancel_sync_recovery')

/** Advance one step of the active recovery job (idempotent re-entry). */
export const gdriveResumeSyncRecovery = (): Promise<SyncRecoveryStatus> =>
  invoke('gdrive_resume_sync_recovery')

export const gdrivePreflightLocalAuthoritativeRecovery =
  (): Promise<LocalAuthoritativePreflightResult> =>
    invoke('gdrive_preflight_local_authoritative_recovery')

export const gdriveRebuildCloudFromLocal = (): Promise<LocalAuthoritativeRebuildResult> =>
  invoke('gdrive_rebuild_cloud_from_local')

export const gdriveFinalizeLocalAuthoritativeRecovery =
  (): Promise<LocalAuthoritativeVerifyResult> =>
    invoke('gdrive_finalize_local_authoritative_recovery')

export const gdriveBeginCloudAuthoritativeStaging = (): Promise<CloudAuthoritativeStagingResult> =>
  invoke('gdrive_begin_cloud_authoritative_staging')

export const gdriveMaterializeCloudAuthoritativeStaging =
  (): Promise<CloudAuthoritativeMaterializeResult> =>
    invoke('gdrive_materialize_cloud_authoritative_staging')

export const gdriveCommitCloudAuthoritativeRestore = (): Promise<CloudAuthoritativeCommitResult> =>
  invoke('gdrive_commit_cloud_authoritative_restore')

// Sync (Chunks 3a + 3c)
export interface SyncStatus {
  enabled: boolean
  configured: boolean
  provider: string | null
  lastSync: number | null
  entriesPending: number
}

/** Current completeness and live progress of a vault catch-up pull. */
export interface SyncCatchupStatus {
  complete: boolean
  pulled: number
  total: number
}

export interface SyncSummary {
  pushed: number
  pulled: number
  merged: number
  errors: string[]
  warnings?: string[]
}

export const getDeviceId = (): Promise<string> => invoke('get_device_id')
export const getSyncStatus = (): Promise<SyncStatus> => invoke('get_sync_status')
export const getSyncCatchupStatus = (): Promise<SyncCatchupStatus> =>
  invoke('get_sync_catchup_status')
export const setSyncEnabled = (enabled: boolean): Promise<void> =>
  invoke('set_sync_enabled', { enabled })
export const syncNow = (): Promise<SyncSummary> => invoke('sync_now')
export const pushEntry = (entryId: string): Promise<void> => invoke('push_entry', { entryId })

// Sync reset (Phase: sync-disconnect-reset-ux)
export interface ResetCounts {
  entries: number
  media: number
  journals: number
}

export interface SyncMaintenanceResult<T> {
  queued: boolean
  result: T | null
}

export const syncResetLocalState = (): Promise<SyncMaintenanceResult<ResetCounts>> =>
  invoke('sync_reset_local_state')
export const syncRepairFromThisDevice = (): Promise<SyncMaintenanceResult<number>> =>
  invoke('sync_repair_from_this_device')

// Scope upgrade (drive.file → drive.appdata migration)
export const getSyncScopeUpgradeRequired = (): Promise<boolean> =>
  invoke('get_sync_scope_upgrade_required')

export const clearSyncScopeUpgradeRequired = (): Promise<void> =>
  invoke('clear_sync_scope_upgrade_required')

/// Tauri event name fired when the backend auto-disconnects a user holding
/// a legacy drive.file token. Payload is empty; the frontend should re-read
/// `getSyncScopeUpgradeRequired()` and render the reconnect banner.
export const SYNC_SCOPE_UPGRADE_EVENT = 'sync:scope-upgrade-required'

// Scheduler-facing settings (Chunk 5)
export interface SyncSettings {
  intervalMinutes: number
  onSave: boolean
  onLaunch: boolean
}

export const getSyncSettings = (): Promise<SyncSettings> => invoke('get_sync_settings')
export const setSyncSettings = (settings: SyncSettings): Promise<void> =>
  invoke('set_sync_settings', { settings })

/**
 * Tauri event name broadcast whenever sync starts, ends, errors, or its
 * status snapshot (pending count / last_sync_at) mutates. Single source
 * of truth for the frontend — the backend emits exactly this string.
 */
export const SYNC_STATUS_EVENT = 'sync:status-changed'

/** Lifecycle phase carried inside the event payload. */
export type SyncPhase = 'idle' | 'syncing' | 'synced' | 'error'

export interface SyncStatusEvent {
  state: SyncPhase
  enabled: boolean
  /** Present on backend events; optional for compatibility with older event fixtures. */
  configured?: boolean
  provider: string | null
  lastSync: number | null
  entriesPending: number
  error: string | null
}

/** Per-loop-boundary progress event.  Separate from {@link SYNC_STATUS_EVENT}. */
export const SYNC_PROGRESS_EVENT = 'sync:progress'

/** Scheduler retry-backoff event. Payload `retry_at_ms` is null when cleared. */
export const SYNC_RETRY_SCHEDULED_EVENT = 'sync:retry-scheduled'

export interface SyncRetryScheduledPayload {
  retry_at_ms: number | null
}

/** Granular sync phase — matches the Rust `SyncProgressPhase` kebab-case serde output. */
export type SyncProgressPhase =
  | 'pushing-journals'
  | 'pushing-media'
  | 'pushing-entries'
  | 'pushing-versions'
  | 'pushing-settings'
  | 'pushing-tags'
  | 'pushing-templates'
  | 'pushing-locations'
  | 'pushing-chats'
  | 'pushing-streak'
  | 'pushing-ai-audit'
  | 'pulling-manifests'
  | 'pulling-tags'
  | 'pulling-journals'
  | 'pulling-entries'
  | 'pulling-versions'
  | 'pulling-settings'
  | 'pulling-templates'
  | 'pulling-locations'
  | 'pulling-chats'
  | 'pulling-streak'
  | 'pulling-ai-audit'

/** Payload emitted on every meaningful loop boundary during a push/pull cycle. */
export interface SyncProgressEvent {
  phase: SyncProgressPhase
  current: number
  total: number
}

// Location Aliases
export const createLocationAlias = (
  label: string,
  address: string,
  latitude: number,
  longitude: number,
  radiusMeters?: number,
): Promise<LocationAlias> =>
  invoke('create_location_alias', { label, address, latitude, longitude, radiusMeters })

export const listLocationAliases = (): Promise<LocationAlias[]> => invoke('list_location_aliases')

export const getLocationAlias = (id: string): Promise<LocationAlias | null> =>
  invoke('get_location_alias', { id })

export const updateLocationAlias = (
  id: string,
  label: string,
  address: string,
  latitude: number,
  longitude: number,
  radiusMeters?: number,
): Promise<LocationAlias> =>
  invoke('update_location_alias', { id, label, address, latitude, longitude, radiusMeters })

export const deleteLocationAlias = (id: string): Promise<void> =>
  invoke('delete_location_alias', { id })

export const findNearbyAliases = (latitude: number, longitude: number): Promise<LocationAlias[]> =>
  invoke('find_nearby_aliases', { latitude, longitude })

// Audio Recording (Chunk D1)

export interface StopRecordingResult {
  tempPath: string
  durationSeconds: number
}

/// Start recording from the default microphone. Returns a session UUID that
/// must be passed to `stopRecording` to stop capture and flush the WAV file.
export const startRecording = (): Promise<string> => invoke('start_recording')

/// Stop the active recording session identified by `sessionId`.
/// Returns the path to the temporary WAV file and its duration in seconds.
export const stopRecording = (sessionId: string): Promise<StopRecordingResult> =>
  invoke('stop_recording', { sessionId })

/// Move the temporary WAV file from `tempPath` into the entry's media directory,
/// insert a `media` DB row, and return `{ mediaId, localPath }`.
export const saveAudioMemo = async (
  entryId: string,
  tempPath: string,
  durationSeconds: number,
): Promise<PickMediaResult> => {
  const result = await invoke<PickMediaResult>('save_audio_memo', {
    entryId,
    tempPath,
    durationSeconds,
  })
  emitMediaChanged()
  return result
}

/// Read the bytes of a temp WAV file so the frontend can build a Blob URL for
/// preview playback. The temp dir is outside the Tauri asset-protocol scope,
/// so `convertFileSrc(tempPath)` cannot be used directly.
export const readAudioMemoBytes = (tempPath: string): Promise<number[]> =>
  invoke('read_audio_memo_bytes', { tempPath })

/// Delete a temp WAV file the user chose to discard (Cancel in the recorder).
export const discardAudioMemo = (tempPath: string): Promise<void> =>
  invoke('discard_audio_memo', { tempPath })

/// Snapshot the most recent audio levels as `bucketCount` RMS values in
/// `[0, 1]`, oldest → newest. Used to drive the live waveform animation.
export const getRecordingLevels = (bucketCount: number): Promise<number[]> =>
  invoke('get_recording_levels', { bucketCount })

// Export (E1/E2)

export type ExportFormat = 'memlore_json' | 'markdown' | 'plain_text'

export type ExportScope =
  | { kind: 'all' }
  | { kind: 'journal'; journal_id: string }
  | { kind: 'date_range'; start: number; end: number }

export interface ExportSummary {
  entryCount: number
  journalCount: number
  tagCount: number
  mediaCount: number
  mediaSkipped: number
}

export const exportData = (
  dest: string,
  format?: ExportFormat,
  scope?: ExportScope,
): Promise<ExportSummary> => invoke('export_data', { dest, format, scope })

export const writeMarkdownZip = (dest: string, entries: [string, string][]): Promise<number> =>
  invoke('write_markdown_zip', { dest, entries })

// Import (E3)

export type ImportFormat =
  | 'memlore_zip'
  | 'markdown_folder'
  | 'plain_text_folder'
  | 'dayone_zip'
  | 'journey_zip'
  | 'apple_journal_folder'

export type ImportMode = 'merge_newer' | 'replace_all'

export interface ImportWarning {
  kind: string
  message: string
  /** Structured conversion feature when known (e.g. `font-color`, `asset-type:livephoto`). */
  feature?: string
}

export interface AppleImportReport {
  entriesImported: number
  entriesFailed: number
  resourcesReferenced: number
  resourcesImported: number
  resourcesMissing: number
  resourcesUnsupported: number
  resourcesUnreferenced: number
  entriesSkippedExact?: number
  entriesSourceChanged?: number
}

export interface ImportSummary {
  imported: number
  skippedDuplicates: number
  errors: string[]
  warnings?: ImportWarning[]
  apple?: AppleImportReport
}

export type AppleJournalDatePolicy = 'html_visible'
export type AppleJournalDatePrecision = 'date_only'

export interface AppleJournalImportOptions {
  conversionTimezone?: string
  expectedSourceHash?: string
}

export interface AppleJournalImportPreview {
  sourceHash: string
  conversionTimezone: string
  datePolicy: AppleJournalDatePolicy
  datePrecision: AppleJournalDatePrecision
  clockIsSynthetic: boolean
  entries: number
  resourcesReferenced: number
  resourcesWouldImport: number
  resourcesMissing: number
  resourcesUnsupported: number
  resourcesUnreferenced: number
  warnings: ImportWarning[]
}

export const importData = (
  src: string,
  format: ImportFormat,
  mode: ImportMode,
  journalId?: string | null,
  options?: AppleJournalImportOptions,
): Promise<ImportSummary> => {
  const payload: {
    src: string
    format: ImportFormat
    mode: ImportMode
    journalId?: string | null
    options?: AppleJournalImportOptions
  } = { src, format, mode, journalId }
  if (options !== undefined) {
    payload.options = options
  }
  return invoke('import_data', payload)
}

export const previewAppleJournalImport = (
  src: string,
  options?: AppleJournalImportOptions,
): Promise<AppleJournalImportPreview> => invoke('preview_apple_journal_import', { src, options })

/** Suggested file name in the save dialog. Not localised — it is a file name. */
export const APPLE_JOURNAL_IMPORT_REPORT_FILENAME = 'memlore-apple-journal-import-report.txt'

/** Write a user-chosen Apple Journal import report. Rust refuses dest-inside-source. */
export const writeAppleJournalImportReport = (
  dest: string,
  text: string,
  source: string,
): Promise<void> => invoke('write_apple_journal_import_report', { dest, text, source })

// Dev-only demo seeder lives in `./seedDemoData` (imported only by
// SeedDemoCard under `import.meta.env.DEV`) so production never ships it.

// Stats (Chunk S1/S2)

export interface EntriesOverTimePoint {
  period_start: string
  count: number
}

export interface MoodHistogramRow {
  emotion: string
  count: number
}

export interface MoodTrendPoint {
  day: string
  sample_count: number
}

export interface EmotionTrendBucket {
  period_start: string
  bad_count: number
  neutral_count: number
  good_count: number
  total_count: number
}

export interface TagFrequencyRow {
  tag_id: string
  tag_name: string
  count: number
}

export interface WritingVolumePoint {
  period_start: string
  total_words: number
  entry_count: number
}

export interface StreakCalendarDay {
  date: string
  entry_count: number
}

export const statsEntriesOverTime = (
  period: string,
  range: number,
): Promise<EntriesOverTimePoint[]> => invoke('stats_entries_over_time', { period, range })

export const statsMoodHistogram = (rangeDays: number): Promise<MoodHistogramRow[]> =>
  invoke('stats_mood_histogram', { rangeDays })

export const statsMoodTrend = (rangeDays: number): Promise<MoodTrendPoint[]> =>
  invoke('stats_mood_trend', { rangeDays })

export const statsEmotionTrend = (
  period: 'day' | 'week',
  rangeDays: number,
): Promise<EmotionTrendBucket[]> => invoke('stats_emotion_trend', { period, rangeDays })

export const statsTagFrequency = (): Promise<TagFrequencyRow[]> => invoke('stats_tag_frequency')

export const statsWritingVolume = (period: string, range: number): Promise<WritingVolumePoint[]> =>
  invoke('stats_writing_volume', { period, range })

export const statsStreakCalendar = (year: number): Promise<StreakCalendarDay[]> =>
  invoke('stats_streak_calendar', { year })

export interface LocationPoint {
  lat: number
  lng: number
  count: number
}

export const statsLocationDensity = (): Promise<LocationPoint[]> => invoke('stats_location_density')

// Geocoding
export const geocodeSearch = (
  query: string,
  limit?: number,
  sessionToken?: string,
): Promise<GeocodeSuggestion[]> => invoke('geocode_search', { query, limit, sessionToken })

export const geocodeResolve = (
  placeId: string,
  sessionToken?: string,
): Promise<GeocodeSuggestion> => invoke('geocode_resolve', { placeId, sessionToken })

/// Reverse-geocode a lat/lng pair into a readable label using the
/// configured provider. Returns `null` when the provider has no match
/// or when Google Places is configured (its reverse endpoint isn't
/// wired up — callers fall back to raw coordinates).
export const geocodeReverse = (
  latitude: number,
  longitude: number,
): Promise<GeocodeSuggestion | null> => invoke('geocode_reverse', { latitude, longitude })

/**
 * Probe a geocoding provider with a fixed test query to verify it's
 * reachable and the API key (if any) is accepted. Resolves on success;
 * rejects with one of the stable error codes (`missing_api_key`,
 * `invalid_key`, `rate_limited`, `network_error`, `server_error`,
 * `invalid_response`).
 */
export const geocodeCheck = (provider: string, apiKey?: string): Promise<void> =>
  invoke('geocode_check', { provider, apiKey })

// Reminders
export const listReminders = (): Promise<Reminder[]> => invoke('list_reminders')

export const createReminder = (
  label: string,
  timeOfDay: string,
  weekdays: WeekdayMask,
): Promise<Reminder> => invoke('create_reminder', { label, timeOfDay, weekdays })

export const updateReminder = (
  id: string,
  label: string,
  timeOfDay: string,
  weekdays: WeekdayMask,
  enabled: boolean,
): Promise<Reminder> => invoke('update_reminder', { id, label, timeOfDay, weekdays, enabled })

export const deleteReminder = (id: string): Promise<void> => invoke('delete_reminder', { id })

// AI: detect runtime AI capability (Phase 6 v2 R3 onward — always true post-pivot;
// the only hard requirement is HTTP-capable runtime, which Tauri always has).
export const isAiSupported = (): Promise<boolean> => invoke('is_ai_supported')

// AI backfill (Phase 6 A3b-2) — index existing entries against the active
// embedding model. `start_backfill` returns the snapshot status so the UI
// can render progress immediately; subsequent updates flow through the
// `ai:backfill-progress` / `ai:backfill-complete` event stream.
/// `force=true` wipes existing rows for the active model_id before
/// re-indexing. Use after a model swap, after a bug produced NaN rows,
/// or whenever the user explicitly wants to refresh all embeddings.
export const startBackfill = (force = false): Promise<BackfillStatus> =>
  invoke('start_backfill', { force })
export const pauseBackfill = (): Promise<void> => invoke('pause_backfill')
export const getBackfillStatus = (): Promise<BackfillStatus> => invoke('get_backfill_status')
export const getEmbeddingIndexStats = (): Promise<EmbeddingIndexStats> =>
  invoke('get_embedding_index_stats')

/** Per-status counts from `entry_embedding_jobs` for one model. Distinct
 *  from {@link EmbeddingIndexStats} (indexed/total/pending entries). */
export interface EmbeddingJobStats {
  pending: number
  in_progress: number
  indexed: number
  skipped: number
  error: number
  paused: number
}

export const getEmbeddingJobStats = (modelId: string): Promise<EmbeddingJobStats> =>
  invoke('get_embedding_job_stats', { modelId })

/** Snapshot of entry + memory embed-sync decision receipts (model mismatch,
 *  missing/invalid key, etc.). Mirrors Rust `EmbeddingSyncDecisionsResponse`. */
export const getEmbeddingSyncDecisions = (): Promise<EmbeddingSyncDecisionsResponse> =>
  invoke('get_embedding_sync_decisions')

/** Resolve a pending/paused embed-sync decision for one slot.
 *  Tauri param name is `args` (see `resolve_embedding_sync_decision`). */
export const resolveEmbeddingSyncDecision = (
  args: ResolveEmbeddingSyncDecisionArgs,
): Promise<ResolveEmbeddingSyncDecisionResult> =>
  invoke('resolve_embedding_sync_decision', { args })

/** Snapshot of the Phase 2 background-indexing consent gate. Mirrors the
 *  Rust `BackgroundIndexingSettings` (`#[serde(rename_all = "camelCase")]`)
 *  returned by `get_background_indexing_settings`. `allowed` is a
 *  convenience mirror of `background_indexing_allowed` — `true` iff the
 *  worker may spend a provider call right now. */
export interface BackgroundIndexingSettings {
  enabled: boolean
  hostedConsentAt: number | null
  allowed: boolean
}

export const getBackgroundIndexingSettings = (): Promise<BackgroundIndexingSettings> =>
  invoke('get_background_indexing_settings')

/** Flip the background-indexing master toggle. Does NOT touch hosted
 *  consent — see `set_background_indexing_enabled` on the backend. */
export const setBackgroundIndexingEnabled = (enabled: boolean): Promise<void> =>
  invoke('set_background_indexing_enabled', { enabled })

/** Record acceptance of the hosted token-cost notice for the CURRENT
 *  embedding provider/model. Resolves with the unix-seconds timestamp
 *  stamped by the backend. */
export const acceptBackgroundIndexingHostedConsent = (): Promise<number> =>
  invoke('accept_background_indexing_hosted_consent')

// ─── AI provider config — two-slot API (Phase 6 v2 R11+) ───────────────────

/** Persist + swap the generation (chat + image) provider. Does NOT
 *  cancel in-flight backfill — that's embedding-side. */
export const setAiGenerationProvider = (
  input: AIGenProviderConfigInput,
): Promise<SetProviderResult> => invoke('set_ai_generation_provider', { input })

/** Persist + swap the image-generation provider. Independent of the
 *  generation slot — saving one never touches the other. */
export const setAiImageProvider = (input: AIImageProviderConfigInput): Promise<SetProviderResult> =>
  invoke('set_ai_image_provider', { input })

/** Persist + swap the embedding provider. Cancels in-flight backfill
 *  so the loop stops writing rows under the old model_id. */
export const setAiEmbeddingProvider = (
  input: AIEmbedProviderConfigInput,
): Promise<SetProviderResult> => invoke('set_ai_embedding_provider', { input })

// ─── AI memory provider config (ai-user-memory Phase 2/5) ───────────────────

/** Persist + swap the memory GENERATION provider. Independent of the
 *  app-wide gen slot — writes the `ai_memory_gen_*` rows and swaps
 *  `ProviderRegistry`'s memory_generation slot. Backend enforces the
 *  on-machine class rule (Local | OnDevice only) at write time. */
export const setMemoryGenProvider = (
  input: AIMemoryGenProviderConfigInput,
): Promise<SetProviderResult> => invoke('set_memory_gen_provider', { input })

/** Persist + swap the memory EMBEDDING provider. Independent of the app-wide
 *  embed slot — writes the `ai_memory_embed_*` rows and swaps
 *  `ProviderRegistry`'s memory_embedding slot. Same on-machine class rule. */
export const setMemoryEmbedProvider = (
  input: AIMemoryEmbedProviderConfigInput,
): Promise<SetProviderResult> => invoke('set_memory_embed_provider', { input })

/** Wire shape of `set_memory_allow_hosted`'s reconciled result. */
export interface MemoryAllowHostedResult {
  allowHosted: boolean
  memoryEnabled: boolean
}

/** Atomically persist `ai_memory_allow_hosted` and reconcile the in-memory
 *  registry memory slots against the new value in the same backend call —
 *  turning it off rejects any now-disallowed slot, turning it on re-hydrates
 *  both memory slots from their persisted config. Use this instead of
 *  `setSetting` + `rejectDisallowedMemorySlots` for this key: those two
 *  calls could leave the DB and the registry disagreeing if the second one
 *  ever failed. */
export const setMemoryAllowHosted = (next: boolean): Promise<MemoryAllowHostedResult> =>
  invoke('set_memory_allow_hosted', { next })

// ─── AI memory items management (ai-user-memory Phase 5 T5.3) ────────────────

/** Wire shape of a `memory_items` row, returned by `list_memory_items`.
 *  Mirrors the Rust `MemoryItemRow` (camelCase serde). `isDeleted` is always
 *  `false` here — `list_memory_items` filters tombstones out, but the field
 *  is present on the row for type parity with the backend. */
export interface MemoryItemRow {
  id: string
  text: string
  sourceType: string
  enabled: boolean
  isDeleted: boolean
  createdAt: number
  updatedAt: number
}

/** List every live (non-tombstoned) memory item, newest (`updated_at`) first. */
export const listMemoryItems = (): Promise<MemoryItemRow[]> => invoke('list_memory_items')

/** Edit one memory item's text (re-sanitized server-side; bumps `updated_at`
 *  and wipes stale embeddings atomically inside one transaction). */
export const updateMemoryItemText = (memoryId: string, text: string): Promise<void> =>
  invoke('update_memory_item_text', { memoryId, text })

/** Enable or disable a single memory item (disabled items are hidden from
 *  retrieval without being deleted). */
export const setMemoryEnabled = (memoryId: string, enabled: boolean): Promise<void> =>
  invoke('set_memory_enabled', { memoryId, enabled })

/** Soft-delete (tombstone) a memory item — the row is NOT physically removed;
 *  the tombstone propagates via sync. */
export const deleteMemoryItem = (memoryId: string): Promise<void> =>
  invoke('delete_memory_item', { memoryId })

/** Manually trigger a memory scan pass: content-hash-diff recent sources into
 *  `pending`. Returns the count of sources newly claimed by this pass. The
 *  pass is a no-op (returns 0) when the memory feature isn't enabled. */
export const scanMemories = (): Promise<number> => invoke('scan_memories')

/** Whole-list tidy pass: merge duplicate/near-duplicate memories, synthesize
 *  related fragments, drop trivia — one LLM call per batch on the memory
 *  generation slot. Returns the number of ops applied; 0 when the memory
 *  feature is inactive or there is nothing to tidy. */
export const consolidateMemories = (): Promise<number> => invoke('consolidate_memories_command')

// ─── AI user persona (ai-user-memory Phase 7 T7.5) ─────────────────────────

/** Singleton Build Your Persona document returned by `get_persona`.
 * Interview answers are stored as a JSON object so the upcoming interview
 * modal can preserve stable question keys across translations. */
export interface PersonaRow {
  answersJson: string
  traitsText: string
  styleText: string
  enabled: boolean
  userEdited: boolean
  generatedAt: number | null
  updatedAt: number
}

/** Result of a manual persona build. `styleReady` is false when there are too
 * few privacy-eligible entries to produce a writing-style section. */
export interface PersonaBuildResult {
  styleReady: boolean
}

/** Read the materialized singleton persona document. */
export const getPersona = (): Promise<PersonaRow> => invoke('get_persona')

/** Enable or disable persona injection without changing its contents. */
export const setPersonaEnabled = (enabled: boolean): Promise<void> =>
  invoke('set_persona_enabled', { enabled })

/** Save the fixed, user-authored persona interview. Values are stored as a
 * stable-key JSON object so questionnaire wording/order can change safely. */
export const writePersonaAnswers = (answersJson: string): Promise<void> =>
  invoke('write_persona_answers', { answersJson })

/** Save user-authored edits to both generated sections as one document. */
export const writePersonaUserEdit = (traitsText: string, styleText: string): Promise<void> =>
  invoke('write_persona_user_edit', { traitsText, styleText })

/** Rebuild the persona. `force` may only be true after the UI has confirmed
 * that any user edits to traits/style will be replaced; interview answers are
 * always retained by the backend. */
export const buildPersona = (force: boolean): Promise<PersonaBuildResult> =>
  invoke('build_persona', { force })

/** Read both slots in one round-trip. Each slot is `null` when
 *  unconfigured. API keys never included — each public type carries
 *  `hasApiKey: boolean`. */
export const getAiProviders = (): Promise<AIProvidersConfig> => invoke('get_ai_providers')

/** Wipe the generation slot (7 settings rows + WAL checkpoint). */
export const forgetAiGenerationProvider = (): Promise<void> =>
  invoke('forget_ai_generation_provider')

/** Wipe the image slot (provider + model rows). */
export const forgetAiImageProvider = (): Promise<void> => invoke('forget_ai_image_provider')

/** Wipe the embedding slot. Also cancels in-flight backfill. */
export const forgetAiEmbeddingProvider = (): Promise<void> => invoke('forget_ai_embedding_provider')

/** Test a generation-slot config WITHOUT persisting. Calls
 *  `provider.chat()` with `max_tokens=1` — the chat-shape probe lets
 *  chat-only providers (Claude / Groq / xAI) validate. `dim` is null. */
export const testAiGenerationProvider = (
  input: AIGenProviderConfigInput,
): Promise<SlotTestResult> => invoke('test_ai_generation_provider', { input })

/** Test an embedding-slot config WITHOUT persisting. Calls
 *  `provider.embed(&["test"])`. `dim` is the vector dimension. */
export const testAiEmbeddingProvider = (
  input: AIEmbedProviderConfigInput,
): Promise<SlotTestResult> => invoke('test_ai_embedding_provider', { input })

// ─── Per-preset credential registry (T1.6) ──────────────────────────────────
//
// The Providers-tab-facing surface (Phase 3) that the two-slot save/test
// commands above now resolve `endpoint`/`apiKey` from — see T2.3's
// `resolve_credential` cutover. `ProviderCard` (Phase 2 T2.6) writes/probes
// through these instead of embedding the endpoint/key in the per-slot save.

/** Read every preset's credential row in one shot. Never returns a raw
 *  API key — `hasApiKey: boolean` only, same posture as `getAiProviders`. */
export const getAiProviderCredentials = (): Promise<ProviderCredential[]> =>
  invoke('get_ai_provider_credentials')

/** Set (or replace) a preset's endpoint override and/or API key, then
 *  rebuild + re-swap every `ProviderRegistry` slot currently bound to that
 *  preset. Same `apiKey` tri-state semantics as `AIGenProviderConfigInput`
 *  (`null` = preserve, `""` = clear, non-empty = replace). */
export const setAiProviderCredential = (
  presetId: string,
  endpoint: string,
  apiKey: string | null,
): Promise<SetCredentialOutcome> =>
  invoke('set_ai_provider_credential', { presetId, endpoint, apiKey })

/** Clear both the stored key AND the endpoint override for `presetId`, then
 *  reconcile every bound slot the same way `setAiProviderCredential` does. */
export const forgetAiProviderCredential = (presetId: string): Promise<void> =>
  invoke('forget_ai_provider_credential', { presetId })

/** Transient credential probe using the FORM's live (not-yet-saved)
 *  endpoint/key — never persists anything. `probeModel` is required for
 *  every preset group except `local`. `capability` disambiguates the
 *  `custom` preset between a chat and an embed probe (`'embed'` routes to
 *  the embed probe; omitted/anything else defaults to chat) and is ignored
 *  by every other preset. */
export const testAiProviderCredential = (
  presetId: string,
  endpoint: string,
  apiKey: string | null,
  probeModel?: string,
  capability?: string,
): Promise<TestCredentialOutcome> =>
  invoke('test_ai_provider_credential', { presetId, endpoint, apiKey, probeModel, capability })

/** Wire shape returned by `check_cli_provider_health`. */
export interface CliHealth {
  installed: boolean
  version: string | null
  authenticated: boolean
  binaryPath: string | null
  hint: string | null
}

/** Probe a CLI-backed provider: is it installed AND signed in?
 *  Only valid for `provider in ('claude-cli', 'codex-cli')` — other
 *  ids are rejected. Best-effort; the Settings panel calls this on
 *  preset selection / Recheck button.
 *
 *  The `model` argument is forwarded to Codex's `--model` flag so
 *  the probe matches the user's configured slot (default `gpt-5.4`).
 *  Ignored for Claude — `auth status` doesn't need a model. */
export const checkCliProviderHealth = (provider: string, model?: string): Promise<CliHealth> =>
  invoke('check_cli_provider_health', { provider, model })

// ─── On-device embedding models (Phase 4 Task 2/5) ──────────────────────────

/** Per-model download state — mirrors `OnDeviceModelStateWire`
 *  (`#[serde(tag = "status", rename_all = "snake_case")]`) in
 *  `src-tauri/src/commands/ai_provider.rs`. */
export type OnDeviceModelStateWire =
  | { status: 'not_downloaded' }
  | { status: 'downloading'; progress: number }
  | { status: 'ready' }
  | { status: 'error'; code: string }

/** One on-device catalog entry + its current download state, as returned by
 *  `list_on_device_models`. Mirrors `OnDeviceModelWire`
 *  (`#[serde(rename_all = "camelCase")]`). `supported` is `false` for
 *  catalog entries with no `fastembed` backend yet — every entry in the
 *  current catalog is supported. */
export interface OnDeviceModelWire {
  id: string
  displayName: string
  dim: number
  mrlDims: number[]
  contextLength: number
  downloadSize: string
  approxRam: string
  multilingual: boolean
  recommended: boolean
  whenToChoose: string
  supported: boolean
  state: OnDeviceModelStateWire
}

/** List the on-device model catalog with each entry's current download
 *  state, for the Settings model picker (`useOnDeviceModels`). */
export const listOnDeviceModels = (): Promise<OnDeviceModelWire[]> =>
  invoke('list_on_device_models')

/** Read a single model's download state. */
export const getOnDeviceModelState = (id: string): Promise<OnDeviceModelStateWire> =>
  invoke('get_on_device_model_state', { id })

/** Start (or resume) an opt-in on-device model download. Resolves with the
 *  terminal state once the download finishes or fails; live progress
 *  arrives via the `ai:model-download-progress` event in the meantime. */
export const startOnDeviceModelDownload = (id: string): Promise<OnDeviceModelStateWire> =>
  invoke('start_on_device_model_download', { id })

/** Best-effort cancel of an in-flight download — see
 *  `cancel_on_device_model_download` for why this can't interrupt an
 *  already-blocking fetch call. */
export const cancelOnDeviceModelDownload = (id: string): Promise<OnDeviceModelStateWire> =>
  invoke('cancel_on_device_model_download', { id })

/** Delete a downloaded model's files, freeing disk space. */
export const removeOnDeviceModel = (id: string): Promise<OnDeviceModelStateWire> =>
  invoke('remove_on_device_model', { id })

// ─── On-device LLM chat models (Phase 5 Task 1) ─────────────────────────────

/** Per-model download state — mirrors the `download_state` payload of
 *  `OnDeviceLlmModelInfo` (`#[serde(tag = "status", rename_all = "snake_case")]`).
 *  The backend joins catalog + state, so unlike the embedding catalog
 *  (which has a static frontend copy), the LLM catalog is the source of
 *  truth here and is hydrated purely from `list_on_device_llm_models`. */
export type OnDeviceLlmDownloadStateWire =
  | { status: 'not_downloaded' }
  | { status: 'downloading'; progress: number }
  | { status: 'ready' }
  | { status: 'error'; code: string }

/** One on-device LLM catalog entry + its current download state, as
 *  returned by `list_on_device_llm_models`. Mirrors `OnDeviceLlmModelInfo`,
 *  which is `#[serde(rename_all = "camelCase")]` (like the sibling embedding
 *  `OnDeviceModelWire` and the rest of the AI command surface) — so every
 *  multi-word field arrives camelCased. Only `downloadState`'s INNER shape
 *  stays snake_case-tagged, because `DownloadState` carries its own
 *  `#[serde(tag = "status")]` that the parent rename does not reach. */
export interface OnDeviceLlmModelWire {
  id: string
  displayName: string
  downloadSizeBytes: number
  contextTokens: number
  minRamGb: number
  recommended: boolean
  multilingual: boolean
  whenToChoose: string
  termsUrl: string
  requiresAcceptance: boolean
  downloadState: OnDeviceLlmDownloadStateWire
}

/** llama-server lifecycle, as returned by `get_on_device_llm_server_status`.
 *  Mirrors `OnDeviceLlmServerStatus` (`#[serde(rename_all = "snake_case")]`). */
export type OnDeviceLlmServerStateWire =
  | { state: 'stopped' }
  | { state: 'starting' }
  | { state: 'ready'; model_id: string; port: number }
  | { state: 'failed'; code: string }

/** List the on-device LLM catalog with each entry's current download
 *  state, for the Settings local-model picker (`useOnDeviceLlmModels`).
 *  The catalog is the source of truth — the frontend keeps no static
 *  copy (unlike embeddings), so the picker never drifts out of sync. */
export const listOnDeviceLlmModels = (): Promise<OnDeviceLlmModelWire[]> =>
  invoke('list_on_device_llm_models')

/** Read the llama-server sidecar's current lifecycle status. */
export const getOnDeviceLlmServerStatus = (): Promise<OnDeviceLlmServerStateWire> =>
  invoke('get_on_device_llm_server_status')

/** Fire-and-forget start of a model download. Live progress arrives via
 *  the `on-device-llm:download-progress` event; this resolves (void)
 *  once the download is kicked off, not when it finishes. */
export const downloadOnDeviceLlmModel = (id: string): Promise<void> =>
  invoke('download_on_device_llm_model', { id })

/** Best-effort cancel of an in-flight model download. */
export const cancelOnDeviceLlmDownload = (id: string): Promise<void> =>
  invoke('cancel_on_device_llm_download', { id })

/** Delete a downloaded model's GGUF files, freeing disk space. If the
 *  model is the active on-device generation model, the generation slot
 *  is forgotten and the sidecar is stopped first — never rejects with
 *  `"model_in_use"`. */
export const deleteOnDeviceLlmModel = (id: string): Promise<void> =>
  invoke('delete_on_device_llm_model', { id })

/** llama-server binary install snapshot, as returned by
 *  `on_device_llm_binary_status`. Snake_case keys match the Rust payload. */
export interface OnDeviceLlmBinaryStatusPayload {
  installed: boolean
  size_bytes: number
}

/** Whether the llama-server sidecar binary is installed, plus the on-disk
 *  size of its versioned dir (binary + companion dylibs/DLLs). */
export const onDeviceLlmBinaryStatus = (): Promise<OnDeviceLlmBinaryStatusPayload> =>
  invoke('on_device_llm_binary_status')

/** Delete the llama-server install dir. If generation is on-device-llm
 *  (any chat model), the gen slot is forgotten and the sidecar is
 *  stopped first. Never rejects. */
export const deleteOnDeviceLlmBinary = (): Promise<void> => invoke('delete_on_device_llm_binary')

// ─── AI feature toggles + privacy receipt (Phase 6 v2 R3) ───────────────────

/** Comprehensive AI settings snapshot for the Settings panel. */
export const getAiSettings = (): Promise<AIFullSettings> => invoke('get_ai_settings')

/** Stamp the unified AI privacy receipt (`ai_privacy_accepted_at`).
 *  One acceptance covers every non-local provider and multi-entry AI
 *  feature. Local endpoints are auto-exempt. */
export const acceptAiPrivacy = (): Promise<number> => invoke('accept_ai_privacy')

/** Legacy alias — writes the same unified receipt as `acceptAiPrivacy`. */
export const acceptAiBulkContext = (): Promise<number> => invoke('accept_ai_bulk_context')

/** Toggle one per-feature flag. Rejects with `AI_PRIVACY_NOT_ACCEPTED` when
 *  enabling a feature without consent. */
export const setAiFeature = (feature: AIFeature, enabled: boolean): Promise<void> =>
  invoke('set_ai_feature', { feature, enabled })

/** One-shot R3 cleanup: delete orphan `entries_embeddings` rows + remove
 *  `~/Library/Application Support/Memlore/models/`. Idempotent — runs once. */
export const aiV2Migrate = (): Promise<MigrationOutcome> => invoke('ai_v2_migrate')

/** Persist Daily Chat persona / custom-prompt preferences. The values are
 *  read by `daily_chat_create_session` and snapshotted onto each new
 *  session row — older sessions keep their original snapshot. Language is
 *  no longer a per-feature setting here — Daily Chat uses the global
 *  `setAiResponseLanguage` setting like every other generation feature. */
export const setDailyChatPreferences = (persona: string, customPersona: string): Promise<void> =>
  invoke('set_daily_chat_preferences', { persona, customPersona })

/** Persist the nested Daily Chat preference that enables an extra LLM
 *  call to generate the session title from the first user message.
 *  Default is off — the truncated first-message title is used instead. */
export const setDailyChatAiTitle = (enabled: boolean): Promise<void> =>
  invoke('set_daily_chat_ai_title', { enabled })

/** Persist the prototype language used to rank emotion suggestions.
 *  Backend re-validates against the `"auto" | "en" | "vi" | ...` allow-list. */
export const setEmotionSuggestionLanguage = (language: string): Promise<void> =>
  invoke('set_emotion_suggestion_language', { language })

/** Persist the global AI response language applied to every generation
 *  feature (title suggestions, highlights, go deeper, summaries, periodic
 *  review, theme insights, ask journal, daily chat). Accepts the presets
 *  `"auto"` / `"en"` / `"vi"`, or a custom English language name (e.g.
 *  `"French"`). Backend re-validates regardless of the UI. */
export const setAiResponseLanguage = (language: string): Promise<void> =>
  invoke('set_ai_response_language', { language })

/** Persist a per-feature system-prompt override. Empty string resets to default. */
export const setAiFeaturePrompt = (
  feature: import('../types/ai').AIFeaturePromptFeature,
  prompt: string,
): Promise<void> => invoke('set_ai_feature_prompt', { feature, prompt })

// ─── AI audit log (Phase 6 Stretch S2-2) ─────────────────────────────────────

import type { AiAuditLogFilter, AiAuditLogRow } from '../types/ai'

/** Fetch up to `limit` audit rows (newest-first) starting at `offset`,
 *  with optional multi-value filters. Filter fields are snake_case to
 *  match the Rust serde shape. */
export const listAiAuditLog = (
  filter: AiAuditLogFilter,
  limit: number,
  offset: number,
): Promise<AiAuditLogRow[]> => invoke('list_ai_audit_log', { filter, limit, offset })

/** Delete all rows in `ai_audit_log`. Returns the count deleted. */
export const clearAiAuditLog = (): Promise<number> => invoke('clear_ai_audit_log')

/** Read the stored retention setting. Returns `90` (the default) when unset. */
export const getAiAuditRetentionDays = (): Promise<number> => invoke('get_ai_audit_retention_days')

/** Persist a new retention value. The backend clamps to 1..=365. */
export const setAiAuditRetentionDays = (days: number): Promise<void> =>
  invoke('set_ai_audit_retention_days', { days })

// ─── AI usage dashboard (Phase 6 Stretch S3) ─────────────────────────────────

import type { AiUsageSummary, UsagePeriod } from '../types/ai'

/** Aggregate usage statistics for the given time period.
 *  Returns headline totals, per-provider rows, a grouped breakdown table,
 *  and a daily tokens-out series. No cost or pricing information. */
export const summarizeAiUsage = (period: UsagePeriod): Promise<AiUsageSummary> =>
  invoke('summarize_ai_usage', { period })

// ─── Stats export (universal byte sink) ──────────────────────────────────────

/** Write `bytes` to `path`. The frontend builds the full payload
 *  (CSV / JSON / HTML / zip / PDF) and the backend only acts as a
 *  file sink, keeping the FS-permission surface tiny. */
export const exportStatsFile = (path: string, bytes: Uint8Array): Promise<void> =>
  invoke('export_stats_file', { path, bytes: Array.from(bytes) })

// ─── Paginated list surfaces (Phase 3 frontend foundation) ───────────────────

import type { PagedResult, EntrySort, EntryTimeRange, LockFilter } from '../types/pagination'

// Entry dates — full set for calendar heatmap (no pagination)
export const listEntryDates = (
  journalId: string | null,
  lockedView: LockedView = 'revealed',
  activeVaultId: string | null = null,
): Promise<number[]> => invoke('list_entry_dates', { journalId, lockedView, activeVaultId })

// Entries in a single date range — used by CalendarPanel for the selected day
export const listEntriesForDateRange = (
  journalId: string | null,
  fromTs: number,
  toTs: number,
  lockedView: LockedView = 'revealed',
  activeVaultId: string | null = null,
): Promise<Entry[]> =>
  invoke('list_entries_for_date_range', { journalId, fromTs, toTs, lockedView, activeVaultId })

// Entries — per journal
export const listEntriesPaged = (
  journalId: string,
  sort: EntrySort,
  range: EntryTimeRange,
  fromTs: number | null,
  toTs: number | null,
  firstDayOfWeek: 0 | 1,
  page: number,
  lockedView: LockedView = 'revealed',
  activeVaultId: string | null = null,
  lockFilter: LockFilter = 'all',
): Promise<PagedResult<Entry>> =>
  invoke('list_entries_paged', {
    journalId,
    sort,
    range,
    fromTs,
    toTs,
    firstDayOfWeek,
    page,
    lockedView,
    activeVaultId,
    lockFilter,
  })

// Entries — all journals
export const listAllEntriesPaged = (
  sort: EntrySort,
  range: EntryTimeRange,
  fromTs: number | null,
  toTs: number | null,
  firstDayOfWeek: 0 | 1,
  page: number,
  lockedView: LockedView = 'revealed',
  activeVaultId: string | null = null,
  lockFilter: LockFilter = 'all',
): Promise<PagedResult<Entry>> =>
  invoke('list_all_entries_paged', {
    sort,
    range,
    fromTs,
    toTs,
    firstDayOfWeek,
    page,
    lockedView,
    activeVaultId,
    lockFilter,
  })

// Entries — favorites (optionally scoped to a journal; null = all journals)
export const listFavoriteEntriesPaged = (
  journalId: string | null,
  sort: EntrySort,
  range: EntryTimeRange,
  fromTs: number | null,
  toTs: number | null,
  firstDayOfWeek: 0 | 1,
  page: number,
  lockedView: LockedView = 'revealed',
  activeVaultId: string | null = null,
  lockFilter: LockFilter = 'all',
): Promise<PagedResult<Entry>> =>
  invoke('list_favorite_entries_paged', {
    journalId,
    sort,
    range,
    fromTs,
    toTs,
    firstDayOfWeek,
    page,
    lockedView,
    activeVaultId,
    lockFilter,
  })

// Entries — by tag
export const listEntriesByTagPaged = (
  tagId: string,
  journalId: string | null,
  favoritesOnly: boolean,
  sort: EntrySort,
  range: EntryTimeRange,
  fromTs: number | null,
  toTs: number | null,
  firstDayOfWeek: 0 | 1,
  page: number,
  lockedView: LockedView = 'revealed',
  activeVaultId: string | null = null,
  lockFilter: LockFilter = 'all',
): Promise<PagedResult<Entry>> =>
  invoke('list_entries_by_tag_paged', {
    tagId,
    journalId,
    favoritesOnly,
    sort,
    range,
    fromTs,
    toTs,
    firstDayOfWeek,
    page,
    lockedView,
    activeVaultId,
    lockFilter,
  })

// Media — all journals, paginated
export const listAllMediaPaged = (
  kind: string | null,
  page: number,
  lockedView: LockedView = 'revealed',
  activeVaultId: string | null = null,
  pageSize = 20,
): Promise<PagedResult<GalleryMediaRow>> =>
  invoke('list_all_media_paged', { kind, page, lockedView, activeVaultId, pageSize })

// Daily Chat sessions — paginated
export const dailyChatListSessionsPaged = (
  page: number,
  query?: string,
): Promise<PagedResult<import('../types/ai').ChatSessionMeta>> =>
  invoke('daily_chat_list_sessions_paged', { page, query: query ?? null })

// ─── Device list (V2 keyring) ─────────────────────────────────────────────────

/**
 * A device row as returned by the Rust backend. Fields are snake_case
 * (no rename_all on the Rust struct).
 */
export interface DeviceInfo {
  device_id: string
  name: string
  /** Unix timestamp (seconds) when the device was first registered. */
  created_at: number
  /** Unix timestamp (seconds) of the last sync from this device. */
  last_seen_at: number
  is_current: boolean
  is_revoked: boolean
}

/** Return all device rows from the local `devices` table, ordered by `created_at ASC`. */
export const listDevices = (): Promise<DeviceInfo[]> => invoke('list_devices')

/**
 * Rename a device. If `deviceId` is the current device and Drive is connected,
 * the updated slot is re-uploaded immediately (best-effort; falls back to
 * `keyring_dirty` retry on next sync). Non-current devices are updated locally only.
 */
export const renameDevice = (deviceId: string, newName: string): Promise<void> =>
  invoke('rename_device', { deviceId, newName })

/**
 * Fetch all device slots from Drive and upsert them into the local `devices`
 * table. Never deletes local rows. Returns the merged list.
 */
export const refreshDevicesFromCloud = (): Promise<DeviceInfo[]> =>
  invoke('refresh_devices_from_cloud')

// ─── Entry version history (Phase 3: editor integration) ─────────────────────

/**
 * Metadata-only projection of a stored version (no Yjs blob). Mirrors Rust's
 * `db::VersionMeta`, which is `#[serde(rename_all = "camelCase")]`.
 */
export interface VersionMeta {
  id: string
  createdAt: number
  previewText: string
  deviceId: string
}

/**
 * Capture an immutable snapshot of an entry's current Yjs document as a new
 * version. `yjsDoc` is passed as `number[]` — see the Entry content note
 * above re: `Vec<u8>` across the IPC boundary. Returns the new version id.
 */
export const snapshotEntryVersion = (
  entryId: string,
  yjsDoc: number[],
  previewText: string,
): Promise<string> => invoke('snapshot_entry_version', { entryId, yjsDoc, previewText })

/** List version metadata (no blob) for an entry, newest first. */
export const listEntryVersions = (
  entryId: string,
  activeVaultId: string | null = null,
): Promise<VersionMeta[]> => invoke('list_entry_versions', { entryId, activeVaultId })

/** Fetch the raw Yjs blob for a single version, for preview/restore. */
export const getEntryVersionContent = (
  versionId: string,
  entryId: string,
  activeVaultId: string | null = null,
): Promise<number[]> => invoke('get_entry_version_content', { versionId, entryId, activeVaultId })

/** Read the version-history retention setting, in days. Defaults to 7. */
export const getVersionRetentionDays = (): Promise<number> => invoke('get_version_retention_days')

/** Persist the version-history retention setting (3, 7, or 15 days). */
export const setVersionRetentionDays = (days: number): Promise<void> =>
  invoke('set_version_retention_days', { days })

// ─── Offline world PMTiles basemap (Phase 3 T12) ─────────────────────────────

/** Live download states from `basemap_status`. Field names are snake_case
 *  — the Rust struct has no `rename_all`. */
export type BasemapStatusKind = 'not_downloaded' | 'downloading' | 'ready'

/** `basemap_status` payload. */
export interface BasemapStatusPayload {
  status: BasemapStatusKind
  path: string | null
  size_bytes: number | null
}

/** Pinned byte size of the published `world-z8.pmtiles` archive. */
export const BASEMAP_SIZE_BYTES = 552_165_687

/** Fire-and-forget start of the world-basemap download. Live progress
 *  arrives via `basemap:download-progress`; this resolves (void) as soon
 *  as the backend claims the download slot. */
export const downloadBasemap = (): Promise<void> => invoke('download_basemap')

/** Cancel the in-flight world-basemap download. No-op when idle. */
export const cancelBasemapDownload = (): Promise<void> => invoke('cancel_basemap_download')

/** Current on-disk / in-flight status of the world basemap. */
export const basemapStatus = (): Promise<BasemapStatusPayload> => invoke('basemap_status')

/** Range-read the downloaded PMTiles archive. `len` is capped at 4 MiB
 *  on the Rust side; short EOF reads are OK. */
export async function readBasemapRange(offset: number, len: number): Promise<Uint8Array> {
  const raw = await invoke<unknown>('read_basemap_range', { offset, len })
  return toUint8Array(raw)
}

/** Delete the downloaded world basemap (and any `.part`). Rejects while
 *  a download is in flight. */
export const deleteBasemap = (): Promise<void> => invoke('delete_basemap')

// ─── Uninstall (Settings → General → Danger zone) ────────────────────────────

/** `uninstall_preview` payload. The Rust struct is `rename_all = "camelCase"`. */
export interface UninstallPreview {
  /** Absolute data paths that will be deleted, in deletion order. */
  paths: string[]
  /** Paths that exist and belong to the app but fail the backend's safety
   *  rules, so they survive the wipe (e.g. an XDG dir outside `$HOME`).
   *  Non-empty means the erasure is knowingly incomplete — surface it. */
  skipped: string[]
  /** Total on-disk size of `paths`. */
  totalBytes: number
  /** The application bundle, when this platform + install can remove it. */
  appPath: string | null
  /** `true` only when `appPath` is present and its parent is writable. */
  appRemovable: boolean
  platform: 'macos' | 'windows' | 'linux' | 'other'
}

/** Read-only: exactly what an uninstall would erase. */
export const uninstallPreview = (): Promise<UninstallPreview> => invoke('uninstall_preview')

/** Point of no return. Wipes local data + Keychain + login item, then quits;
 *  a detached reaper deletes the paths once this process is gone. Resolves
 *  just before the app exits, so callers should not expect to run after it. */
export const uninstallApp = (removeAppBundle: boolean): Promise<void> =>
  invoke('uninstall_app', { removeAppBundle })

// ─── MapKit JS token (Phase 4 T16) ───────────────────────────────────────────

export { getMapkitToken, type MapkitTokenResult } from './getMapkitToken'
