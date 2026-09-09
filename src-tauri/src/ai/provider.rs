//! External AI provider abstraction (Phase 6 v2 R2 — skeleton).
//!
//! The full implementation (OpenAI / Anthropic / Gemini / xAI / custom impls,
//! reqwest client, streaming chat, error mapping) lands in chunk **R2** of
//! `docs/plans/phase-6-main/README.md`. This skeleton exists so chunk **R1**
//! (the cleanup that removed `ort` + `llama-cpp` + the model registry) can
//! land green: every Tauri command that previously called an on-device
//! backend now returns `AiError::ProviderNotConfigured` until R2 wires real
//! HTTP calls.
//!
//! Design constraints captured here so R2 builds against a stable shape:
//!
//! - `AIProvider` is async; impls live in `providers/{openai,anthropic,...}.rs`.
//! - `embed` returns one vector per input; the cache key in
//!   `entries_embeddings.model_id` is `"{provider_id}:{model}"` so switching
//!   provider doesn't pollute prior vectors.
//! - `chat` takes a list of `Message` + `ChatOpts`; streaming is exposed via
//!   a separate `chat_stream` method (added in R6) so non-streaming callers
//!   stay simple.
//! - `generate_image` is optional — providers that don't support image gen
//!   return `AiError::ProviderUnsupported`.
//! - Every method MUST honour a `CancellationToken` so the `app:locked`
//!   listener can abort in-flight requests.

use crate::ai::audit::TokenUsageSlot;
use crate::ai::error::AiError;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Message {
    pub role: MessageRole,
    pub content: String,
}

#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MessageRole {
    System,
    User,
    Assistant,
}

#[derive(Debug, Clone, Default)]
pub struct ChatOpts {
    pub temperature: Option<f32>,
    pub max_tokens: Option<u32>,
    pub model: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct ImageOpts {
    pub size: Option<String>,
    pub model: Option<String>,
    pub n: Option<u32>,
}

/// Async provider trait. R2 lands at least one concrete impl
/// (`OpenAICompatibleProvider`) covering the OpenAI / Gemini / xAI / Ollama
/// / OpenRouter wire format. Anthropic native may land separately if the
/// OpenAI-compat shim leaves quality on the table.
#[async_trait::async_trait]
pub trait AIProvider: Send + Sync {
    /// Provider id (e.g. `"openai"`, `"anthropic"`, `"gemini"`, `"xai"`,
    /// `"custom"`). Used as the prefix in `entries_embeddings.model_id`.
    fn id(&self) -> &str;

    /// Human-readable label for UI surfaces.
    fn display_name(&self) -> &str;

    /// Active embedding model id (e.g. `"text-embedding-3-small"`).
    /// Used to compose the `entries_embeddings.model_id` cache key —
    /// `"{provider.id()}:{provider.embedding_model_id()}"` — so a
    /// provider AND/OR model swap correctly invalidates prior vectors
    /// without a separate migration step.
    ///
    /// **The composed cache key is OPAQUE.** Never split on `':'` to
    /// recover the components — a model id may itself contain a colon
    /// (e.g. HuggingFace `org/repo:tag` style). Callers that need to
    /// display "provider X / model Y" should query both methods
    /// separately rather than parse the stored `model_id`.
    fn embedding_model_id(&self) -> &str;

    /// Active chat model id (e.g. `"gpt-4o-mini"`). Default impl
    /// returns the embedding model id — providers that don't
    /// distinguish chat from embedding (or that haven't bothered
    /// implementing this yet) get a sensible-but-coarse value rather
    /// than a runtime panic. Phase 6 v2 R7+ commands that cache chat
    /// output (entry highlights, daily-chat conversation) compose
    /// `"{provider.id()}:{chat_model_id()}"` as the cache namespace
    /// so a provider/model swap doesn't leak summaries across models.
    fn chat_model_id(&self) -> &str {
        self.embedding_model_id()
    }

