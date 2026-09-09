import type { Entry } from '../../src/types/entry'
import type {
  ChatAttachableEntry,
  ChatEntriesInRangeCount,
  OnDeviceLlmDownloadStateWire,
  OnDeviceLlmModelWire,
  OnDeviceModelStateWire,
  OnDeviceModelWire,
} from '../../src/lib/tauri'
import type {
  AIFullSettings,
  AIProvidersConfig,
  ChatAttachmentRef,
  ChatContextPreflight,
  ProviderCredential,
} from '../../src/types/ai'
import { getActiveScenario } from './activeScenario'
import { webGetSetting } from './editorSettings'
import { entries, entriesById, journalsById, memoryItems } from '../fixtures/index'
import { APPLE_JOURNAL_IMPORT_PREVIEW } from '../scenarios/appleJournalImport'

// Mirrors `CHAT_RAG_WARN_BYTES` / `CHAT_RAG_TOTAL_MAX_BYTES` in
// `src-tauri/src/commands/ai.rs` — used to derive plausible preflight
// numbers below without a second source of truth for the thresholds.
const CHAT_RAG_WARN_BYTES = 16 * 1024
const CHAT_RAG_TOTAL_MAX_BYTES = 24 * 1024

export const FAKE_AI_PROVIDERS = {
  generation: {
    provider: 'openai',
    endpoint: 'https://api.openai.com/v1',
    endpointClass: 'remote',
    chatModel: 'gpt-5-mini',
    hasApiKey: true,
  },
  image: {
    provider: 'openai',
    endpoint: 'https://api.openai.com/v1',
    endpointClass: 'remote',
    imageModel: 'gpt-image-2',
    hasApiKey: true,
  },
  embedding: {
    provider: 'voyage',
    endpoint: 'https://api.voyageai.com/v1',
    endpointClass: 'remote',
    embeddingModel: 'voyage-4',
    hasApiKey: true,
  },
} satisfies AIProvidersConfig

/** Per-preset credential registry rows (T1.6) mirroring `FAKE_AI_PROVIDERS`
 *  — openai + voyage both carry a key so the Settings picker renders them
 *  as configured instead of "Needs API key". `ProviderPicker` derefs this
 *  (`for (const c of credentials)`) on mount, so a missing handler returns
 *  null and crashes the panel. */
const FAKE_AI_CREDENTIALS = [
  {
    presetId: 'openai',
    endpoint: 'https://api.openai.com/v1',
    hasApiKey: true,
    endpointClass: 'remote',
  },
  {
    presetId: 'voyage',
    endpoint: 'https://api.voyageai.com/v1',
    hasApiKey: true,
    endpointClass: 'remote',
  },
] satisfies ProviderCredential[]

// ─── On-device model catalogs (web harness demos) ────────────────────────────
// Mirrors `src-tauri/src/ai/on_device/{catalog,llm_catalog}.rs`. Session-mutable
// download state so Download / Remove in the modals still feel interactive.

const FAKE_EMBED_CATALOG: Omit<OnDeviceModelWire, 'state'>[] = [
  {
    id: 'multilingual-e5-base',
    displayName: 'multilingual-e5-base',
    dim: 768,
    mrlDims: [],
    contextLength: 512,
    downloadSize: '~1.1 GB',
    approxRam: '~1.5-2 GB',
    multilingual: true,
    recommended: true,
    whenToChoose: 'Best balance for multilingual/Vietnamese journals.',
    supported: true,
  },
  {
    id: 'multilingual-e5-small',
    displayName: 'multilingual-e5-small',
    dim: 384,
    mrlDims: [],
    contextLength: 512,
    downloadSize: '~470 MB',
    approxRam: '~0.6-1 GB',
    multilingual: true,
    recommended: false,
    whenToChoose: 'Lightest multilingual option; best for low-RAM machines.',
    supported: true,
  },
  {
    id: 'multilingual-e5-large',
    displayName: 'multilingual-e5-large',
    dim: 1024,
    mrlDims: [],
    contextLength: 512,
    downloadSize: '~2.2 GB',
    approxRam: '~3-4 GB',
    multilingual: true,
    recommended: false,
    whenToChoose: 'Highest multilingual quality; needs a capable machine.',
    supported: true,
  },
  {
    id: 'nomic-embed-text-v1.5',
    displayName: 'nomic-embed-text-v1.5',
    dim: 768,
    mrlDims: [],
    contextLength: 8192,
    downloadSize: '~275 MB',
    approxRam: '~0.5-1 GB',
    multilingual: false,
    recommended: false,
    whenToChoose: 'Long entries (8K context); strongest for English.',
    supported: true,
  },
]

