/**
 * Frontend AI types (Phase 6 v2 R3).
 *
 * The on-device model registry types (`ModelInfo`, `DownloadProgressEvent`,
 * etc.) shipped with the abandoned Phase 6 v1 build are gone — the backend
 * stub commands still exist but are no longer surfaced through the UI. The
 * shapes below mirror the `serde(rename_all = "camelCase")` Rust types in
 * `src-tauri/src/commands/ai_provider.rs` and `src-tauri/src/commands/ai_settings.rs`.
 */

export type EndpointClass = 'local' | 'remote' | 'subscription' | 'on-device'

/** Per-message AI call metadata (assistant replies). */
export interface AiMessageMeta {
  modelId: string | null
  providerId: string | null
  endpointClass: EndpointClass | null
  tokensIn: number | null
  tokensOut: number | null
  latencyMs: number | null
}

/** Per-feature toggles surfaced in the Settings panel. The backend
 *  validates this string against an allow-list — adding a feature here
 *  also requires a matching entry in `commands::ai_settings::feature_key`. */
export type AIFeature =
  | 'semantic_search'
  | 'emotion_suggestions'
  | 'title_suggestions'
  | 'entry_highlights'
  | 'go_deeper'
  | 'continue_writing'
  | 'daily_chat'
  | 'chat_memory'
  | 'image_generation'
  | 'multi_entry_summary'
  | 'periodic_review'
  | 'theme_insights'
  | 'dashboard_insights'
  | 'tag_suggestions'
  | 'chat_rag'
  | 'user_memory'

/** Features that cannot function without a configured embedding provider —
 *  they read from the chunk vector store (query embedding + `entry_embedding_chunks`
 *  lookup), not just the generation slot. Backend evidence:
 *  - `commands::ai_settings::embedding_features_enabled` (src-tauri/src/commands/ai_settings.rs:337-342)
 *    is the backend's own "single source of truth" — it ORs exactly these
 *    four settings keys, described in its doc comment as "the only
 *    features that read from the chunk vector store".
 *  - `commands::ai_settings::is_embedding_consuming_feature_key`
 *    (src-tauri/src/commands/ai_settings.rs:621-634) is the matching
 *    predicate used to decide whether enabling a feature should kick the
 *    background indexing worker — same four keys.
 *  - `semantic_search`: calls `provider.embed_query` on the embedding slot
 *    before ranking chunk vectors (src-tauri/src/commands/search.rs:293-295);
 *    `feature_requirement` maps it to `FeatureSlot::Embedding`
 *    (src-tauri/src/commands/ai_settings.rs:139-143).
 *  - `emotion_suggestions`: calls `provider.embed` to build the entry's mean-
 *    pooled vector for prototype similarity (src-tauri/src/commands/ai.rs:501,593);
 *    mapped to `FeatureSlot::Embedding` (ai_settings.rs:144-148).
 *  - `chat_rag`: automatic semantic retrieval into Daily Chat. Fail-closed,
 *    default OFF (unlike the twelve default-on toggles) — read via
 *    `read_bool_setting`, never `read_feature_toggle_defaulting_on`.
 *    `feature_requirement` gives it a dual-slot shape:
 *    `slot: FeatureSlot::Generation`,
 *    `extra_slot: Some(FeatureSlot::Embedding)` (ai_settings.rs:214-218).
 *
 *  Considered and excluded — each maps only to `FeatureSlot::Generation` in
 *  `feature_requirement` (ai_settings.rs:150-203) and has no `provider.embed`
 *  / `embed_query` call in its command body:
 *  - `title_suggestions`, `entry_highlights`, `tag_suggestions`: single-entry
 *    `provider.chat` call, no retrieval (e.g. suggest_tags.rs:157).
 *  - `go_deeper`, `daily_chat`: `provider.chat` over the current entry /
 *    conversation only — no vector lookup.
 *  - `multi_entry_summary`, `periodic_review`, `theme_insights`: fan out
 *    over entries by sending their raw text directly in one `provider.chat`
 *    call (see `build_multi_entry_summary_prompt` usage) — this is bulk
 *    context-stuffing, not embedding-backed retrieval, so they work with a
 *    generation-only setup.
 *  - `image_generation`: `FeatureSlot::Generation` plus a required image
 *    model; no embedding involved. */
export const EMBEDDING_DEPENDENT_FEATURES: readonly AIFeature[] = [
  'semantic_search',
  'emotion_suggestions',
  'chat_rag',
]

// ─── Usage-risk metadata (Phase 3 Task 6) ───────────────────────────────────

/** How a feature's AI usage can grow. Purely descriptive — informs the
 *  warning copy shown to the user, not any backend guardrail. */
export type UsageScalesWith =
  | 'none'
  | 'entry_length'
  | 'entry_count'
  | 'conversation_length'
  | 'image_request'

export interface AIFeatureUsageMeta {
  usageRisk: 'low' | 'medium' | 'high'
  /** Short human description of the call shape — used as the i18n
   *  `defaultValue` for `usage_warning.<feature>` and as a doc string. */
  callPattern: string
  scalesWith: UsageScalesWith
}

/** Per-feature usage-risk metadata, keyed by the same `AIFeature` ids used
 *  for the Settings toggles. Drives the warning icon in `FeatureToggle`
 *  (via `isHighUsageRisk`) — only `'high'` renders an icon; `'low'` and
 *  `'medium'` stay quiet so the signal means something. Assignments:
 *  - low: single small call, no fan-out (keyword-adjacent query embed,
 *    cached per-entry suggestion, single-entry generation).
 *  - medium: single-entry but more open-ended (reflection prompts).
 *  - high: fans out across many entries, a long conversation, or an
 *    image call — these are the calls whose cost can surprise a user. */