    /// Embed a batch of **document** texts. Returns one L2-unit vector per
    /// input. Backends that don't support batching MUST loop internally so
    /// callers can rely on a single call.
    async fn embed(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>, AiError>;

    /// Embed a batch of **query** texts. Asymmetric encoders (e.g. the
    /// on-device E5/Nomic catalog) need a different instruction prefix on
    /// the query side than on the document side — see
    /// `ai::on_device::catalog::OnDeviceModel::query_prefix`. Default impl
    /// forwards to `embed`, which is correct for symmetric hosted APIs
    /// (OpenAI-compatible embedding endpoints don't use task prefixes).
    /// Providers with asymmetric backends override this.
    async fn embed_query(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>, AiError> {
        self.embed(texts).await
    }

    /// Single-shot chat completion.
    async fn chat(&self, messages: &[Message], opts: ChatOpts) -> Result<String, AiError>;

    /// Streaming chat completion (Phase 6 v2 R6).
    ///
    /// Each token (or token group) is sent through `tx` as a `String`
    /// delta. The implementation MUST observe `cancel` and abort the
    /// underlying HTTP stream on fire. Returns when the upstream
    /// stream is exhausted (success), the cancel token fires (returns
    /// [`AiError::Cancelled`]), or a transport error occurs.
    ///
    /// Default impl falls back to non-streaming `chat` and emits the
    /// full result as a single delta — this lets feature commands
    /// (R6 title, R7 highlights, R8 go-deeper, R9 daily-chat) call
    /// `chat_stream` uniformly even when a provider hasn't bothered
    /// implementing real SSE. Streaming UX is just degraded, not
    /// broken.
    async fn chat_stream(
        &self,
        messages: &[Message],
        opts: ChatOpts,
        tx: tokio::sync::mpsc::Sender<String>,
        cancel: tokio_util::sync::CancellationToken,
    ) -> Result<(), AiError> {
        // Race the chat call against the cancel token so a `cancel.cancel()`
        // mid-call is observable even on the fallback path.
        let result = tokio::select! {
            _ = cancel.cancelled() => return Err(AiError::Cancelled),
            r = self.chat(messages, opts) => r,
        };
        let content = result?;
        // Re-check cancel BEFORE the final send — without this, a
        // cancel that fires between `chat` resolving and `tx.send`
        // would silently deliver a token to a dropped receiver and
        // return Ok(()), violating the trait contract that "cancel
        // is observable mid-call". Race the send too.
        tokio::select! {
            _ = cancel.cancelled() => Err(AiError::Cancelled),
            send = tx.send(content) => {
                // Receiver dropped → treat as cancellation (caller
                // moved on); otherwise success.
                if send.is_err() {
                    Err(AiError::Cancelled)
                } else {
                    Ok(())
                }
            }
        }
    }

    /// Generate an image. Default impl returns `ProviderUnsupported` so
    /// providers that don't ship image gen don't have to override.
    async fn generate_image(&self, _prompt: &str, _opts: ImageOpts) -> Result<Vec<u8>, AiError> {
        Err(AiError::ProviderUnsupported(
            "image generation not supported by this provider".into(),
        ))
    }

    // ── Audit-log extensions (S2-1) ────────────────────────────────────────

    /// Return the hostname of the AI endpoint for the audit log. Default
    /// returns `"unknown"`. Providers that talk to a remote HTTP endpoint
    /// should override to return the parsed host; CLI providers return
    /// `"subprocess"`.
    fn endpoint_host(&self) -> String {
        "unknown".into()
    }

    /// Return the endpoint classification for the audit log. Default returns
    /// `EndpointClass::Remote`. Providers override to reflect their actual
    /// connectivity model.
    fn endpoint_class(&self) -> EndpointClass {
        EndpointClass::Remote
    }

    /// Register a `TokenUsageSlot` so this provider can write token counts
    /// back to the `AuditingProvider` decorator after each call. Default
    /// impl is a no-op — providers that report token counts (e.g.
    /// `OpenAICompatibleProvider`) override this to store the slot and
    /// populate it from the parsed response.
    fn set_usage_sink(&self, _slot: TokenUsageSlot) {}
}

/// Endpoint classifier — decides whether a configured AI endpoint is on
/// the user's own machine (loopback / private network / mDNS) or out on
/// the public internet. Drives the privacy-notice copy and the audit-log
/// tagging in R3. Pure function with no I/O; called on save.
///
/// Rules (in order):
/// 1. Host is `127.0.0.1`, `::1`, or `localhost` → Local.
/// 2. Host ends with `.local` (mDNS / Bonjour) → Local.
/// 3. Host is an IPv4 in `127/8` (loopback) or RFC 1918 ranges (`10/8`,
///    `172.16/12`, `192.168/16`) → Local.
/// 4. Host is an IPv6 ULA (`fc00::/7`) → Local.
/// 5. Host is an IPv4-mapped IPv6 address (`::ffff:0:0/96`) — re-classified
///    using the embedded IPv4. Tools occasionally surface loopback as
///    `[::ffff:127.0.0.1]`; without this rule those would be wrongly
///    flagged Remote.
/// 6. Anything else → Remote.
///
/// Unparseable URLs default to `Remote` so the privacy banner errs on the
/// safer (more cautious) side.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EndpointClass {
    Local,
    Remote,
    /// CLI-backed providers (`claude-cli`, `codex-cli`). The prompt
    /// never crosses Memlore's network boundary — it's handed to a
    /// local process via stdin. The CLI then makes its own request
    /// to Anthropic / OpenAI using credentials Memlore does not
    /// see (the user's subscription). The disclosure surface is
    /// distinct from both `Local` (data stays on this machine) and
    /// `Remote` (Memlore uploads data to a URL).
    Subscription,
    /// On-device embedding runtime (Phase 4, Embedding Cost Guardrails).
    /// Inference runs in-process via `fastembed` against a model the
    /// user downloaded once — nothing ever leaves the machine, so this
    /// is auto-allowed everywhere `Local` is (no token-cost or privacy
    /// consent gate). Kept as a distinct variant rather than folded into
    /// `Local` so audit logs / UI copy can tell "your own HTTP endpoint
    /// on this machine" apart from "in-process model, no endpoint at
    /// all". Serializes as `"on-device"` (not the derived `"ondevice"`)
    /// to match the frontend's `EmbeddingProviderKind` string and the
    /// `on-device:<model>` cache-key namespace.
    #[serde(rename = "on-device")]
    OnDevice,
}

/// Compose the cache key used as `entries_embeddings.model_id` for a given
/// provider. Centralised so every R4+ feature command builds the same string
/// from the same trait methods — a future drift between
/// `suggest_emotion` / `semantic_search` / `start_backfill` would silently
/// invalidate caches across features. Format is OPAQUE (see trait doc).
pub fn provider_namespaced_model_id(provider: &dyn AIProvider) -> String {
    format!("{}:{}", provider.id(), provider.embedding_model_id())
}

/// Same shape as `provider_namespaced_model_id` but keyed on the chat
/// model. Used by R7 highlights + R9 daily-chat caches so a chat-model
/// swap correctly invalidates per-feature stored results without
/// invalidating embedding rows.
pub fn provider_namespaced_chat_model_id(provider: &dyn AIProvider) -> String {
    format!("{}:{}", provider.id(), provider.chat_model_id())
}

pub fn classify_endpoint(url: &str) -> EndpointClass {
    use url::Host;
    let parsed = match url::Url::parse(url) {
        Ok(u) => u,
        Err(_) => return EndpointClass::Remote,
    };
    match parsed.host() {
        Some(Host::Domain(domain)) => {
            let d = domain.to_ascii_lowercase();
            if d == "localhost" || d.ends_with(".local") {
                EndpointClass::Local
            } else {
                EndpointClass::Remote
            }
        }
        Some(Host::Ipv4(ip)) => {
            let oct = ip.octets();
            if ip.is_loopback()
                || oct[0] == 10
                || (oct[0] == 172 && (16..=31).contains(&oct[1]))
                || (oct[0] == 192 && oct[1] == 168)
            {
                EndpointClass::Local
            } else {
                EndpointClass::Remote
            }
        }
        Some(Host::Ipv6(ip)) => {
            // IPv4-mapped IPv6 (`::ffff:a.b.c.d`) → re-classify using the
            // embedded IPv4 so `[::ffff:127.0.0.1]` and `[::ffff:192.168.1.1]`
            // get the Local tag they deserve.
            if let Some(mapped) = ip.to_ipv4_mapped() {
                let oct = mapped.octets();
                if mapped.is_loopback()
                    || oct[0] == 10
                    || (oct[0] == 172 && (16..=31).contains(&oct[1]))
                    || (oct[0] == 192 && oct[1] == 168)
                {
                    return EndpointClass::Local;
                }
                return EndpointClass::Remote;
            }
            let segs = ip.segments();
            // ::1 loopback OR fc00::/7 unique-local.
            if ip.is_loopback() || (segs[0] & 0xfe00) == 0xfc00 {
                EndpointClass::Local
            } else {
                EndpointClass::Remote
            }
        }
        None => EndpointClass::Remote,
    }
}

/// Settings keys used by the AI layer. Centralised so R2 / R3 read and
/// write through the same constant set; SQLCipher encrypts the underlying
/// `settings` table at rest.
///
/// **Two-slot provider config (R11+)**: the provider config splits into
/// two slots — `gen` (chat + image generation, single key/endpoint) and
/// `embed` (embeddings, separate key/endpoint). Providers like Claude /
/// Groq / xAI expose chat but not embeddings, so the user pairs them
/// with an embed-only provider (Voyage, OpenAI embeddings, a local
/// Ollama, …). The top-level constants (`PROVIDER`, `ENDPOINT`, …) are
/// the legacy single-slot keys; the migration deletes those rows on
/// upgrade so the app boots with both slots unconfigured.
///
/// Feature toggles and daily-chat preferences stay flat at the top of
/// this module — they are slot-independent.
pub mod settings_keys {
    /// Legacy single-provider keys (Phase 6 v2 R3–R10). The R11 split
    /// migration in `db/schema.rs` consumes these constants directly
    /// (not string literals), so renaming a key here only requires
    /// updating one place. Once R11 is complete, callers should use
    /// `gen::` or `embed::` instead — `commands/ai_provider.rs` still
    /// references these legacy constants until step 3 lands the new
    /// paired commands.
    pub const PROVIDER: &str = "ai_provider";
    pub const ENDPOINT: &str = "ai_endpoint";
    pub const ENDPOINT_CLASS: &str = "ai_endpoint_class";
    pub const API_KEY: &str = "ai_api_key";
    pub const CHAT_MODEL: &str = "ai_chat_model";
    pub const EMBEDDING_MODEL: &str = "ai_embedding_model";
    pub const IMAGE_MODEL: &str = "ai_image_model";
    pub const PRIVACY_ACCEPTED_AT: &str = "ai_privacy_accepted_at";
    /// Global AI response language applied to every generation feature:
    /// `"auto"` (default), `"en"`, `"vi"`, or a custom English language
    /// name (e.g. `"French"`). See `commands::ai::resolve_ai_language` /
    /// `apply_language_hint`.
    pub const AI_RESPONSE_LANGUAGE: &str = "ai_response_language";