/** Seed: recommended + one light model already on disk; the rest available. */
const embedDownloadState = new Map<string, OnDeviceModelStateWire>([
  ['multilingual-e5-base', { status: 'ready' }],
  ['multilingual-e5-small', { status: 'ready' }],
  ['multilingual-e5-large', { status: 'not_downloaded' }],
  ['nomic-embed-text-v1.5', { status: 'not_downloaded' }],
])

function listOnDeviceModels(): OnDeviceModelWire[] {
  return FAKE_EMBED_CATALOG.map((entry) => ({
    ...entry,
    state: embedDownloadState.get(entry.id) ?? { status: 'not_downloaded' },
  }))
}

function getOnDeviceModelState(args: Record<string, unknown>): OnDeviceModelStateWire {
  const id = String(args.id ?? '')
  return embedDownloadState.get(id) ?? { status: 'not_downloaded' }
}

function startOnDeviceModelDownload(args: Record<string, unknown>): OnDeviceModelStateWire {
  const id = String(args.id ?? '')
  const ready: OnDeviceModelStateWire = { status: 'ready' }
  embedDownloadState.set(id, ready)
  return ready
}

function cancelOnDeviceModelDownload(args: Record<string, unknown>): OnDeviceModelStateWire {
  const id = String(args.id ?? '')
  const next: OnDeviceModelStateWire = { status: 'not_downloaded' }
  embedDownloadState.set(id, next)
  return next
}

function removeOnDeviceModel(args: Record<string, unknown>): OnDeviceModelStateWire {
  const id = String(args.id ?? '')
  const next: OnDeviceModelStateWire = { status: 'not_downloaded' }
  embedDownloadState.set(id, next)
  return next
}

const GEMMA_TERMS_URL = 'https://ai.google.dev/gemma/terms'

const FAKE_LLM_CATALOG: Omit<OnDeviceLlmModelWire, 'downloadState'>[] = [
  {
    id: 'gemma-4-e2b-it',
    displayName: 'Gemma 4 E2B (QAT Q4_0)',
    downloadSizeBytes: 3_349_516_256,
    contextTokens: 8192,
    minRamGb: 8,
    recommended: false,
    multilingual: true,
    whenToChoose: 'Lightest and fastest; good for short entries on 8 GB machines.',
    termsUrl: GEMMA_TERMS_URL,
    requiresAcceptance: true,
  },
  {
    id: 'gemma-4-e4b-it',
    displayName: 'Gemma 4 E4B (QAT Q4_0)',
    downloadSizeBytes: 5_154_941_280,
    contextTokens: 8192,
    minRamGb: 8,
    recommended: true,
    multilingual: true,
    whenToChoose: 'Best balance of quality and speed; the recommended default.',
    termsUrl: GEMMA_TERMS_URL,
    requiresAcceptance: true,
  },
  {
    id: 'gemma-4-12b-it',
    displayName: 'Gemma 4 12B (QAT Q4_0)',
    downloadSizeBytes: 6_975_879_296,
    contextTokens: 8192,
    minRamGb: 16,
    recommended: false,
    multilingual: true,
    whenToChoose: 'Highest quality; needs a 16 GB machine for the weights + KV cache.',
    termsUrl: GEMMA_TERMS_URL,
    requiresAcceptance: true,
  },
]

/** Seed: light + recommended ready; largest still to download. */
const llmDownloadState = new Map<string, OnDeviceLlmDownloadStateWire>([
  ['gemma-4-e2b-it', { status: 'ready' }],
  ['gemma-4-e4b-it', { status: 'ready' }],
  ['gemma-4-12b-it', { status: 'not_downloaded' }],
])

function listOnDeviceLlmModels(): OnDeviceLlmModelWire[] {
  return FAKE_LLM_CATALOG.map((entry) => ({
    ...entry,
    downloadState: llmDownloadState.get(entry.id) ?? { status: 'not_downloaded' },
  }))
}

function downloadOnDeviceLlmModel(args: Record<string, unknown>): void {
  const id = String(args.id ?? '')
  llmDownloadState.set(id, { status: 'ready' })
}

function cancelOnDeviceLlmDownload(args: Record<string, unknown>): void {
  const id = String(args.id ?? '')
  llmDownloadState.set(id, { status: 'not_downloaded' })
}