export const AI_FEATURE_USAGE_META: Record<AIFeature, AIFeatureUsageMeta> = {
  semantic_search: {
    usageRisk: 'low',
    callPattern: 'One embedding call per search query.',
    scalesWith: 'none',
  },
  emotion_suggestions: {
    usageRisk: 'low',
    callPattern: 'One cached embedding call per entry save.',
    scalesWith: 'entry_length',
  },
  title_suggestions: {
    usageRisk: 'low',
    callPattern: 'One generation call for a single entry.',
    scalesWith: 'entry_length',
  },
  entry_highlights: {
    usageRisk: 'low',
    callPattern: 'One generation call for a single entry after saving.',
    scalesWith: 'entry_length',
  },
  tag_suggestions: {
    usageRisk: 'low',
    callPattern: 'One generation call for a single entry.',
    scalesWith: 'entry_length',
  },
  go_deeper: {
    usageRisk: 'medium',
    callPattern: 'One generation call using the current entry as context.',
    scalesWith: 'entry_length',
  },
  continue_writing: {
    usageRisk: 'low',
    callPattern: 'One generation call per continue or rewrite action, scoped to the open entry.',
    scalesWith: 'entry_length',
  },
  chat_memory: {
    usageRisk: 'low',
    callPattern: 'One small embedding call per chat turn to find matching memories.',
    scalesWith: 'none',
  },
  daily_chat: {
    usageRisk: 'high',
    callPattern: 'Resends the full conversation history with every message.',
    scalesWith: 'conversation_length',
  },
  image_generation: {
    usageRisk: 'high',
    callPattern: 'One image-generation call per request — typically the priciest call type.',
    scalesWith: 'image_request',
  },
  multi_entry_summary: {
    usageRisk: 'high',
    callPattern: 'Sends the text of every selected entry in one generation call.',
    scalesWith: 'entry_count',
  },
  periodic_review: {
    usageRisk: 'high',
    callPattern: 'Sends every entry in the review period in one generation call.',
    scalesWith: 'entry_count',
  },
  theme_insights: {
    usageRisk: 'high',
    callPattern: 'Sends every entry in the date range in one generation call.',
    scalesWith: 'entry_count',
  },
  dashboard_insights: {
    usageRisk: 'high',
    callPattern: 'Sends every entry from the last 30 days in one generation call.',
    scalesWith: 'entry_count',
  },
  chat_rag: {
    usageRisk: 'high',
    callPattern: 'Retrieves and injects matching entries into every chat turn.',
    scalesWith: 'entry_count',
  },
  user_memory: {
    usageRisk: 'medium',
    callPattern:
      'One scan-driven extraction call per changed source, plus small on-machine embedding calls.',
    scalesWith: 'entry_length',
  },
}

export function getFeatureUsageMeta(feature: AIFeature): AIFeatureUsageMeta {
  return AI_FEATURE_USAGE_META[feature]
}

/** True for features whose AI usage can fan out unpredictably (many
 *  entries, a long conversation, an image call) — these get a warning
 *  icon in the Settings feature list. `'low'`/`'medium'` risk features
 *  stay quiet. */
export function isHighUsageRisk(feature: AIFeature): boolean {
  return AI_FEATURE_USAGE_META[feature].usageRisk === 'high'
}

/** Features whose system prompt can be customized in Settings. */
export type AIFeaturePromptFeature =
  | 'title_suggestions'
  | 'entry_highlights'
  | 'multi_entry_summary'
  | 'go_deeper'

/** Reflection lenses for Go Deeper + Daily Chat. */
export type ReflectionLens =
  | 'default'
  | 'cbt_reframe'
  | 'gratitude'
  | 'inversion'
  | 'stoic'
  | 'theme_insights'

// ─── Two-slot provider config (R11+) ────────────────────────────────────────

/** Sanitised generation-slot view (chat + image). Mirrors
 *  `commands::ai_provider::AIGenProviderConfigPublic`.
 *
 *  Privacy acceptance is **no longer per slot** — read it off
 *  `AIFullSettings.privacyAcceptedAt` instead (local endpoints are
 *  auto-exempt). */
export interface AIGenProviderConfig {
  provider: string
  endpoint: string
  endpointClass: EndpointClass
  chatModel: string
  hasApiKey: boolean
}

/** Sanitised image-slot view. Independent of the generation slot since
 *  2026-08-07 — chat and image can point at different vendors. Mirrors
 *  `commands::ai_provider::AIImageProviderConfigPublic`. */
export interface AIImageProviderConfig {
  provider: string
  endpoint: string
  endpointClass: EndpointClass
  imageModel: string
  hasApiKey: boolean
}

/** Sanitised embedding-slot view. Mirrors
 *  `commands::ai_provider::AIEmbedProviderConfigPublic`. */
export interface AIEmbedProviderConfig {
  provider: string
  endpoint: string
  endpointClass: EndpointClass
  embeddingModel: string
  hasApiKey: boolean
}

/** Both slots in one read, returned by `get_ai_providers`. Each slot
 *  is `null` when unconfigured. */
export interface AIProvidersConfig {
  generation: AIGenProviderConfig | null
  image: AIImageProviderConfig | null
  embedding: AIEmbedProviderConfig | null
}

/** Input for `set_ai_generation_provider` / `test_ai_generation_provider`.
 *
 *  **T2.6 cutover:** `endpoint` / `apiKey` no longer live here — the
 *  backend resolves both from the per-preset credential registry, keyed by
 *  `provider` (see [`ProviderCredential`] / `setAiProviderCredential`). This
 *  input only selects WHICH preset + model the slot should point at. */
export interface AIGenProviderConfigInput {
  provider: string
  chatModel: string
}

/** Input for `set_ai_image_provider`. Same credential-registry cutover as
 *  the pair above — no `endpoint` / `apiKey`. */
export interface AIImageProviderConfigInput {
  provider: string
  imageModel: string
}

/** Input for `set_ai_embedding_provider` / `test_ai_embedding_provider`.
 *  Same T2.6 cutover as `AIGenProviderConfigInput` — no `endpoint` / `apiKey`. */
export interface AIEmbedProviderConfigInput {
  provider: string
  embeddingModel: string
}

/** Read-side view of the memory generation slot, assembled by the store
 *  from the flat `memoryGen*` fields on `AIFullSettings`. Memory generation
 *  never does image generation, so this omits `imageModel` from
 *  `AIGenProviderConfig`. `null` when the slot is unconfigured. */
export interface AIMemoryGenProviderConfig {
  provider: string
  endpoint: string
  endpointClass: EndpointClass
  chatModel: string
  hasApiKey: boolean
}

/** Read-side view of the memory embedding slot, assembled by the store
 *  from the flat `memoryEmbed*` fields on `AIFullSettings`. `null` when
 *  the slot is unconfigured. */
export interface AIMemoryEmbedProviderConfig {
  provider: string
  endpoint: string
  endpointClass: EndpointClass
  embeddingModel: string
  hasApiKey: boolean
}

/** Input for `set_memory_gen_provider`. Mirrors `AIGenProviderConfigInput`
 *  minus `imageModel` — memory generation never does image generation.
 *  Same T2.6 cutover: no `endpoint` / `apiKey` — resolved from the
 *  per-preset credential registry, keyed by `provider`. */
export interface AIMemoryGenProviderConfigInput {
  provider: string
  chatModel: string
}

/** Input for `set_memory_embed_provider`. Mirrors `AIEmbedProviderConfigInput`.
 *  Same T2.6 cutover — no `endpoint` / `apiKey`. */
export interface AIMemoryEmbedProviderConfigInput {
  provider: string
  embeddingModel: string
}

// ─── Per-preset credential registry (T1.6) ──────────────────────────────────

/** Sanitised per-preset credential row, returned by `getAiProviderCredentials`.
 *  Mirrors the Rust `ProviderCredentialPublic`. Never carries a raw API key —
 *  `hasApiKey: boolean` only, same posture as `AIGenProviderConfig`. */
export interface ProviderCredential {
  presetId: string
  endpoint: string
  hasApiKey: boolean
  endpointClass: EndpointClass
}

/** Outcome of `setAiProviderCredential` (T1.6) — the per-preset analogue of
 *  `SetProviderResult`. Same `requiresPrivacyConsent` semantics; `presetId`
 *  replaces `provider` since the credential registry is keyed by preset id,
 *  not by an active slot's provider id. */