    /// New per-slot keys (R11+). Each slot has its own provider id,
    /// endpoint, API key, and model. Privacy is a single unified
    /// receipt (`PRIVACY_ACCEPTED_AT`) for all non-local providers.
    pub mod gen {
        pub const PROVIDER: &str = "ai_gen_provider";
        pub const CHAT_MODEL: &str = "ai_gen_chat_model";
    }

    /// Image generation slot. Independent of `gen` since 2026-08-07: chat
    /// and image used to share one provider, which forced the user to pick
    /// a single vendor good at both. `IMAGE_MODEL` deliberately keeps the
    /// old `ai_gen_image_model` row name so no migration is needed and the
    /// user's saved model id survives — only the new `PROVIDER` row is
    /// absent on existing installs, so the slot reads as unconfigured until
    /// the user picks an image provider once.
    pub mod image {
        pub const PROVIDER: &str = "ai_image_provider";
        pub const IMAGE_MODEL: &str = "ai_gen_image_model";
    }
    pub mod embed {
        pub const PROVIDER: &str = "ai_embed_provider";
        pub const EMBEDDING_MODEL: &str = "ai_embed_embedding_model";
    }

    /// Memory generation slot (Phase 2 T2.1, AI User Memory + Persona).
    /// An independent provider slot used ONLY for memory extraction —
    /// consolidation ops produced by a model that is on-machine BY DEFAULT.
    /// Independent of the `gen`/`embed` slots (which may be hosted): the
    /// on-machine-by-default rule (class ∈ {`Local`, `OnDevice`} unless
    /// [`MEMORY_ALLOW_HOSTED`] is on, AND generation-capable) is enforced at
    /// write time AND registry-hydration time in
    /// `commands::ai_settings::enforce_memory_slot_class` (Phase 2 T2.3),
    /// NOT by these keys or by the registry accessor. Mirrors the `gen`
    /// submodule shape (`PROVIDER`/`ENDPOINT`/`ENDPOINT_CLASS`/`API_KEY`/
    /// `CHAT_MODEL`); `IMAGE_MODEL` is intentionally omitted — memory
    /// generation never does image generation.
    pub mod memory_gen {
        pub const PROVIDER: &str = "ai_memory_gen_provider";
        pub const CHAT_MODEL: &str = "ai_memory_gen_chat_model";
    }