function deleteOnDeviceLlmModel(args: Record<string, unknown>): void {
  const id = String(args.id ?? '')
  llmDownloadState.set(id, { status: 'not_downloaded' })
}

function onDeviceLlmBinaryStatus(): { installed: boolean; size_bytes: number } {
  return { installed: false, size_bytes: 0 }
}

function deleteOnDeviceLlmBinary(): void {}

const byteEncoder = new TextEncoder()
function byteLength(text: string | null): number {
  return byteEncoder.encode(text ?? '').length
}

/** Same exclusion rule the backend applies everywhere in this feature
 *  (`list_attachable_entries`, `count_entries_in_range`): locked and
 *  invisible entries — including ones inheriting either flag from their
 *  journal — are never offerable, no exceptions. */
function isAttachableEntry(e: Entry): boolean {
  if (e.is_locked || e.is_invisible) return false
  const journal = journalsById.get(e.journal_id)
  return !(journal?.is_locked || journal?.is_invisible)
}

function chatSearchAttachableEntries(args: Record<string, unknown>): ChatAttachableEntry[] {
  const query = String(args.query ?? '')
    .trim()
    .toLowerCase()
  const limit = Number(args.limit ?? 5)
  const pool = entries.filter(isAttachableEntry)
  const matches =
    query === '' ? pool : pool.filter((e) => (e.title ?? '').toLowerCase().includes(query))
  return [...matches]
    .sort((a, b) => b.entry_date - a.entry_date)
    .slice(0, limit)
    .map((e) => ({ id: e.id, title: e.title, entryDate: e.entry_date }))
}

/** Attachable entries in `[start, end)` — half-open, matching the
 *  backend's `count_entries_in_range` contract. Shared by the range count
 *  command and the period branch of `chatRagPreflight`. */
function attachableEntriesInRange(start: number, end: number): Entry[] {
  return entries
    .filter(isAttachableEntry)
    .filter((e) => e.entry_date >= start && e.entry_date < end)
}

function chatCountEntriesInRange(args: Record<string, unknown>): ChatEntriesInRangeCount {
  const matches = attachableEntriesInRange(Number(args.start), Number(args.end))
  const totalBytes = matches.reduce((sum, e) => sum + byteLength(e.content_text), 0)
  return { entryCount: matches.length, totalBytes }
}

/** Untrimmed byte size + entry count a single attachment ref refers to —
 *  the building block `chatRagPreflight` sums across every attachment. */
function attachmentSize(ref: ChatAttachmentRef): { bytes: number; entryCount: number } {
  if (ref.kind === 'entry') {
    const e = entriesById.get(ref.id)
    if (!e || !isAttachableEntry(e)) return { bytes: 0, entryCount: 0 }
    return { bytes: byteLength(e.content_text), entryCount: 1 }
  }
  const matches = attachableEntriesInRange(ref.start, ref.end)
  return {
    bytes: matches.reduce((sum, e) => sum + byteLength(e.content_text), 0),
    entryCount: matches.length,
  }
}

/** Derives a plausible `ChatContextPreflight` from the attached refs —
 *  mirrors `build_chat_context_preflight`'s shape closely enough for the
 *  preview: small attachments stay under `CHAT_RAG_WARN_BYTES` (calm
 *  readout), large ones exceed it (`needsConfirm: true`, the warning
 *  treatment). Never calls a provider — purely derived from fixture data. */
function chatRagPreflight(args: Record<string, unknown>): ChatContextPreflight {
  const attachments = (args.attachments as ChatAttachmentRef[] | undefined) ?? []
  let totalBytes = 0
  let entriesTotal = 0
  for (const ref of attachments) {
    const { bytes, entryCount } = attachmentSize(ref)
    totalBytes += bytes
    entriesTotal += entryCount
  }
  const estimatedBytes = Math.min(totalBytes, CHAT_RAG_TOTAL_MAX_BYTES)
  const trimmed = estimatedBytes < totalBytes
  const entriesIncluded = trimmed
    ? Math.max(1, Math.round(entriesTotal * (estimatedBytes / totalBytes)))
    : entriesTotal
  return {
    estimatedBytes,
    totalBytes,
    entriesIncluded,
    entriesTotal,
    trimmed,
    needsConfirm: estimatedBytes > CHAT_RAG_WARN_BYTES,
    blocked: false,
  }
}