export interface SetCredentialOutcome {
  presetId: string
  endpointClass: EndpointClass
  requiresPrivacyConsent: boolean
}

/** Outcome of `testAiProviderCredential` (T1.6) — a transient probe result,
 *  never persisted. `dim` is populated only for an embedding probe;
 *  `modelCount` only for a `local`-group reachability probe. At most one of
 *  `dim` / `modelCount` is ever populated. */
export interface TestCredentialOutcome {
  latencyMs: number
  dim: number | null
  modelCount: number | null
}

/** Outcome of `test_ai_generation_provider` / `test_ai_embedding_provider`.
 *  `dim` is populated only for the embed probe — chat probe returns
 *  `dim: null`. */
export interface SlotTestResult {
  latencyMs: number
  dim: number | null
}

export interface SetProviderResult {
  provider: string
  endpointClass: EndpointClass
  /** True iff the saved slot's endpoint class has **not** been accepted
   *  yet. The Settings panel uses this signal to pop the consent modal
   *  right after a save that promoted the slot to a new class (e.g.
   *  switching from a local Ollama to OpenAI for the first time).
   *
   *  Persisting a config NEVER wipes any privacy receipt — acceptance
   *  is recorded per endpoint class and survives provider swaps inside
   *  the same class. This flag is a read-only hint. */
  requiresPrivacyConsent: boolean
}

/** Comprehensive snapshot read by the Settings panel on mount + after
 *  every save. Mirrors `commands::ai_settings::AIFullSettings`. */
export interface AIFullSettings {
  provider: string | null
  endpoint: string | null
  endpointClass: EndpointClass | null
  chatModel: string | null
  embeddingModel: string | null
  hasApiKey: boolean
  /** Unified privacy receipt for non-local AI providers. `null` = the
   *  user has not yet accepted the notice. Local endpoints are
   *  auto-exempt. One acceptance covers hosted APIs, subscription
   *  CLIs, and multi-entry AI features that send journal text
   *  off-device. Unix epoch seconds. */
  privacyAcceptedAt: number | null
  semanticSearchEnabled: boolean
  emotionSuggestionsEnabled: boolean
  titleSuggestionsEnabled: boolean
  entryHighlightsEnabled: boolean
  goDeeperEnabled: boolean
  /** AI prose writing inside the editor. Default ON when unset. Covers both
   *  the footer's "Continue writing with your voice" and the bubble-menu
   *  Rewrite — one gate in the backend's shared `editor_prose_inner`. */
  continueWritingEnabled: boolean
  dailyChatEnabled: boolean
  /** "Use my memories in Daily Chat". Fail-closed: default `false` like
   *  `chatRagEnabled`, unlike the default-on toggles. Narrower than
   *  `userMemoryEnabled`: turning it off stops injection into chat while
   *  memory extraction keeps running. */
  chatMemoryEnabled: boolean
  imageGenerationEnabled: boolean
  multiEntrySummaryEnabled: boolean
  periodicReviewEnabled: boolean
  insightsEnabled: boolean
  /** Dashboard insights card. Fail-closed: default `false` unlike the
   *  default-on toggles — a missing backend key means OFF. UI-only gate;
   *  backend generation stays `INSIGHTS_ENABLED`. */
  dashboardInsightsEnabled: boolean
  tagSuggestionsEnabled: boolean
  /** Auto-RAG in Daily Chat. Fail-closed: default `false` unlike the
   *  default-on toggles above — a missing backend key means OFF. */
  chatRagEnabled: boolean
  // ── Memory feature model slots (Phase 2 of ai-user-memory) ──────────────
  //
  // The `user_memory` feature has its OWN independent slot pair
  // (memory_generation / memory_embedding), separate from the app-wide
  // gen/embed slots above. Both must be configured for the feature to run.
  // These flat fields mirror the backend's camelCase serde output of the
  // `memory_*` rows on `AIFullSettings` (`#[serde(rename_all = "camelCase")]`
  // in `commands/ai_settings.rs`). The api_key VALUE is never returned —
  // only `*HasApiKey: boolean`.
  /** Master preference toggle for AI User Memory (`ai_user_memory_enabled`).
   *  Default ON when unset. Runtime work still requires both memory slots
   *  configured — check `memoryGenProvider` / `memoryEmbedProvider` (or the
   *  store's assembled `memoryGen` / `memoryEmbed`) for slot readiness. */
  userMemoryEnabled: boolean
  /** "Use persona" — mirrors the `user_persona.enabled` column, not a settings
   *  key. Independent of `userMemoryEnabled`: persona can be on while memory is
   *  off. Defaults ON (the persona row is seeded enabled); an empty persona is
   *  simply a no-op at prompt-build time. */
  personaEnabled: boolean
  memoryGenProvider: string | null
  memoryGenEndpoint: string | null
  memoryGenEndpointClass: EndpointClass | null
  memoryGenChatModel: string | null
  memoryGenHasApiKey: boolean
  memoryEmbedProvider: string | null
  memoryEmbedEndpoint: string | null
  memoryEmbedEndpointClass: EndpointClass | null
  memoryEmbedEmbeddingModel: string | null
  memoryEmbedHasApiKey: boolean
  titleSuggestionsSystemPrompt: string
  entryHighlightsSystemPrompt: string
  multiEntrySummarySystemPrompt: string
  goDeeperSystemPrompt: string
  dailyChatPersona: string
  dailyChatCustomPersona: string
  /** When true, Daily Chat runs an extra LLM call to generate the
   *  session title from the first user message. Default false — the
   *  truncated first-user-message title is used instead. */
  dailyChatAiTitle: boolean
  /** Global AI response language applied to every generation feature —
   *  "auto" (default) | "en" | "vi" | a custom English language name
   *  (e.g. "French"). See [`ResponseLanguagePreset`]. */
  responseLanguage: string
  /** Emotion-suggestion prototype language. One of: "auto" (default,
   *  falls back to `responseLanguage`), "en", "vi", "fr", "es",
   *  "zh-Hans", "zh-Hant". See [`EmotionSuggestionLanguage`]. */
  emotionSuggestionLanguage: string
}

/** Presets shown in the global response-language picker. A "Custom"
 *  selection stores any other trimmed, non-empty string as the English
 *  name of the desired language (e.g. "French", "Japanese"). */
export type ResponseLanguagePreset = 'auto' | 'en' | 'vi'

/** Allow-list of supported emotion-suggestion prototype languages. `"auto"`
 *  defers to the global `responseLanguage` setting (falling back to `"en"`
 *  when that is also `"auto"` or an unsupported custom name). The feature
 *  ships pre-tuned vector sets for the rest; adding a new language requires
 *  shipping a matching `EMOTION_PROTOTYPES_*` block in
 *  `src-tauri/src/ai/emotion.rs` and updating the allow-list in the
 *  `set_emotion_suggestion_language` Tauri command. */
export type EmotionSuggestionLanguage = 'auto' | 'en' | 'vi' | 'fr' | 'es' | 'zh-Hans' | 'zh-Hant'