    /// Memory embedding slot (Phase 2 T2.2, AI User Memory + Persona).
    /// The embedder — on-machine BY DEFAULT — used for memory item embeds,
    /// related-memory query embeds, and chat retrieval query embeds.
    /// Independent of the app-wide `embed` slot (which may be hosted):
    /// memory embedding goes through this slot, NEVER `embed`, so
    /// entry-derived text never egresses through a hosted `Remote` embedder
    /// EVEN when [`MEMORY_ALLOW_HOSTED`] is on for the memory slot itself —
    /// that flag only widens what THIS slot may point at, it never adds a
    /// fallback to `embed`. The on-machine-by-default rule (class ∈
    /// {`Local`, `OnDevice`} unless `MEMORY_ALLOW_HOSTED`, AND
    /// embedding-capable) is enforced at write time AND registry-hydration
    /// time in `commands::ai_settings::enforce_memory_slot_class` (Phase 2
    /// T2.3), NOT by these keys or by the registry accessor. Mirrors the
    /// `embed` submodule shape (`PROVIDER`/`ENDPOINT`/`ENDPOINT_CLASS`/
    /// `API_KEY`/`EMBEDDING_MODEL`).
    pub mod memory_embed {
        pub const PROVIDER: &str = "ai_memory_embed_provider";
        pub const EMBEDDING_MODEL: &str = "ai_memory_embed_embedding_model";
    }