// Safe defaults for commands we know the app fires on boot.
// All other commands return null — components must handle null gracefully.
// A value may be a plain value or a function `(args) => unknown` — the
// latter for commands whose result must react to what was actually passed
// (e.g. a search query), same calling convention as a scenario override.
const SAFE_DEFAULTS: Record<string, unknown | ((args: Record<string, unknown>) => unknown)> = {
  list_journals: [],
  list_tags: [],
  get_tags_with_counts: [],
  list_templates: [],
  get_sync_status: { enabled: false, provider: null, lastSync: null, entriesPending: 0 },
  get_sync_settings: { intervalMinutes: 0, onSave: false, onLaunch: false },
  get_encryption_mode: 'password',
  is_encryption_initialized: false,
  get_force_re_pair_status: null,
  get_pending_rotation_recovery: null,
  get_pending_first_time_setup: null,
  get_device_id: 'web-preview-device',
  get_streak: { current_streak: 0, longest_streak: 0, last_entry_date: null },

  list_location_aliases: [],
  list_on_this_day: [],
  list_entry_dates: [],
  list_map_pins: [],
  list_media_for_entry: [],
  // Dashboard Phase 2 cards (heatmap / tags / places / photos).
  // `route()` returns null for unhandled commands; PhotosCard would crash
  // on `null.items` the moment it mounts. Stats cards guard `data ?? []`.
  stats_streak_calendar: [],
  stats_tag_frequency: [],
  stats_location_density: [],
  list_all_media_paged: { items: [], total: 0, hasMore: false },
  pick_videos_from_library: { saved: [], rejected: [] },
  get_media_cache_stats: { usedBytes: 0, maxBytes: 512 * 1024 * 1024 },
  preview_apple_journal_import: APPLE_JOURNAL_IMPORT_PREVIEW,
  export_stats_file: null,
  // User Memory (MemoriesSettings + Daily Chat "N memories used" chips).
  // `list_memory_items` is dereffed (`memory.items.length`) on mount, so null
  // crashes the picker. Seeded with fixtures so assistant rows that carry
  // `memoryIds` resolve real text in the chip popover.
  list_memory_items: memoryItems,
  get_sync_scope_upgrade_required: false,
  is_biometric_available: false,
  is_biometric_unlock_enabled: false,
  list_ai_audit_log: [],
  get_ai_audit_retention_days: 90,
  clear_ai_audit_log: 0,
  list_devices: [],
  refresh_devices_from_cloud: [],
  gdrive_get_status: { connected: false, provider: null },
  icloud_availability: {
    available: true,
    path: '/Users/demo/Library/Mobile Documents/com~apple~CloudDocs',
  },
  cloud_folder_connect: { outcome: 'ready' },
  gdrive_refresh_storage_quota: { connected: false },
  get_version_retention_days: 7,

  // AI / embedding — provide a realistic sanitized two-slot snapshot.
  // Several views/hooks deref these payloads on mount (PeriodReviewView,
  // InsightsPanel, useBackfillStatus, useEmbeddingStatus,
  // useAiBulkContextConsent, useAIProviderConfig), so these entries are
  // load-bearing: dropping one re-crashes the web preview. The consumers
  // also null-guard defensively, but the shapes here must still track the
  // Rust structs (see src-tauri/src/commands/ai*.rs) field-for-field.
  //
  // `get_ai_settings` is required even for scenarios that never touch AI:
  // AISettingsPanel / applySnapshot read flags off the snapshot, and a
  // null fallback throws (`entryHighlightsEnabled` on null). All-flags-off
  // matches `AI_PREVIEW_INVOKE.get_ai_settings` in web/scenarios/index.ts.
  get_ai_settings: {
    provider: null,
    endpoint: null,
    endpointClass: null,
    chatModel: null,
    embeddingModel: null,
    hasApiKey: false,
    privacyAcceptedAt: null,
    semanticSearchEnabled: false,
    emotionSuggestionsEnabled: false,
    titleSuggestionsEnabled: false,
    entryHighlightsEnabled: false,
    goDeeperEnabled: false,
    continueWritingEnabled: false,
    dailyChatEnabled: false,
    chatMemoryEnabled: false,
    imageGenerationEnabled: false,
    multiEntrySummaryEnabled: false,
    periodicReviewEnabled: false,
    insightsEnabled: false,
    dashboardInsightsEnabled: false,
    tagSuggestionsEnabled: false,
    chatRagEnabled: false,
    userMemoryEnabled: false,
    personaEnabled: false,
    memoryGenProvider: null,
    memoryGenEndpoint: null,
    memoryGenEndpointClass: null,
    memoryGenChatModel: null,
    memoryGenHasApiKey: false,
    memoryEmbedProvider: null,
    memoryEmbedEndpoint: null,
    memoryEmbedEndpointClass: null,
    memoryEmbedEmbeddingModel: null,
    memoryEmbedHasApiKey: false,
    titleSuggestionsSystemPrompt: '',
    entryHighlightsSystemPrompt: '',
    multiEntrySummarySystemPrompt: '',
    goDeeperSystemPrompt: '',
    dailyChatPersona: 'empathetic',
    dailyChatCustomPersona: '',
    dailyChatAiTitle: false,
    responseLanguage: 'auto',
    emotionSuggestionLanguage: 'auto',
  } satisfies AIFullSettings,
  // Dashboard AI cards (weekly review / bulk-consent count).
  // `generate_period_review` must throw — a `null` result would put
  // usePeriodReview into `ready` with a null payload.
  list_entries_for_date_range: [],
  generate_period_review: () => {
    throw new Error('AI_PROVIDER_ERROR: AI_NOT_CONFIGURED')
  },
  get_period_review: null,
  get_cached_theme_insights: null,
  get_ai_providers: FAKE_AI_PROVIDERS,
  get_ai_provider_credentials: FAKE_AI_CREDENTIALS,
  get_backfill_status: { running: false, model_id: null, indexed: 0, total: 0 },
  get_embedding_index_stats: { model_id: null, indexed: 0, total: 0, pending: 0 },
  get_embedding_job_stats: {
    pending: 0,
    in_progress: 0,
    indexed: 0,
    skipped: 0,
    error: 0,
    paused: 0,
  },
  get_background_indexing_settings: { enabled: false, hostedConsentAt: null, allowed: false },
  get_embedding_sync_decisions: {
    slots: [
      {
        slot: 'entry',
        state: 'none',
        reason: null,
        localModelId: null,
        peerModels: [],
        pendingUnits: 0,
        needsModal: false,
      },
      {
        slot: 'memory',
        state: 'none',
        reason: null,
        localModelId: null,
        peerModels: [],
        pendingUnits: 0,
        needsModal: false,
      },
    ],
    needsModal: false,
  },
  resolve_embedding_sync_decision: {
    ok: true,
    nextState: 'pause',
    needsKey: false,
  },

  // On-device catalogs — seed a realistic mix of ready + not-downloaded so
  // the Integrated chat/embedding modals render usable rows in the web
  // harness (desktop hydrates these from disk). Handlers are functions so
  // download/remove can flip state for the session.
  list_on_device_models: listOnDeviceModels,
  get_on_device_model_state: getOnDeviceModelState,
  start_on_device_model_download: startOnDeviceModelDownload,
  cancel_on_device_model_download: cancelOnDeviceModelDownload,
  remove_on_device_model: removeOnDeviceModel,
  list_on_device_llm_models: listOnDeviceLlmModels,
  get_on_device_llm_server_status: { state: 'stopped' },
  download_on_device_llm_model: downloadOnDeviceLlmModel,
  cancel_on_device_llm_download: cancelOnDeviceLlmDownload,
  delete_on_device_llm_model: deleteOnDeviceLlmModel,
  on_device_llm_binary_status: onDeviceLlmBinaryStatus,
  delete_on_device_llm_binary: deleteOnDeviceLlmBinary,

  // Paged AI history — empty-page shape consumed by usePagedQuery
  // (useDailyChatSessions). `usePagedQuery` null-guards the result, but
  // these keep the preview realistic.
  daily_chat_list_sessions_paged: { items: [], total: 0 },

  // RAG in Daily Chat — attachment picker + context preflight. Derived
  // from the entry fixtures so the Attach popover and size readout react
  // to real data in every scenario, not just ones that override them.
  chat_search_attachable_entries: chatSearchAttachableEntries,
  chat_count_entries_in_range: chatCountEntriesInRange,
  chat_rag_preflight: chatRagPreflight,
}

export async function route(cmd: string, args: Record<string, unknown>): Promise<unknown> {
  const scenario = getActiveScenario()
  const override = scenario.invoke?.[cmd]
  if (override !== undefined) {
    return typeof override === 'function'
      ? (override as (a: Record<string, unknown>) => unknown)(args)
      : override
  }
  if (cmd === 'get_setting') return webGetSetting(args)
  if (cmd in SAFE_DEFAULTS) {
    const value = SAFE_DEFAULTS[cmd]
    return typeof value === 'function'
      ? (value as (a: Record<string, unknown>) => unknown)(args)
      : value
  }
  console.info(`[web-mock] invoke '${cmd}'`, args, '→ null (no handler)')
  return null
}