export interface MigrationOutcome {
  ran: boolean
  orphanRowsDeleted: number
  modelsDirRemoved: boolean
}

// ─── AI Audit Log (Phase 6 Stretch S2-2) ────────────────────────────────────

/** Operation types recorded in the audit log. Matches the Rust `operation` column. */
export type AiAuditOperation = 'chat' | 'chat_stream' | 'embed' | 'generate_image'

/** Call outcome. Matches the Rust `status` column. */
export type AiAuditStatus = 'ok' | 'err'

/**
 * One row from `ai_audit_log`.
 *
 * Field names are snake_case to match the Rust serde output (no
 * `rename_all = "camelCase"` on the backend struct). NO content fields
 * are present — the log stores metadata only.
 *
 * `device_id` + `local_seq` together form the row's primary key — a row
 * pulled from a peer keeps the peer's `device_id` so the UI can label
 * "this device" vs. "device <peer>" if it wants to.
 */
export interface AiAuditLogRow {
  device_id: string
  local_seq: number
  created_at: number // unix ms
  feature: string
  operation: AiAuditOperation
  provider_id: string
  model_id: string
  endpoint_host: string
  endpoint_class: EndpointClass
  payload_bytes: number
  latency_ms: number
  status: AiAuditStatus
  error_code: string | null
  tokens_in: number | null
  tokens_out: number | null
  /** Snapshot of the machine display name at request time (may be empty
   *  for historical rows or older peers). */
  device_name: string
}

/**
 * Filter passed to `list_ai_audit_log`.
 *
 * All array fields use IN-clause matching on the backend. An empty
 * array is treated the same as omitting the field (no filter applied).
 * `since` is a unix-ms lower-bound (inclusive) on `created_at`.
 *
 * Field names are snake_case to match the Rust serde input shape.
 */
export interface AiAuditLogFilter {
  features?: string[]
  providers?: string[]
  classifications?: EndpointClass[]
  /** Unix ms — rows with created_at >= since are returned. */
  since?: number
}

// ─── AI Usage Dashboard (Phase 6 Stretch S3) ─────────────────────────────────

/** Time-range selector for the Usage dashboard.
 *  Matches the Rust `UsagePeriod` serde wire format. */
export type UsagePeriod = '24h' | '7d' | '30d' | '90d' | 'all'

/** Headline totals over the requested period.
 *  NULL tokens are excluded from sums; `null_token_calls` counts rows
 *  that had at least one NULL token field. */
export interface AiUsageHeadline {
  calls: number
  tokens_in: number
  tokens_out: number
  payload_bytes: number
  /** How many rows in the period had NULL tokens_in or tokens_out. */
  null_token_calls: number
}

/** One grouped row in the provider × model × feature breakdown. */
export interface AiUsageBreakdownRow {
  provider_id: string
  model_id: string
  feature: string
  calls: number
  tokens_in: number
  tokens_out: number
  payload_bytes: number
  avg_latency_ms: number
  /** 0..1 */
  error_rate: number
  /** How many rows in this group had NULL tokens_in or tokens_out.
   *  When null_token_calls === calls the UI should show "—" instead of "0". */
  null_token_calls: number
}

/** One point in the daily tokens-out series.
 *  `date` is `YYYY-MM-DD` in the user's local timezone. */
export interface AiUsageDailyPoint {
  date: string
  calls: number
  tokens_in: number
  tokens_out: number
}

/** Headline totals split by provider. */
export interface PerProviderRow {
  provider_id: string
  calls: number
  tokens_in: number
  tokens_out: number
  payload_bytes: number
  null_token_calls: number
}

/** Complete usage summary returned by `summarize_ai_usage`. */
export interface AiUsageSummary {
  period: UsagePeriod
  /** Unix-ms lower-bound used for the filter. */
  since_ms: number
  headline: AiUsageHeadline
  per_provider: PerProviderRow[]
  breakdown: AiUsageBreakdownRow[]
  daily: AiUsageDailyPoint[]
}

// ─── Backfill (kept for R5 wiring) ───────────────────────────────────────────

export interface BackfillStatus {
  running: boolean
  model_id: string | null
  indexed: number
  total: number
}

export interface BackfillProgressEvent {
  model_id: string
  indexed: number
  total: number
  current_entry_id: string
}

export interface BackfillCompleteEvent {
  model_id: string
  indexed: number
  total: number
  cancelled: boolean
}

/** Emitted once when the embedding-slot identity (`provider_id:embedding_model`)
 *  actually changes (Phase 2 Task 6) — never fired for a generation-slot
 *  swap or an embedding API-key rotation on the same provider/model.
 *  `enqueued` is how many entries were just marked pending for the new
 *  model. `requires_consent` is true when the new slot is hosted, since
 *  the backend just cleared background-indexing consent for the old
 *  identity — the worker makes zero provider calls until the user
 *  re-consents. Phase 3 builds the UI that reacts to this. */
export interface BackfillModelChangedEvent {
  model_id: string
  enqueued: number
  requires_consent: boolean
}

/** Emitted while an opt-in on-device model download is in flight
 *  (`start_on_device_model_download`, Phase 4 Task 5). `progress` is 0-100;
 *  100 marks the download as finished. */
export interface ModelDownloadProgressEvent {
  model_id: string
  progress: number
}

/** Emitted when an on-device model download fails. `error` is the
 *  `DownloadState::Error` code string (stable, not a display message). */
export interface ModelDownloadErrorEvent {
  model_id: string
  error: string
}

export type PeriodReviewKind = 'weekly' | 'monthly'

export interface PeriodReviewResult {
  kind: PeriodReviewKind
  start: number
  end: number
  entryCount: number
  highlights: string[]
  lowlights: string[]
  themes: string[]
  insight: string
  cached: boolean
  modelId: string
  createdAt: number
}

export interface ThemeInsightsResult {
  start: number
  end: number
  entryCount: number
  themes: string[]
  moodDrivers: string[]
  cached: boolean
  modelId: string
}

/** Bundle flat wire meta fields into `AiMessageMeta` when any identity field is present. */
export function aiMessageMetaFromWire(fields: {
  modelId?: string | null
  providerId?: string | null
  endpointClass?: EndpointClass | null
  tokensIn?: number | null
  tokensOut?: number | null
  latencyMs?: number | null
}): AiMessageMeta | null {
  if (fields.modelId == null && fields.providerId == null) return null
  return {
    modelId: fields.modelId ?? null,
    providerId: fields.providerId ?? null,
    endpointClass: fields.endpointClass ?? null,
    tokensIn: fields.tokensIn ?? null,
    tokensOut: fields.tokensOut ?? null,
    latencyMs: fields.latencyMs ?? null,
  }
}

export interface EmbeddingIndexStats {
  model_id: string | null
  indexed: number
  total: number
  pending: number
}

// ─── Embedding sync decision (multi-device model mismatch / key blocks) ─────
// Mirrors `src-tauri/src/commands/ai_embedding_decision.rs` wire types
// (`#[serde(rename_all = "camelCase")]` on structs; enums use snake_case).