    /// Legacy per-endpoint-class privacy receipt keys. Migrated to
    /// `PRIVACY_ACCEPTED_AT` on read; deleted on the next accept.
    pub mod privacy {
        pub const ACCEPTED_LOCAL: &str = "ai_privacy_accepted_local";
        pub const ACCEPTED_REMOTE: &str = "ai_privacy_accepted_remote";
        pub const ACCEPTED_SUBSCRIPTION: &str = "ai_privacy_accepted_subscription";
        /// On-device never existed pre-Phase-4, so no install has a legacy
        /// row under this key — it exists only so `privacy_key_for_class`
        /// stays a total function over `EndpointClass`.
        pub const ACCEPTED_ON_DEVICE: &str = "ai_privacy_accepted_on_device";
    }

    /// Legacy per-endpoint-class bulk-context receipt keys. Migrated to
    /// `PRIVACY_ACCEPTED_AT` on read; deleted on the next accept.
    pub mod bulk_context {
        pub const ACCEPTED_LOCAL: &str = "ai_bulk_context_accepted_local";
        pub const ACCEPTED_REMOTE: &str = "ai_bulk_context_accepted_remote";
        pub const ACCEPTED_SUBSCRIPTION: &str = "ai_bulk_context_accepted_subscription";
        /// Same rationale as `privacy::ACCEPTED_ON_DEVICE` — dead key kept
        /// only so `bulk_context_key_for_class` stays total.
        pub const ACCEPTED_ON_DEVICE: &str = "ai_bulk_context_accepted_on_device";
    }

    /// Per-feature toggles. Each is the string `"true"` or `"false"`;
    /// missing means **default-on** (see `read_feature_toggle_defaulting_on`
    /// in `commands/ai_settings.rs`) — an explicit stored value always wins.
    pub const SEMANTIC_SEARCH_ENABLED: &str = "ai_semantic_search_enabled";
    pub const EMOTION_SUGGESTIONS_ENABLED: &str = "ai_emotion_suggestions_enabled";
    /// Language used to pick the prototype set ranked against the entry
    /// embedding: `"auto"` (default, falls back to the global response
    /// language / English) or one of `"en"`, `"vi"`, `"fr"`, `"es"`,
    /// `"zh-Hans"`, `"zh-Hant"`. Cross-language cosine on
    /// `text-embedding-3-small` lives in 0.25–0.35, well below the 0.4
    /// suggestion threshold — pinning the prototype language to match
    /// the user's writing language keeps scores in the same band the
    /// threshold was tuned for.
    pub const EMOTION_SUGGESTION_LANGUAGE: &str = "ai_emotion_suggestion_language";
    pub const TITLE_SUGGESTIONS_ENABLED: &str = "ai_title_suggestions_enabled";
    pub const TITLE_SUGGESTIONS_SYSTEM_PROMPT: &str = "ai_title_suggestions_system_prompt";
    pub const ENTRY_HIGHLIGHTS_ENABLED: &str = "ai_entry_highlights_enabled";
    pub const ENTRY_HIGHLIGHTS_SYSTEM_PROMPT: &str = "ai_entry_highlights_system_prompt";
    pub const GO_DEEPER_ENABLED: &str = "ai_go_deeper_enabled";
    pub const GO_DEEPER_SYSTEM_PROMPT: &str = "ai_go_deeper_system_prompt";
    /// AI prose writing inside the editor. Default ON when unset, like the
    /// other generation toggles. Covers BOTH editor-prose actions — the
    /// footer's "Continue writing with your voice" and the bubble-menu
    /// Rewrite — since they are the same capability; the gate therefore
    /// lives in the shared `editor_prose_inner`.
    pub const CONTINUE_WRITING_ENABLED: &str = "ai_continue_writing_enabled";
    pub const TAG_SUGGESTIONS_ENABLED: &str = "ai_tag_suggestions_enabled";
    pub const DAILY_CHAT_ENABLED: &str = "ai_daily_chat_enabled";
    /// "Use my memories in Daily Chat". FAIL-CLOSED: default OFF when unset,
    /// like `CHAT_RAG_ENABLED` and unlike the default-on feature toggles —
    /// injecting distilled facts about the user into a possibly-hosted chat
    /// provider is opt-in, not something a first run turns on for them. Sits
    /// UNDER the `user_memory` master preference: memories are injected only
    /// when both are on (plus both memory slots configured).
    pub const CHAT_MEMORY_ENABLED: &str = "ai_chat_memory_enabled";
    /// Daily Chat persona id: `"empathetic"` (default), `"tough"`,
    /// `"jolly"`, `"wise"`, or `"custom"`. Snapshotted into each new
    /// session row at creation; older sessions keep their snapshot.
    pub const DAILY_CHAT_PERSONA: &str = "ai_daily_chat_persona";
    /// Free-form prompt body used when persona == "custom". Empty
    /// string falls back to the empathetic prompt.
    pub const DAILY_CHAT_CUSTOM_PERSONA: &str = "ai_daily_chat_custom_persona";
    /// When `"true"`, Daily Chat runs an extra LLM call on the first
    /// user message to generate a session title. Default (missing /
    /// `"false"`) keeps the truncated first-user-message title only.
    pub const DAILY_CHAT_AI_TITLE: &str = "ai_daily_chat_ai_title";
    /// Auto-RAG in Daily Chat. FAIL-CLOSED: unlike the default-on feature
    /// toggles in this module, a missing key means OFF. Read it with
    /// `read_bool_setting`, never `read_feature_toggle_defaulting_on`.
    pub const CHAT_RAG_ENABLED: &str = "ai_chat_rag_enabled";
    /// Master on/off for AI User Memory (extraction, scan, persona rebuild,
    /// and chat memory RAG injection). Default ON (missing key = on) via
    /// `read_feature_toggle_defaulting_on` — preserves pre-toggle behaviour
    /// for existing installs. Runtime work still also requires both memory
    /// slots configured (`ProviderRegistry::is_memory_enabled`).
    pub const USER_MEMORY_ENABLED: &str = "ai_user_memory_enabled";
    // NOTE: the per-feature Daily Chat language setting
    // (`"ai_daily_chat_language"`) was removed — Daily Chat now uses the
    // global `AI_RESPONSE_LANGUAGE` setting like every other generation
    // feature. Any existing `"ai_daily_chat_language"` row in an
    // upgraded install is an orphan (unread, harmless).
    pub const IMAGE_GENERATION_ENABLED: &str = "ai_image_generation_enabled";
    pub const MULTI_ENTRY_SUMMARY_ENABLED: &str = "ai_multi_entry_summary_enabled";
    pub const MULTI_ENTRY_SUMMARY_SYSTEM_PROMPT: &str = "ai_multi_entry_summary_system_prompt";
    pub const PERIODIC_REVIEW_ENABLED: &str = "ai_periodic_review_enabled";
    pub const INSIGHTS_ENABLED: &str = "ai_insights_enabled";
    pub const DASHBOARD_INSIGHTS_ENABLED: &str = "ai_dashboard_insights_enabled";
    /// When `"true"`, locked/invisible entries become write-eligible for
    /// embedding (dirty-marking + `list_entries_needing_index` /
    /// backfill). Default (missing/`"false"`) excludes them from writes,
    /// same as today. Read-side retrieval (semantic search, Daily Chat RAG,
    /// emotion) ALWAYS filters locked/invisible entries out regardless of
    /// this setting — it only ever affects write eligibility.
    pub const EMBED_INCLUDE_PROTECTED: &str = "ai_embed_include_protected";
    /// When `"true"`, locked entries become eligible for AI User Memory
    /// extraction (scan + extraction-time pre-processing re-check — see
    /// `commands::ai_memory::read_memory_include_protected`). Default
    /// (missing/`"false"`) excludes them, same fail-closed convention as
    /// [`EMBED_INCLUDE_PROTECTED`]. Deliberately a SEPARATE key: memory
    /// extraction's opt-in toggle lives on its own Settings surface and must
    /// not be tied to the entry-embedding backfill row's toggle — flipping
    /// one must never silently flip the other. Invisible entries are ALWAYS
    /// excluded regardless of this setting.
    pub const MEMORY_INCLUDE_PROTECTED: &str = "ai_memory_include_protected";
    /// Unix seconds of the last scan pass of any kind (manual "Scan memories"
    /// button OR the background worker tick), shown next to the memories
    /// count. Stamped by `commands::ai_memory::run_memory_scan` so both paths
    /// share one write site. Device-local (not in `SYNCABLE_SETTING_KEYS`).
    pub const MEMORY_LAST_SCANNED_AT: &str = "ai_memory_last_scanned_at";
    /// Unix seconds of the FIRST scan pass of any kind on this device —
    /// stamped by `commands::ai_memory::run_memory_scan`, so BOTH the worker
    /// tick and the manual button set it. Write-once: it is only ever read as
    /// "has anything scanned yet?", and re-stamping it would mean a settings
    /// write every worker tick for a boolean. Drives the settings label's
    /// "never scanned" state, which must not appear while the worker has been
    /// scanning in the background. Device-local (not in
    /// `SYNCABLE_SETTING_KEYS`) — TODO(later): the memory ITEMS sync, so a
    /// second device reads "Not scanned yet" next to synced-in memories, see
    /// `docs/LATER.md`.
    pub const MEMORY_FIRST_SCANNED_AT: &str = "ai_memory_first_scanned_at";
    /// Unix seconds of the last completed consolidation (tidy) pass. Gates
    /// the cooldown in `commands::ai_memory::consolidate_memories`: the pass
    /// is destructive and a model keeps "improving" an already-clean list on
    /// every run, so repeated Scan clicks inside the window only scan for new
    /// sources. Device-local (not in `SYNCABLE_SETTING_KEYS`).
    pub const MEMORY_LAST_CONSOLIDATED_AT: &str = "ai_memory_last_consolidated_at";
    /// When `"true"`, the user has explicitly acknowledged that a hosted
    /// (`EndpointClass::Remote`) or CLI/subscription (`EndpointClass::
    /// Subscription`) provider is allowed to power either memory slot —
    /// meaning **raw journal entries and full Daily Chat transcripts** used
    /// for extraction and persona style sampling leave the machine. Default
    /// (missing/`"false"`) keeps the original on-machine-only guarantee
    /// exactly: both slots reject `Remote`/`Subscription`. Read by
    /// `commands::ai_settings::enforce_memory_slot_class` at every write AND
    /// at registry-hydration time (`commands::ai_provider::load_memory_gen_slot`
    /// / `load_memory_embed_slot`), so a settings row written before this
    /// flag existed (or pulled in by sync) can never hydrate a hosted slot
    /// without consent. Turning this OFF also rejects a currently-active
    /// hosted/subscription memory slot in the in-memory `ProviderRegistry`
    /// (see `commands::ai_settings::reject_disallowed_memory_slots`) rather
    /// than leaving it silently active for the rest of the session.
    pub const MEMORY_ALLOW_HOSTED: &str = "ai_memory_allow_hosted";
    /// Master on/off for the Phase 2 background-indexing worker, controlled
    /// by the user in Settings. `"true"` / missing-or-anything-else =
    /// `"false"` (default off), same tristate convention as every other
    /// feature toggle.
    pub const BACKGROUND_INDEXING_ENABLED: &str = "ai_background_indexing_enabled";
    /// Unix timestamp (seconds) of the user's acceptance of the hosted
    /// token-cost notice for background indexing, scoped to the CURRENT
    /// embedding provider/model identity (`provider_id:embedding_model`).
    /// `None`/missing = not yet accepted. Cleared whenever the embedding
    /// slot's provider or model changes (`persist_embed_config`) so a
    /// stale acceptance never silently covers a different hosted target.
    /// Non-hosted embedding slots never read this — see
    /// `commands::ai_settings::background_indexing_allowed`.
    pub const BACKGROUND_INDEXING_HOSTED_CONSENT_AT: &str =
        "ai_background_indexing_hosted_consent_at";
    /// Device-local decision receipt for **entry** (RAG) embedding sync
    /// mismatches / blocked auto-index. JSON shape lives in
    /// [`crate::ai::embedding_decision`]. Never syncs — cost, credentials,
    /// and peer-model choices differ per machine (same rule as API keys and
    /// hosted-indexing consent).
    pub const EMBED_SYNC_DECISION: &str = "ai_embed_sync_decision";
    /// Device-local decision receipt for **memory** embedding sync
    /// mismatches / blocked auto-index. Same non-sync rule as
    /// [`EMBED_SYNC_DECISION`].
    pub const MEMORY_EMBED_SYNC_DECISION: &str = "ai_memory_embed_sync_decision";
    /// One-shot R3 migration flag — when `"true"`, the v2 cleanup
    /// (`commands::ai_settings::run_ai_v2_migration`) has already deleted
    /// orphan `entries_embeddings` rows + the on-disk `models/` cache from
    /// the abandoned Phase 6 v1 build.
    pub const AI_V2_MIGRATED: &str = "ai_v2_migrated";
    /// One-shot R11 migration flag — when `"true"`, the provider-split
    /// wipe has already dropped the eight legacy `ai_<scalar>` rows in
    /// favour of the new `ai_gen_*` / `ai_embed_*` namespaces. Without
    /// this gate the wipe would re-fire on every launch, re-clearing
    /// any new config the user re-entered after a previous run.
    pub const AI_V11_PROVIDER_SPLIT_MIGRATED: &str = "ai_v11_provider_split_migrated";
    /// One-shot R12 migration flag — when `"true"`, the credential-registry
    /// wipe has already dropped the twelve dead per-slot `endpoint` /
    /// `endpoint_class` / `api_key` rows (across `gen`, `embed`,
    /// `memory_gen`, `memory_embed`) in favour of the per-preset
    /// `ai_provider_endpoints` / `ai_provider_keyring` registry. Without
    /// this gate the wipe would re-fire on every launch, re-clearing any
    /// new config the user re-entered after a previous run.
    pub const AI_V12_CREDENTIAL_REGISTRY_MIGRATED: &str = "ai_v12_credential_registry_migrated";
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifier_loopback_v4() {
        assert_eq!(
            classify_endpoint("http://127.0.0.1:11434/v1"),
            EndpointClass::Local
        );
    }