/** Which embedding pipeline a decision receipt belongs to. */
export type EmbedSyncSlot = 'entry' | 'memory'

/** User / system decision state for one slot (Rust enum → snake_case). */
export type EmbedSyncDecisionState = 'none' | 'pending' | 'reembed' | 'switch' | 'pause'

/** Why the slot entered `pending` (or related blocked states). */
export type EmbedSyncDecisionReason =
  | 'model_mismatch'
  | 'missing_key'
  | 'invalid_key'
  | 'unconfigured'

/** One peer model observed during a pull, with how many vectors mismatched. */
export interface PeerModelCountView {
  modelId: string
  count: number
}

/** Per-slot decision snapshot returned by `get_embedding_sync_decisions`. */
export interface EmbedSyncDecisionSlotView {
  slot: EmbedSyncSlot | string
  state: EmbedSyncDecisionState
  reason: EmbedSyncDecisionReason | null
  localModelId: string | null
  peerModels: PeerModelCountView[]
  pendingUnits: number
  /** `true` when FE should surface the modal / chip (pending or pause). */
  needsModal: boolean
}

export interface EmbeddingSyncDecisionsResponse {
  slots: EmbedSyncDecisionSlotView[]
  /** Convenience: any slot has `needsModal`. */
  needsModal: boolean
}

/** Payload of `ai:embedding-decision-needed`. */
export interface EmbeddingDecisionNeededEvent {
  slots: EmbedSyncDecisionSlotView[]
}

export type EmbedSyncDecisionAction = 'reembed' | 'switch' | 'pause'

/** Modal Pause writes `sync_backfill`. Absent on old receipts → `all`. */
export type EmbedPauseScope = 'all' | 'sync_backfill'

export interface ResolveEmbeddingSyncDecisionArgs {
  slot: EmbedSyncSlot | string
  action: EmbedSyncDecisionAction
  /** Required for `switch` — typically `provider:model`. */
  targetModelId?: string
  /** Pause only. Modal sends `sync_backfill` (local edits keep indexing). */
  pauseScope?: EmbedPauseScope
}

export interface ResolveEmbeddingSyncDecisionResult {
  ok: boolean
  nextState: EmbedSyncDecisionState
  needsKey: boolean
  error?: string
}

// ─── Provider presets (UI-only; the backend doesn't see these) ───────────────

/** Capabilities a provider exposes. The two slots in the Settings
 *  panel filter the preset list by required capability:
 *  - Generation tab (chat + image) shows presets with `'chat'`
 *  - Embedding tab shows presets with `'embed'`
 *  - The image-model field within the Generation tab is hidden when
 *    the selected preset lacks `'image'`. */
export type ProviderCapability = 'chat' | 'embed' | 'image'

/** Curated list of providers shown in the Settings dropdown. The Local
 *  group is rendered first and visually highlighted as the recommended
 *  privacy-first path. */
export interface ModelSuggestion {
  /** Model id sent over the wire (e.g. `"llama3.1"`, `"gpt-4o-mini"`). */
  value: string
  /** Optional one-line annotation shown next to the value in the
   *  dropdown — e.g. "fast & cheap", "best quality", "needs 16GB RAM". */
  description?: string
}

export type PresetGroup = 'hosted' | 'cli' | 'local' | 'integrated'

export interface ProviderPreset {
  id: string
  label: string
  group: PresetGroup
  endpoint: string
  /** What this provider can do. Drives the per-slot dropdown filter
   *  — Claude is chat-only and must NOT appear in the embedding
   *  picker; Voyage is embed-only and must NOT appear in the
   *  generation picker. */
  capabilities: ProviderCapability[]
  /** Default models filled into the inputs when the preset is picked.
   *  Users can override per-provider. */
  chatModel: string
  embeddingModel: string
  imageModel: string | null
  /** Curated suggestion lists shown in the model combobox. The default
   *  (`chatModel` / `embeddingModel` / `imageModel`) should appear in
   *  these arrays so the user sees their starting choice in context. */
  chatModelSuggestions?: ModelSuggestion[]
  embeddingModelSuggestions?: ModelSuggestion[]
  imageModelSuggestions?: ModelSuggestion[]
  /** Local servers usually don't require auth; hosted ones do. The
   *  Settings panel hides the API-key input when this is `false` and
   *  the user hasn't ticked "Add an API key". */
  requiresApiKey: boolean
  /** Link to upstream installer / docs. */
  setupUrl: string
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  // 🔒 Privacy-first / fully local
  {
    id: 'ollama',
    label: 'Ollama',
    group: 'local',
    capabilities: ['chat', 'embed'],
    endpoint: 'http://127.0.0.1:11434/v1',
    // Default = the suggestion the panel pre-selects on first pick.
    // It's the recommended starting point for most users (good
    // quality-to-resource ratio); power users can switch via the
    // combobox.
    chatModel: 'qwen3.5:4b',
    embeddingModel: 'nomic-embed-text',
    imageModel: null,
    chatModelSuggestions: [
      {
        value: 'qwen3.5:4b',
        description: 'Optimized — 3.4GB, 256K context, multimodal. Best pick under 4GB.',
      },
      {
        value: 'gemma4:e4b',
        description:
          'More powerful — 9.6GB, Gemma 4 effective-4B. Natural conversation flow, multimodal.',
      },
    ],
    embeddingModelSuggestions: [
      {
        value: 'nomic-embed-text',
        description: 'Optimized — 768-dim, fast, high-quality general embeddings.',
      },
      { value: 'mxbai-embed-large', description: 'More powerful — 1024-dim, slower but sharper.' },
    ],
    setupUrl: 'https://ollama.com',
    requiresApiKey: false,
  },
  {
    id: 'lmstudio',
    label: 'LM Studio',
    group: 'local',
    capabilities: ['chat', 'embed'],
    endpoint: 'http://127.0.0.1:1234/v1',
    chatModel: '',
    embeddingModel: '',
    imageModel: null,
    requiresApiKey: false,
    setupUrl: 'https://lmstudio.ai',
  },
  {
    id: 'llama-server',
    label: 'llama.cpp llama-server',
    group: 'local',
    capabilities: ['chat', 'embed'],
    endpoint: 'http://127.0.0.1:8080/v1',
    chatModel: '',
    embeddingModel: '',
    imageModel: null,
    requiresApiKey: false,
    setupUrl: 'https://github.com/ggml-org/llama.cpp',
  },
  {
    id: 'other-local',
    label: 'Other local server',
    group: 'local',
    // Liberal default — user runs whatever they run. The Settings
    // panel still trusts them.
    capabilities: ['chat', 'embed', 'image'],
    endpoint: 'http://127.0.0.1:8080/v1',
    chatModel: '',
    embeddingModel: '',
    imageModel: null,
    requiresApiKey: false,
    setupUrl: '',
  },
  {
    id: 'on-device',
    label: 'Integrated embedding models',
    group: 'integrated',
    // Embedding-only — there is no on-device chat/generation path in
    // Memlore (see CLAUDE.md). Pair with a chat/CLI provider above.
    capabilities: ['embed'],
    // Empty endpoint — this isn't an HTTP server; the backend's
    // `on-device` provider runs `fastembed` in-process and is auto-
    // consented (no hosted-token privacy notice), matching the CLI
    // providers' empty-endpoint convention.
    endpoint: '',
    chatModel: '',
    embeddingModel: 'multilingual-e5-base',
    imageModel: null,
    requiresApiKey: false,
    setupUrl: '',
  },
  {
    id: 'on-device-llm',
    label: 'Integrated chat models',
    group: 'integrated',
    // Chat-only on-device generation via a bundled llama.cpp llama-server
    // sidecar — NO embed (reuse the `on-device` preset above for that),
    // NO image. Pair with a separate embed provider for semantic search.
    capabilities: ['chat'],
    // Empty endpoint — the backend spawns llama-server on a random
    // localhost port and points the OpenAICompatibleProvider at it; the
    // user never types a URL. Auto-consented (nothing leaves the machine),
    // matching the on-device embedding preset's convention.
    endpoint: '',
    // The recommended default catalog id (hydrated from the backend
    // catalog by `useOnDeviceLlmModels`).
    chatModel: 'gemma-4-e4b-it',
    embeddingModel: '',
    imageModel: null,
    requiresApiKey: false,
    setupUrl: '',
  },

  // 🔐 Local CLI providers — reuse a CLI binary already signed-in
  //    via the user's Claude / ChatGPT Plus subscription. No API
  //    key in Memlore; auth lives in the CLI's own keychain.
  //    Chat-only (the CLIs don't expose embeddings) — pair with a
  //    separate embed provider (Voyage / Ollama / OpenAI / …) if
  //    semantic search or emotion suggestions are wanted.
  {
    id: 'claude-cli',
    label: 'Claude CLI (subscription)',
    group: 'cli',
    capabilities: ['chat'],
    // Empty endpoint — the backend `provider_uses_subprocess` check
    // skips URL validation for this id and spawns a subprocess.
    endpoint: '',
    chatModel: 'sonnet',
    embeddingModel: '',
    imageModel: null,
    chatModelSuggestions: [
      {
        value: 'sonnet',
        description: 'Recommended — Claude Sonnet 4.6, balanced quality and speed.',
      },
      {
        value: 'opus',
        description: 'Higher quality — Claude Opus 4.7, slower and uses more of your quota.',
      },
      {
        value: 'haiku',
        description: 'Fastest — Claude Haiku 4.5, lower quality but cheapest on quota.',
      },
    ],
    requiresApiKey: false,
    setupUrl: 'https://docs.claude.com/claude-code',
  },
  {
    id: 'codex-cli',
    label: 'Codex CLI (ChatGPT Plus)',
    group: 'cli',
    capabilities: ['chat'],
    endpoint: '',
    chatModel: 'gpt-5.4',
    embeddingModel: '',
    imageModel: null,
    chatModelSuggestions: [
      {
        value: 'gpt-5.4',
        description: 'Recommended — GPT-5.4, balanced quality and speed.',
      },
      {
        value: 'gpt-5.5',
        description: 'Latest — GPT-5.5 if your plan has access (Plus accounts may not).',
      },
    ],
    requiresApiKey: false,
    setupUrl: 'https://github.com/openai/codex',
  },