    #[test]
    fn classifier_loopback_v6() {
        assert_eq!(
            classify_endpoint("http://[::1]:11434/v1"),
            EndpointClass::Local
        );
    }

    #[test]
    fn classifier_localhost() {
        assert_eq!(
            classify_endpoint("http://localhost:1234/v1"),
            EndpointClass::Local
        );
    }

    #[test]
    fn classifier_mdns_local_tld() {
        assert_eq!(
            classify_endpoint("http://my-mac.local:8080/v1"),
            EndpointClass::Local
        );
    }

    #[test]
    fn classifier_rfc1918_v4() {
        assert_eq!(
            classify_endpoint("http://192.168.1.50:11434/v1"),
            EndpointClass::Local
        );
        assert_eq!(
            classify_endpoint("http://10.0.0.5:8080/v1"),
            EndpointClass::Local
        );
        assert_eq!(
            classify_endpoint("http://172.20.5.5:8080/v1"),
            EndpointClass::Local
        );
    }

    #[test]
    fn classifier_public_v4_is_remote() {
        assert_eq!(
            classify_endpoint("https://api.openai.com/v1"),
            EndpointClass::Remote
        );
        assert_eq!(
            classify_endpoint("https://8.8.8.8/v1"),
            EndpointClass::Remote
        );
    }

    #[test]
    fn classifier_invalid_url_is_remote() {
        assert_eq!(classify_endpoint("not a url"), EndpointClass::Remote);
        assert_eq!(classify_endpoint(""), EndpointClass::Remote);
    }

    #[test]
    fn classifier_172_outside_private_range() {
        // 172.15 and 172.32 are public.
        assert_eq!(
            classify_endpoint("http://172.15.0.1/v1"),
            EndpointClass::Remote
        );
        assert_eq!(
            classify_endpoint("http://172.32.0.1/v1"),
            EndpointClass::Remote
        );
    }

    #[test]
    fn classifier_ipv6_ula() {
        assert_eq!(
            classify_endpoint("http://[fc00::1]/v1"),
            EndpointClass::Local
        );
        assert_eq!(
            classify_endpoint("http://[fd12:3456:789a::1]/v1"),
            EndpointClass::Local
        );
    }

    #[test]
    fn classifier_ipv4_mapped_ipv6_loopback() {
        // `::ffff:127.0.0.1` — IPv4-mapped form of the v4 loopback. Local.
        assert_eq!(
            classify_endpoint("http://[::ffff:127.0.0.1]:11434/v1"),
            EndpointClass::Local
        );
    }

    #[test]
    fn classifier_ipv4_mapped_ipv6_rfc1918() {
        // `::ffff:192.168.1.1` — IPv4-mapped form of an RFC 1918 host. Local.
        assert_eq!(
            classify_endpoint("http://[::ffff:192.168.1.1]/v1"),
            EndpointClass::Local
        );
        assert_eq!(
            classify_endpoint("http://[::ffff:10.0.0.5]/v1"),
            EndpointClass::Local
        );
    }

    #[test]
    fn classifier_ipv4_mapped_ipv6_public_is_remote() {
        // `::ffff:8.8.8.8` — IPv4-mapped form of a public host. Remote.
        assert_eq!(
            classify_endpoint("http://[::ffff:8.8.8.8]/v1"),
            EndpointClass::Remote
        );
    }

    /// Minimal provider that only implements the required trait methods —
    /// deliberately does NOT override `embed_query`, so calling it exercises
    /// the trait's default implementation.
    struct NoQueryOverrideProvider;

    #[async_trait::async_trait]
    impl AIProvider for NoQueryOverrideProvider {
        fn id(&self) -> &str {
            "no-query-override"
        }
        fn display_name(&self) -> &str {
            "NoQueryOverrideProvider"
        }
        fn embedding_model_id(&self) -> &str {
            "test-model"
        }
        async fn embed(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>, AiError> {
            Ok(texts.iter().map(|t| vec![t.len() as f32]).collect())
        }
        async fn chat(&self, _messages: &[Message], _opts: ChatOpts) -> Result<String, AiError> {
            Ok(String::new())
        }
    }

    #[tokio::test]
    async fn default_embed_query_delegates_to_embed() {
        let provider = NoQueryOverrideProvider;
        let via_embed = provider.embed(&["hello", "hi"]).await.unwrap();
        let via_embed_query = provider.embed_query(&["hello", "hi"]).await.unwrap();
        assert_eq!(via_embed, via_embed_query);
    }

    #[test]
    fn on_device_serializes_with_hyphen_not_derived_lowercase() {
        // `#[serde(rename_all = "lowercase")]` alone would produce
        // "ondevice" — the frontend and the `on-device:<model>` cache-key
        // namespace both expect the hyphenated form, so this variant
        // carries its own `#[serde(rename = "on-device")]`.
        assert_eq!(
            serde_json::to_string(&EndpointClass::OnDevice).unwrap(),
            "\"on-device\""
        );
        assert_eq!(
            serde_json::from_str::<EndpointClass>("\"on-device\"").unwrap(),
            EndpointClass::OnDevice
        );
    }
}