  // 🌍 Hosted
  {
    id: 'openai',
    label: 'OpenAI',
    group: 'hosted',
    capabilities: ['chat', 'embed', 'image'],
    endpoint: 'https://api.openai.com/v1',
    // gpt-5.5-mini is not confirmed to exist as of this refresh (mid-2026) —
    // defaulting to gpt-5-mini until confirmed. Reasoning-suppression note:
    // the strict-dialect gate (openai_compat.rs) only sends
    // `reasoning_effort:"none"` for gpt-5.5/5.6-tier models, so this
    // default currently runs at OpenAI's default reasoning effort.
    chatModel: 'gpt-5-mini',
    embeddingModel: 'text-embedding-3-small',
    imageModel: 'gpt-image-2',
    chatModelSuggestions: [
      {
        value: 'gpt-5-mini',
        description: 'Optimized — near-frontier capability for cost-sensitive workloads.',
      },
      { value: 'gpt-5.5', description: 'Flagship — smartest for complex reasoning & coding.' },
      { value: 'gpt-5.5-pro', description: 'Most precise variant of GPT-5.5.' },
    ],
    embeddingModelSuggestions: [
      { value: 'text-embedding-3-small', description: 'Optimized — 1536-dim, fast, cheap.' },
      { value: 'text-embedding-3-large', description: 'More powerful — 3072-dim, ~6× cost.' },
    ],
    imageModelSuggestions: [
      { value: 'gpt-image-2', description: 'Optimized — state-of-the-art image generation.' },
    ],
    requiresApiKey: true,
    setupUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    group: 'hosted',
    // Chat-only via the OpenAI-compat shim — see the comment below.
    capabilities: ['chat'],
    // Anthropic ships an OpenAI-compatible shim at /v1 that handles
    // /chat/completions (incl. streaming, vision, tool use). It does NOT
    // expose /embeddings or image generation — embedding-dependent
    // features (semantic search, emotion suggestions) need a separate
    // provider (Voyage / OpenAI / a local server) until a native
    // AnthropicProvider impl lands. Per Anthropic docs, the shim also
    // ignores prompt caching, strips audio input, hoists system/developer
    // messages to a single initial system message, and ignores `strict`
    // tool schemas — switch to the native /v1/messages API for those.
    endpoint: 'https://api.anthropic.com/v1',
    chatModel: 'claude-haiku-4-5',
    embeddingModel: '',
    imageModel: null,
    chatModelSuggestions: [
      {
        value: 'claude-haiku-4-5',
        description: 'Optimized — fastest + cheapest, near-frontier quality for daily use.',
      },
      {
        value: 'claude-sonnet-5',
        description: 'Balanced — near-flagship quality, 1M context.',
      },
      {
        value: 'claude-opus-5',
        description: 'Most powerful — flagship for complex reasoning, 1M context.',
      },
    ],
    requiresApiKey: true,
    setupUrl: 'https://console.anthropic.com/settings/keys',
  },
  {
    id: 'gemini',
    label: 'Gemini',
    group: 'hosted',
    // Imagen / Nano Banana are NOT exposed through the OpenAI-compat shim —
    // only the native Gemini API. See the imageModel comment below.
    capabilities: ['chat', 'embed'],
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai',
    // Gemini 3 is the current generation — moving the default off 2.5.
    chatModel: 'gemini-3.6-flash',
    embeddingModel: 'gemini-embedding-001',
    // Imagen + Nano Banana (2 / Pro) live behind the native Gemini API
    // (`:generateContent` / `/v1beta`), not the OpenAI-compat shim at
    // `/v1beta/openai`. Leave null so the panel hides the image-model
    // field; users who want image gen pick OpenAI / xAI / Together.
    imageModel: null,
    chatModelSuggestions: [
      {
        value: 'gemini-3.6-flash',
        description: 'Optimized — newest Flash, near-Pro quality, fast + cheap.',
      },
      {
        value: 'gemini-3.1-pro-preview',
        description: 'Flagship (preview) — deepest reasoning, most capable.',
      },
      {
        value: 'gemini-3.1-flash-lite',
        description: 'Cheapest — fastest, lowest cost.',
      },
    ],
    embeddingModelSuggestions: [
      {
        value: 'gemini-embedding-001',
        description: 'Optimized — stable, high-quality text embeddings.',
      },
      {
        value: 'gemini-embedding-2',
        description: 'More powerful — multimodal (text/image/audio/video), 3072-dim.',
      },
    ],
    requiresApiKey: true,
    setupUrl: 'https://aistudio.google.com/app/apikey',
  },
  {
    id: 'xai',
    label: 'xAI',
    group: 'hosted',
    // xAI's `grok-embedding-small`
    // is exposed only through the proprietary Collections API, not the
    // standard `/v1/embeddings` endpoint, so embedding is unavailable here.
    capabilities: ['chat', 'image'],
    endpoint: 'https://api.x.ai/v1',
    // Grok 4.5 is xAI's current flagship — default to it. The HTTP policy
    // omits OpenAI-specific reasoning parameters for xAI compatibility.
    chatModel: 'grok-4.5',
    embeddingModel: '',
    imageModel: 'grok-imagine-image-quality',
    chatModelSuggestions: [
      {
        value: 'grok-4.5',
        description: 'Optimized — flagship, tops agentic + instruction-following benchmarks.',
      },
    ],
    imageModelSuggestions: [
      {
        value: 'grok-imagine-image-quality',
        description: 'High-quality image generation with Grok Imagine.',
      },
    ],
    requiresApiKey: true,
    setupUrl: 'https://console.x.ai',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    group: 'hosted',
    capabilities: ['chat', 'embed'],
    endpoint: 'https://openrouter.ai/api/v1',
    chatModel: 'meta-llama/llama-3.3-70b-instruct',
    embeddingModel: 'openai/text-embedding-3-small',
    imageModel: null,
    chatModelSuggestions: [
      {
        value: 'meta-llama/llama-3.3-70b-instruct',
        description: 'Optimized — strong open-weight 70B, cheap.',
      },
      {
        value: 'anthropic/claude-haiku-4-5',
        description: 'More powerful — Claude Haiku 4.5 via OpenRouter.',
      },
    ],
    embeddingModelSuggestions: [
      {
        value: 'openai/text-embedding-3-small',
        description: 'Optimized — proxied OpenAI embeddings.',
      },
      {
        value: 'openai/text-embedding-3-large',
        description: 'More powerful — higher quality, more expensive.',
      },
    ],
    requiresApiKey: true,
    setupUrl: 'https://openrouter.ai/keys',
  },
  {
    id: 'together',
    label: 'Together',
    group: 'hosted',
    capabilities: ['chat', 'embed', 'image'],
    endpoint: 'https://api.together.xyz/v1',
    chatModel: 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo',
    embeddingModel: 'togethercomputer/m2-bert-80M-8k-retrieval',
    imageModel: 'black-forest-labs/FLUX.1-schnell-Free',
    chatModelSuggestions: [
      {
        value: 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo',
        description: 'Optimized — small + cheap 8B Turbo.',
      },
      {
        value: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
        description: 'More powerful — fast 70B Turbo.',
      },
    ],
    embeddingModelSuggestions: [
      {
        value: 'togethercomputer/m2-bert-80M-8k-retrieval',
        description: 'Optimized — 8k context, retrieval-tuned.',
      },
      {
        value: 'BAAI/bge-large-en-v1.5',
        description: 'More powerful — higher quality, 1024-dim.',
      },
    ],
    imageModelSuggestions: [
      {
        value: 'black-forest-labs/FLUX.1-schnell-Free',
        description: 'Optimized — free tier.',
      },
      {
        value: 'black-forest-labs/FLUX.1-pro',
        description: 'More powerful — higher quality, paid.',
      },
    ],
    requiresApiKey: true,
    setupUrl: 'https://api.together.ai/settings/api-keys',
  },
  {
    id: 'groq',
    label: 'Groq',
    group: 'hosted',
    // Chat-only; no /embeddings, no image gen.
    capabilities: ['chat'],
    endpoint: 'https://api.groq.com/openai/v1',
    chatModel: 'llama-3.1-8b-instant',
    embeddingModel: '',
    imageModel: null,
    chatModelSuggestions: [
      { value: 'llama-3.1-8b-instant', description: 'Optimized — ultra-fast 8B on Groq LPU.' },
      {
        value: 'llama-3.3-70b-versatile',
        description: 'More powerful — 70B on Groq LPU, still fast.',
      },
    ],
    requiresApiKey: true,
    setupUrl: 'https://console.groq.com/keys',
  },
  {
    id: 'voyage',
    label: 'Voyage AI',
    group: 'hosted',
    // Embeddings only — Voyage doesn't ship a chat or image API. The
    // canonical pairing with Anthropic (Claude) for users who want
    // strong chat + strong embeddings without OpenAI.
    capabilities: ['embed'],
    // Voyage's REST API at /v1/embeddings is shape-compatible with
    // the OpenAI Embeddings API (same request body, same response
    // envelope), so `OpenAICompatibleProvider` works as-is.
    endpoint: 'https://api.voyageai.com/v1',
    chatModel: '',
    embeddingModel: 'voyage-4',
    imageModel: null,
    embeddingModelSuggestions: [
      {
        value: 'voyage-4',
        description: 'Optimized — 1024-dim, strong general-purpose + multilingual retrieval.',
      },
      {
        value: 'voyage-4-large',
        description: 'More powerful — best retrieval quality, 1024-dim default.',
      },
      {
        value: 'voyage-4-lite',
        description: 'Cheapest — latency-optimized, lower cost.',
      },
    ],
    requiresApiKey: true,
    setupUrl: 'https://dashboard.voyageai.com',
  },

  // 🛂 Custom
  {
    id: 'custom',
    label: 'Custom',
    group: 'hosted',
    // Liberal default — user knows their endpoint. Shown in both
    // generation and embedding pickers.
    capabilities: ['chat', 'embed', 'image'],
    endpoint: '',
    chatModel: '',
    embeddingModel: '',
    imageModel: null,
    requiresApiKey: true,
    setupUrl: '',
  },
]

export function getPreset(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => p.id === id)
}

/** Provider ids that are served by spawning a local CLI subprocess
 *  rather than by making an HTTP request. They have no endpoint URL
 *  and no API key — auth lives in the CLI's own keychain.
 *
 *  Keep this in sync with the Rust-side `provider_uses_subprocess`
 *  helper in `src-tauri/src/commands/ai_provider.rs`. */
export const SUBPROCESS_PROVIDER_IDS = new Set(['claude-cli', 'codex-cli'])

export function providerUsesSubprocess(id: string): boolean {
  return SUBPROCESS_PROVIDER_IDS.has(id)
}

/** The `on-device` providers run fully in-process — like the CLI
 *  providers they have no endpoint URL and no API key, but their model
 *  comes from an on-device catalog picker (see `OnDeviceModelPicker` for
 *  embedding, `OnDeviceLlmModelPicker` for chat) rather than a free-text
 *  model field, so the Settings panel hides both the Connection card and
 *  the free-text Models card for them. Both ids are auto-consented
 *  (nothing leaves the machine).
 *
 *  - `on-device`     — embedding-only, runs `fastembed` in-process.
 *  - `on-device-llm` — chat-only, spawns a bundled `llama-server` sidecar.
 *
 *  Keep in sync with the Rust-side `ON_DEVICE_PROVIDER_ID` /
 *  `ON_DEVICE_LLM_ID` in `src-tauri/src/commands/ai_provider.rs`. */
export function providerIsOnDevice(id: string): boolean {
  return id === 'on-device' || id === 'on-device-llm'
}

/** Filter `PROVIDER_PRESETS` to those exposing a given capability.
 *  Used by the Settings panel to populate the per-slot dropdown:
 *  the Generation tab calls `getPresetsByCapability('chat')` and the
 *  Embedding tab calls `getPresetsByCapability('embed')`. */
export function getPresetsByCapability(cap: ProviderCapability): ProviderPreset[] {
  return PROVIDER_PRESETS.filter((p) => p.capabilities.includes(cap))
}

// ─── Phase 6 v2 R9 v2 — Daily Chat persistent sessions ──────────────────────

/** Lightweight metadata row for the session list. The full message
 *  history lives in `ChatSession` and is loaded on demand. */
export interface ChatSessionMeta {
  id: string
  title: string | null
  createdAt: number
  updatedAt: number
  /** Total number of messages persisted for this session (user + assistant). */
  messageCount: number
  /** Sticky: true once any turn in this conversation injected journal content.
   *  Never cleared. Drives the indicator in the session list — a privacy
   *  disclosure telling the user which conversations already sent their
   *  entries to an AI provider. */
  usedRag: boolean
  /** Epoch SECONDS when the session was pinned (same unit as `createdAt` /
   *  `updatedAt` — the Rust `now_unix()` is `.as_secs()`), `null` when
   *  unpinned. Drives the pin-to-top sort and the menu's Pin/Unpin label. */
  pinnedAt: number | null
  /** The entry this session was last converted into, or `null` when it has
   *  never been saved as an entry. Drives the filled accent dot on the
   *  conversation-list icon. */
  convertedEntryId: string | null
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  seq: number
  createdAt: number
  modelId?: string | null
  providerId?: string | null
  endpointClass?: EndpointClass | null
  tokensIn?: number | null
  tokensOut?: number | null
  latencyMs?: number | null
  /** What the user attached to THIS turn — user rows only. Rendered as chips
   *  above the message bubble, so a months-old transcript still shows what the
   *  model was actually given. */
  attachments?: ChatAttachmentRef[] | null
  /** Entry ids whose content actually reached the prompt — assistant rows
   *  only. Drives the source chips under an answer. */
  sourceEntryIds?: string[] | null
  /** Memory item ids folded into this reply's prompt — assistant rows only.
   *  Texts are resolved live (not persisted verbatim) via `listMemoryItems`,
   *  so a since-deleted/disabled memory drops out of the "N memories used"
   *  chip instead of showing a stale count. */
  memoryIds?: string[] | null
}

export interface ChatSession {
  id: string
  title: string | null
  persona: string
  language: string
  createdAt: number
  updatedAt: number
  messages: ChatMessage[]
  /** The entry id this session was last converted into, or `null` when
   *  the session has never been saved as an entry. Mirrors
   *  `ChatSessionWire.converted_entry_id`. */
  convertedEntryId: string | null
  /** Highest persisted assistant message seq already folded into
   *  {@link convertedEntryId}. `null` when nothing has been converted
   *  yet. Mirrors `ChatSessionWire.converted_through_seq`. */
  convertedThroughSeq: number | null
}

export type DailyChatPersona =
  | 'empathetic'
  | 'tough'
  | 'jolly'
  | 'wise'
  | 'custom'
  | 'cbt_reframe'
  | 'gratitude'
  | 'inversion'
  | 'stoic'

// ─── RAG in Daily Chat — attachments + context preflight ───────────────────

/** The narrow shape that crosses the IPC boundary and lands verbatim in
 *  the `chat_messages.attachments` JSON column. `period.start` is
 *  **inclusive**, `period.end` is **exclusive** — matching
 *  `list_entries_with_content_for_date_range`'s `[from_ts, to_ts)` contract.
 *
 *  Rust also has a `ChatAttachmentRef::Unknown` `#[serde(other)]`
 *  catch-all so one future attachment kind cannot fail a whole peer sync
 *  payload. It is **read-only and never persisted or emitted**, so it
 *  deliberately has no counterpart here — the frontend only ever sees
 *  `entry` / `period`. */
export type ChatAttachmentRef =
  | { kind: 'entry'; id: string }
  | { kind: 'period'; start: number; end: number; label: string }

/** The richer shape held in component state (chip rendering, picker
 *  results) before it is narrowed down to a `ChatAttachmentRef` for the
 *  wire. */
export type ChatAttachment =
  | { kind: 'entry'; id: string; title: string | null; entryDate: number }
  | { kind: 'period'; start: number; end: number; label: string; entryCount: number }

/** Metadata-only result of `chat_rag_preflight` — display purposes only,
 *  never the gate for whether a send proceeds. That gate will live
 *  server-side inside `daily_chat_send_turn`, which re-computes the plan on
 *  every send (Phase 4 adds it; the command takes no `attachments` argument
 *  yet). The client value is debounced and may be null or stale at the moment
 *  Send is pressed, which is exactly why it cannot be the gate. Mirrors
 *  `commands::ai::ChatContextPreflight`. */
export interface ChatContextPreflight {
  estimatedBytes: number
  totalBytes: number
  entriesIncluded: number
  entriesTotal: number
  trimmed: boolean
  needsConfirm: boolean
  blocked: boolean
}

/** Mirrors Rust's `ChatContextRefusal`, discriminated on `code`. */
export type ChatContextRefusal =
  | { code: 'period_too_large'; label: string; entryCount: number }
  /** A period attachment's share of the shared budget was too small to
   *  hold even the disclosure line, before its actual size was ever
   *  evaluated — distinct from `period_too_large`: this period was
   *  starved of budget by other attachments (or other periods), not
   *  found to be too large itself. */
  | { code: 'period_no_budget'; label: string }
  | {
      code: 'needs_confirmation'
      label: string | null
      estimatedBytes: number
      entriesIncluded: number
      entriesTotal: number
      totalBytes: number
    }
  /** The user has not accepted sending multiple entries off-device. Raised
   *  only for the attachment path — auto-RAG degrades to no context instead,
   *  because there the user did not explicitly ask for those entries. */
  | { code: 'consent_required' }
