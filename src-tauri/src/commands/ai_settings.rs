//! AI **feature toggles + privacy receipt** commands (Phase 6 v2 R3 / R11+).
//!
//! Distinct from `commands/ai_provider.rs` which manages **provider config**
//! (endpoint / api_key / models). The surface here is:
//!
//! - [`get_ai_settings`] — one round-trip read of every AI-related setting
//!   the Settings panel needs. Provider config is included sanitised
//!   (api_key never returned; `has_api_key: bool` instead). Per-feature
//!   toggles default to **enabled** when missing — see
//!   [`read_feature_toggle_defaulting_on`].
//! - [`accept_ai_privacy`] — stamps the unified privacy receipt
//!   (`ai_privacy_accepted_at`). One acceptance covers every non-local
//!   provider (hosted APIs and subscription CLIs). Local endpoints are
//!   auto-exempt.
//! - [`set_ai_feature`] — flips one per-feature flag. Rejects with
//!   `PrivacyNotAccepted` when the relevant slot's endpoint class has not
//!   been accepted yet — features can't be turned on without consent.
//! - [`run_ai_v2_migration`] — one-shot cleanup that runs after the user
//!   first lands on the new Settings panel: deletes orphan
//!   `entry_embedding_chunks` rows from the abandoned on-device run + best-
//!   effort `remove_dir_all` on the models cache. Gated behind
//!   `settings.ai_v2_migrated` so it runs once per install.
//!
//! ## Why so many small commands
//!
//! The R3 panel re-reads the full settings shape after every save (provider
//! flip, accept privacy, toggle feature) so the displayed state matches the
//! truth on disk. One getter + targeted setters keeps the IPC surface
//! minimal and lets the frontend `useAIProviderConfig` hook stay simple.

use crate::ai::error::AiError;
use crate::ai::feature_prompts::{
    self, parse_feature_prompt_kind, FeaturePromptKind, FEATURE_PROMPT_MAX_CHARS,
};
use crate::ai::on_device::download::DownloadManager;
use crate::ai::on_device::llm_download::LlmAssetManager;
use crate::ai::on_device::server::LlamaServerManager;
use crate::ai::provider::{classify_endpoint, settings_keys, AIProvider, EndpointClass};
use crate::ai::provider_registry::ProviderRegistry;
use crate::ai::providers::on_device_embed::OnDeviceEmbedProvider;
use crate::ai::providers::on_device_llm::OnDeviceLlmProvider;
use crate::ai::providers::openai_compat::{OpenAICompatibleConfig, OpenAICompatibleProvider};
use crate::commands::ai_provider::{
    class_privacy_accepted, credential_class, promote_legacy_privacy_receipt,
    provider_is_on_device, provider_uses_subprocess, read_privacy_accepted_at,
    remote_provider_missing_key, resolve_credential, slot_provider_class,
    slot_provider_privacy_accepted, stamp_privacy_accepted, validate_endpoint_url,
    SetProviderResult,
};
// I1: import the canonical provider-id constants so `enforce_memory_slot_class`'s
// capability check can never silently stop matching the canonical ids if those
// change. The local const copies below are deleted in favour of these aliases.
use crate::ai::providers::on_device_embed::PROVIDER_ID as ON_DEVICE_EMBED_ID;
use crate::ai::providers::on_device_llm::PROVIDER_ID as ON_DEVICE_LLM_SENTINEL_ID;
use crate::db;
use crate::AppState;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};
use zeroize::Zeroizing;

// ─── Shape returned by get_ai_settings ──────────────────────────────────────

/// Comprehensive AI settings snapshot for the Settings panel.
///
/// `provider` is `None` when no provider is configured — frontend renders
/// the "Set up AI" empty state. `has_api_key` is `true` only when the
/// stored row is non-empty; the actual key value is never returned.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AIFullSettings {
    pub provider: Option<String>,
    pub endpoint: Option<String>,
    pub endpoint_class: Option<EndpointClass>,
    pub chat_model: Option<String>,
    pub embedding_model: Option<String>,
    pub has_api_key: bool,
    /// Unified privacy receipt for non-local AI providers. `None` = the
    /// user has not yet accepted the notice. Local endpoints are
    /// auto-exempt and do not require this stamp. Also covers
    /// multi-entry AI features that send journal text off-device.
    pub privacy_accepted_at: Option<i64>,
    // Per-feature toggles. Default to ENABLED when missing — see
    // `read_feature_toggle_on`. An explicit stored value always wins.
    // Exceptions: `chat_rag_enabled` and `dashboard_insights_enabled`
    // below are fail-closed (default OFF).
    pub semantic_search_enabled: bool,
    pub emotion_suggestions_enabled: bool,
    pub title_suggestions_enabled: bool,
    pub entry_highlights_enabled: bool,
    pub go_deeper_enabled: bool,
    /// AI prose writing inside the editor — covers both the footer's
    /// "Continue writing with your voice" and the bubble-menu Rewrite.
    pub continue_writing_enabled: bool,
    pub daily_chat_enabled: bool,
    /// "Use my memories in Daily Chat". FAIL-CLOSED: default OFF when
    /// missing. Gated in turn by the `user_memory` master preference — see
    /// `gather_chat_memories`.
    pub chat_memory_enabled: bool,
    pub image_generation_enabled: bool,
    pub multi_entry_summary_enabled: bool,
    pub periodic_review_enabled: bool,
    pub insights_enabled: bool,
    /// FAIL-CLOSED like chat_rag: default OFF; the dashboard card is shown
    /// on every launch.
    pub dashboard_insights_enabled: bool,
    pub tag_suggestions_enabled: bool,
    /// Auto-RAG in Daily Chat. FAIL-CLOSED: default OFF when missing — see
    /// `settings_keys::CHAT_RAG_ENABLED`.
    pub chat_rag_enabled: bool,
    /// Stored override for title-suggestions system prompt (empty = default).
    pub title_suggestions_system_prompt: String,
    pub entry_highlights_system_prompt: String,
    pub multi_entry_summary_system_prompt: String,
    pub go_deeper_system_prompt: String,
    /// Daily Chat persona id (defaults to "empathetic" when unset).
    pub daily_chat_persona: String,
    /// Custom persona prompt body — only used when `daily_chat_persona == "custom"`.
    pub daily_chat_custom_persona: String,
    /// When true, Daily Chat runs an extra LLM call to generate the
    /// session title from the first user message. Default false — the
    /// truncated first-user-message title is used instead.
    pub daily_chat_ai_title: bool,
    /// Global AI response language applied to every generation feature:
    /// "auto" (default) | "en" | "vi" | a custom English language name.
    /// See `commands::ai::resolve_ai_language`.
    pub response_language: String,
    /// Emotion-suggestion prototype language: "auto" (default, falls back
    /// to `response_language`) | "en" | "vi" | "fr" | "es" | "zh-Hans" |
    /// "zh-Hant". Drives which prebuilt prototype set the entry embedding
    /// is ranked against — see `ai::emotion::prototypes_for_language`.
    pub emotion_suggestion_language: String,
    // ── Memory feature model slots (Phase 2 of ai-user-memory) ──────────────
    //
    // Each slot is independent and on-machine by default (`Local | OnDevice`
    // unless `ai_memory_allow_hosted` is on); both must be configured for
    // the feature to be on (see
    // `ProviderRegistry::is_memory_enabled`). These fields are READ-side —
    // the frontend (Phase 5 Settings page) populates the Memory pickers from
    // them. They mirror how the legacy single-slot fields above expose
    // provider/endpoint/endpoint_class/chat_model. The api_key VALUE is never
    // returned — only `*_has_api_key: bool`.
    pub memory_gen_provider: Option<String>,
    pub memory_gen_endpoint: Option<String>,
    pub memory_gen_endpoint_class: Option<EndpointClass>,
    pub memory_gen_chat_model: Option<String>,
    pub memory_gen_has_api_key: bool,
    pub memory_embed_provider: Option<String>,
    pub memory_embed_endpoint: Option<String>,
    pub memory_embed_endpoint_class: Option<EndpointClass>,
    pub memory_embed_embedding_model: Option<String>,
    pub memory_embed_has_api_key: bool,
    /// Master user preference for AI User Memory (`settings_keys::USER_MEMORY_ENABLED`).
    /// Default ON when the key is missing (same as other default-on feature
    /// toggles). Runtime work (scan, extract, chat memory RAG, persona rebuild)
    /// still requires BOTH memory slots configured —
    /// [`ProviderRegistry::is_memory_enabled`] — see
    /// [`is_user_memory_active`].
    pub user_memory_enabled: bool,
    /// "Use persona" — mirrors the `user_persona.enabled` column (NOT a
    /// settings key; it rides the persona singleton's own LWW sync). Exposed
    /// here so persona-gated UI can react without a separate probe. Persona is
    /// independent of `user_memory_enabled`: it can be on while memory is off.
    pub persona_enabled: bool,
}

// ─── Feature key registry ───────────────────────────────────────────────────

/// Which slot's provider + privacy receipt a feature requires.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FeatureSlot {
    Generation,
    /// Image generation — its own provider slot since 2026-08-07, so the
    /// toggle gate checks the image provider's privacy receipt, not the
    /// chat provider's.
    Image,
    Embedding,
}

/// What `set_ai_feature` enforces before allowing a toggle to flip on.
/// Built per-feature so the trust boundary in the IPC layer matches
/// the per-slot config introduced in R11. `extra_image_model` is set
/// only for `image_generation` — that feature ALSO needs a non-empty
/// image-model row (`ai_gen_image_model`, now owned by the `image` slot)
/// before it can be enabled. `extra_slot` is set
/// only for `chat_rag` — the runtime auto-RAG lookup reads from BOTH the
/// generation slot (`registry.generation()`) and the embedding slot
/// (`registry.embedding()`), so enabling it must require both slots'
/// provider + privacy receipt, not just `slot` (C8 fix: it used to require
/// only Generation, so a generation-only setup could be enabled and would
/// then fail at runtime with `ProviderNotConfigured`).
#[derive(Debug, Clone, Copy)]
struct FeatureRequirement {
    setting_key: &'static str,
    slot: FeatureSlot,
    extra_slot: Option<FeatureSlot>,
    extra_image_model: bool,
}

/// Map a frontend-facing feature name onto its underlying settings key
/// plus the slot whose provider + privacy receipt must be present to
/// enable it. Centralised so a typo on the frontend can't quietly
/// write to the wrong row, and so the backend can validate against an
/// explicit allow-list.
///
/// NOTE: `user_memory` is handled specially in [`set_ai_feature`] (not via
/// this map) because it uses the independent memory slot pair
/// (`memory_generation` / `memory_embedding`), not the app-wide gen/embed
/// slots. Runtime work still also requires
/// [`ProviderRegistry::is_memory_enabled`]. See Phase 2 of
/// `docs/plans/2026-07-29-ai-user-memory/`.
fn feature_requirement(feature: &str) -> Result<FeatureRequirement, AiError> {
    let req = |key: &'static str, slot: FeatureSlot, extra: bool| FeatureRequirement {
        setting_key: key,
        slot,
        extra_slot: None,
        extra_image_model: extra,
    };
    Ok(match feature {
        // Embedding-side features.
        "semantic_search" => req(
            settings_keys::SEMANTIC_SEARCH_ENABLED,
            FeatureSlot::Embedding,
            false,
        ),
        "emotion_suggestions" => req(
            settings_keys::EMOTION_SUGGESTIONS_ENABLED,
            FeatureSlot::Embedding,
            false,
        ),
        // Generation-side features.
        "title_suggestions" => req(
            settings_keys::TITLE_SUGGESTIONS_ENABLED,
            FeatureSlot::Generation,
            false,
        ),
        "entry_highlights" => req(
            settings_keys::ENTRY_HIGHLIGHTS_ENABLED,
            FeatureSlot::Generation,
            false,
        ),
        "go_deeper" => req(
            settings_keys::GO_DEEPER_ENABLED,
            FeatureSlot::Generation,
            false,
        ),
        "continue_writing" => req(
            settings_keys::CONTINUE_WRITING_ENABLED,
            FeatureSlot::Generation,
            false,
        ),
        "daily_chat" => req(
            settings_keys::DAILY_CHAT_ENABLED,
            FeatureSlot::Generation,
            false,
        ),
        // Generation is the slot the SETTINGS TOGGLE is gated on (Daily Chat
        // must be usable at all). The retrieval it enables actually spends
        // calls on the independent MEMORY embed slot, which `FeatureSlot`
        // does not model — `gather_chat_memories` re-checks that slot's own
        // privacy receipt at the point of use.
        "chat_memory" => req(
            settings_keys::CHAT_MEMORY_ENABLED,
            FeatureSlot::Generation,
            false,
        ),
        "multi_entry_summary" => req(
            settings_keys::MULTI_ENTRY_SUMMARY_ENABLED,
            FeatureSlot::Generation,
            false,
        ),
        "periodic_review" => req(
            settings_keys::PERIODIC_REVIEW_ENABLED,
            FeatureSlot::Generation,
            false,
        ),
        "theme_insights" => req(
            settings_keys::INSIGHTS_ENABLED,
            FeatureSlot::Generation,
            false,
        ),
        "dashboard_insights" => req(
            settings_keys::DASHBOARD_INSIGHTS_ENABLED,
            FeatureSlot::Generation,
            false,
        ),
        "tag_suggestions" => req(
            settings_keys::TAG_SUGGESTIONS_ENABLED,
            FeatureSlot::Generation,
            false,
        ),
        // Chat RAG reads from BOTH slots at runtime (generation for the
        // chat answer, embedding for retrieval) — require both here too.
        "chat_rag" => FeatureRequirement {
            setting_key: settings_keys::CHAT_RAG_ENABLED,
            slot: FeatureSlot::Generation,
            extra_slot: Some(FeatureSlot::Embedding),
            extra_image_model: false,
        },
        // Image generation additionally needs a configured image model.
        "image_generation" => req(
            settings_keys::IMAGE_GENERATION_ENABLED,
            FeatureSlot::Image,
            true,
        ),
        other => {
            return Err(AiError::ProviderError(format!(
                "unknown AI feature: `{other}`"
            )))
        }
    })
}

/// Resolve a `FeatureSlot` to the per-slot `(provider_key, image_model_key)`
/// pair. T2.3 cutover: the privacy check is per **endpoint class**, now
/// DERIVED from `provider_key` via `slot_provider_privacy_accepted` rather
/// than read off a separate stored `endpoint_class` row. Pure helper so
/// `set_ai_feature` body stays readable.
fn slot_keys(slot: FeatureSlot) -> (&'static str, &'static str) {
    match slot {
        FeatureSlot::Generation => (
            settings_keys::gen::PROVIDER,
            // Generation is chat-only; it carries no image model. Return a
            // never-set key so an accidental check reads as "missing".
            "ai_gen_image_model_unused",
        ),
        FeatureSlot::Image => (
            settings_keys::image::PROVIDER,
            settings_keys::image::IMAGE_MODEL,
        ),
        FeatureSlot::Embedding => (
            settings_keys::embed::PROVIDER,
            // Embedding slot doesn't carry an image model — return a
            // never-set key so any caller that accidentally checks it
            // gets "missing" without an obvious foot-gun.
            "ai_embed_image_model_unused",
        ),
    }
}

/// Fail-closed setting read: a missing or unparseable key is `false`.
///
/// This is the single definition of "absent means off" for opt-in features
/// whose default carries a privacy consequence — contrast
/// `read_feature_toggle_defaulting_on`, which returns `true` for a missing
/// key. Callers outside this module (e.g. the chat RAG gate in
/// `commands/ai.rs`) must call THIS rather than re-deriving the semantics,
/// so there is only one place where that default can ever be changed.
pub(crate) fn read_bool_setting(conn: &rusqlite::Connection, key: &str) -> bool {
    db::get_setting(conn, key)
        .ok()
        .flatten()
        .map(|s| s == "true")
        .unwrap_or(false)
}

/// Read `settings_keys::MEMORY_ALLOW_HOSTED` — the user's opt-in
/// acknowledgement that a hosted/CLI provider may power a memory slot.
/// Default OFF (fail closed), same convention as [`read_bool_setting`].
/// `pub(crate)` because both `commands::ai_settings` (write-time gate) and
/// `commands::ai_provider` (registry-hydration-time gate) call this before
/// [`enforce_memory_slot_class`].
pub(crate) fn read_memory_allow_hosted(conn: &rusqlite::Connection) -> bool {
    read_bool_setting(
        conn,
        crate::ai::provider::settings_keys::MEMORY_ALLOW_HOSTED,
    )
}

/// Read a **user-facing feature toggle**. Unlike [`read_bool_setting`], a
/// missing/empty key resolves to `true` — every AI feature is enabled by
/// default, so a user who configures a provider lands with all features on
/// instead of having to flip twelve toggles one by one.
///
/// An explicit stored value always wins: `"false"` stays `false`, so a user
/// who turns a feature off stays off. The provider-configured + privacy-
/// accepted gate in [`set_ai_feature`] still applies before any feature can
/// actually run — this default only controls the desired state.
///
/// Reserved for the twelve feature toggles (the `*_ENABLED` keys surfaced in
/// [`read_full_settings`]). Keys that must stay fail-closed
/// (`BACKGROUND_INDEXING_ENABLED`, `EMBED_INCLUDE_PROTECTED`, `AI_V2_MIGRATED`)
/// keep using [`read_bool_setting`].
///
/// This is the single source of truth for "feature on by default": both
/// [`read_full_settings`] (Settings panel display) and the per-feature runtime
/// gates in `commands/ai.rs` / `commands/suggest_tags.rs` / `commands/search.rs`
/// call through here so the UI and the actual feature execution agree.
pub(crate) fn read_feature_toggle_on(
    conn: &rusqlite::Connection,
    key: &str,
) -> Result<bool, rusqlite::Error> {
    Ok(match db::get_setting(conn, key)? {
        Some(s) if !s.is_empty() => s == "true",
        _ => true,
    })
}

/// Infallible variant of [`read_feature_toggle_on`] for callers that already
/// swallow DB errors (e.g. [`read_full_settings`], which reads many keys and
/// treats any read failure the same as a missing key).
fn read_feature_toggle_defaulting_on(conn: &rusqlite::Connection, key: &str) -> bool {
    read_feature_toggle_on(conn, key).unwrap_or(true)
}

/// Effective AI User Memory gate used by every runtime path (scan, extract,
/// tick, persona rebuild, Daily Chat memory RAG).
///
/// True only when the user preference is ON **and** both memory slots are
/// configured. Preference alone is not enough (half-configured feature must
/// not run); slots alone are not enough (master toggle off must fully stop
/// memory work, including chat injection).
pub(crate) fn is_user_memory_active(
    conn: &rusqlite::Connection,
    registry: &crate::ai::provider_registry::ProviderRegistry,
) -> bool {
    read_feature_toggle_defaulting_on(conn, settings_keys::USER_MEMORY_ENABLED)
        && registry.is_memory_enabled()
}

fn read_string_setting(conn: &rusqlite::Connection, key: &str) -> Option<String> {
    db::get_setting(conn, key)
        .ok()
        .flatten()
        .filter(|s| !s.is_empty())
}

/// Shared gate: true when ANY embedding-consuming feature is enabled —
/// semantic search, emotion suggestions, or chat RAG. These are
/// the only features that read from the chunk vector store, so this is the
/// single source of truth for "does anything need entries to be embedded
/// right now?". Reused by the Phase 2 background embedding worker + its
/// auto-start, the "Index now" command, and the save-path dirty-marking hook
/// (`commands::entries::maybe_mark_entry_embedding_dirty_after_save`).
///
/// Reads the first two with [`read_feature_toggle_on`]'s **default-on**
/// semantics — the same default the Settings panel display and every other
/// per-feature runtime gate use — so a user who configures an embedding
/// provider and never touches the toggles is treated as having these features
/// on, exactly as the UI shows them. Using the fail-closed `read_bool_setting`
/// here (as this once did) silently disagreed with the displayed state: the
/// worker never ran, "Index now" no-op'd, and the indexer sat at "waiting for
/// edits to settle" forever for entries that were never edited.
///
/// Chat RAG (`CHAT_RAG_ENABLED`) is the one exception: it defaults OFF (see
/// `read_full_settings`), so it is read here with the fail-closed
/// `read_bool_setting` too — using the default-on reader would make this
/// gate return `true` for every user who has never touched chat RAG,
/// defeating the other two toggles' explicit "off" state.
///
/// This gate is intentionally about the FEATURE toggles only — it does NOT
/// check whether an embedding provider is configured. Callers that must not
/// act without a provider enforce that separately: `start_backfill` and the
/// worker loop check `registry.embedding()`, and the save-path hook checks the
/// embedding slot's endpoint class before marking a job dirty (a default-on
/// gate would otherwise queue stub-model jobs for users who never set up AI).
pub fn embedding_features_enabled(conn: &rusqlite::Connection) -> bool {
    read_feature_toggle_defaulting_on(conn, settings_keys::SEMANTIC_SEARCH_ENABLED)
        || read_feature_toggle_defaulting_on(conn, settings_keys::EMOTION_SUGGESTIONS_ENABLED)
        || read_bool_setting(conn, settings_keys::CHAT_RAG_ENABLED)
}

/// Consent gate for the Phase 2 background-indexing worker — `true` iff the
/// worker is currently allowed to spend an embedding-provider call.
///
/// This is a **gate only**; it never itself embeds anything.
///
/// - Master toggle (`ai_background_indexing_enabled`) off → always `false`.
/// - The embedding slot's endpoint class is DERIVED via `slot_provider_class`
///   (T2.3: no longer a stored per-slot row) and phrased as "any non-hosted
///   class is auto": `class != Remote` is the auto-allowed branch. That's
///   `Local`, `OnDevice` (Phase 4 — in-process `fastembed` inference,
///   nothing ever leaves the machine), and the unconfigured/`None` case —
///   nothing to protect against yet.
/// - Hosted (`EndpointClass::Remote`) additionally requires
///   `ai_background_indexing_hosted_consent_at` to be set for the CURRENT
///   provider/model — see `commands::ai_provider::persist_embed_config`,
///   which clears that timestamp whenever the embedding provider/model
///   identity changes.
pub fn background_indexing_allowed(conn: &rusqlite::Connection) -> bool {
    if !read_bool_setting(conn, settings_keys::BACKGROUND_INDEXING_ENABLED) {
        return false;
    }
    match slot_provider_class(conn, settings_keys::embed::PROVIDER)
        .ok()
        .flatten()
    {
        // Critical fix (Phase 2): a Remote embed slot with no resolvable
        // API key must never be treated as usable, even with the hosted
        // consent receipt present — otherwise the worker fires keyless
        // requests at the hosted endpoint (transmitting journal text,
        // getting 401, pausing jobs) while Settings still shows the
        // provider as configured. This closes the R12-migration case
        // (provider/model + consent survive the key wipe) and the normal
        // "user cleared their key without changing provider" case alike.
        //
        // NOTE: this can't distinguish "needs a key but has none" from a
        // genuinely keyless hosted endpoint (e.g. a self-hosted gateway
        // configured via the `custom` preset with no auth) — that case is
        // now also gated off. Accepted limitation for the privacy win; see
        // `docs/LATER.md`.
        Some(EndpointClass::Remote) => {
            read_string_setting(conn, settings_keys::BACKGROUND_INDEXING_HOSTED_CONSENT_AT)
                .is_some()
                && embed_slot_has_resolvable_key(conn)
        }
        _ => true,
    }
}

/// `true` iff the embed slot's currently configured provider resolves an
/// API key from the per-preset credential registry. Only meaningful for a
/// `Remote`-class slot — see [`background_indexing_allowed`]'s call site.
pub(crate) fn embed_slot_has_resolvable_key(conn: &rusqlite::Connection) -> bool {
    let Some(provider) = read_string_setting(conn, settings_keys::embed::PROVIDER) else {
        return false;
    };
    resolve_credential(conn, &provider)
        .ok()
        .and_then(|(_, key)| key)
        .is_some()
}

/// `true` iff the memory embed slot resolves an API key. Sibling of
/// [`embed_slot_has_resolvable_key`] for the `ai_memory_embed_*` rows.
pub(crate) fn memory_embed_slot_has_resolvable_key(conn: &rusqlite::Connection) -> bool {
    let Some(provider) = read_string_setting(conn, settings_keys::memory_embed::PROVIDER) else {
        return false;
    };
    resolve_credential(conn, &provider)
        .ok()
        .and_then(|(_, key)| key)
        .is_some()
}

/// Entry auto-index may run only when consent/key/master gates pass **and**
/// the device-local embed-sync decision allows **local dirty** work
/// (`none` / `reembed`, or modal Pause with `pause_scope=sync_backfill`).
/// `pending` / `switch` / Pause+`all` (absent field) hard-block claim/seed.
pub fn entry_embed_auto_allowed(conn: &rusqlite::Connection) -> bool {
    if !background_indexing_allowed(conn) {
        return false;
    }
    match crate::ai::embedding_decision::read_embed_sync_decision(
        conn,
        crate::ai::embedding_decision::EmbedSyncSlot::Entry,
    ) {
        Ok(d) => crate::ai::embedding_decision::auto_index_allowed(
            &d,
            crate::ai::embedding_decision::AutoIndexScope::LocalDirty,
        ),
        // Fail closed: a corrupt/unreadable receipt must not spend tokens.
        Err(_) => false,
    }
}

/// Memory **vector** spend may run only when the memory-slot decision
/// allows auto-index **and** (for Remote) a resolvable key is present.
/// Text extraction/scan stays independent (gen slot / privacy gates) —
/// gate **embed spend only**, not memory text work.
///
/// Mirrors the entry path's Remote key check so `reembed` / `none` cannot
/// fire keyless hosted embed calls (401 → pause loop with no modal).
pub fn memory_embed_auto_allowed(conn: &rusqlite::Connection) -> bool {
    match slot_provider_class(conn, settings_keys::memory_embed::PROVIDER)
        .ok()
        .flatten()
    {
        Some(EndpointClass::Remote) if !memory_embed_slot_has_resolvable_key(conn) => {
            return false;
        }
        _ => {}
    }
    match crate::ai::embedding_decision::read_embed_sync_decision(
        conn,
        crate::ai::embedding_decision::EmbedSyncSlot::Memory,
    ) {
        Ok(d) => crate::ai::embedding_decision::auto_index_allowed(
            &d,
            crate::ai::embedding_decision::AutoIndexScope::LocalDirty,
        ),
        // Fail closed: corrupt/unreadable receipt must not spend tokens.
        Err(_) => false,
    }
}

fn read_class(conn: &rusqlite::Connection) -> Option<EndpointClass> {
    match db::get_setting(conn, settings_keys::ENDPOINT_CLASS)
        .ok()
        .flatten()
    {
        Some(s) if s == "local" => Some(EndpointClass::Local),
        Some(s) if s == "remote" => Some(EndpointClass::Remote),
        Some(s) if s == "subscription" => Some(EndpointClass::Subscription),
        Some(s) if s == "on-device" => Some(EndpointClass::OnDevice),
        _ => None,
    }
}

/// Pure-DB read so unit tests can call the same code path the Tauri command
/// exposes without manufacturing a `State<'_>` wrapper.
pub(crate) fn read_full_settings(conn: &rusqlite::Connection) -> AIFullSettings {
    let provider = read_string_setting(conn, settings_keys::PROVIDER).filter(|p| p != "none");
    let endpoint = read_string_setting(conn, settings_keys::ENDPOINT);
    let endpoint_class = read_class(conn);
    let chat_model = read_string_setting(conn, settings_keys::CHAT_MODEL);
    let embedding_model = read_string_setting(conn, settings_keys::EMBEDDING_MODEL);
    let has_api_key = db::get_setting(conn, settings_keys::API_KEY)
        .ok()
        .flatten()
        .map(|s| !s.is_empty())
        .unwrap_or(false);
    let privacy_accepted_at = read_privacy_accepted_at(conn).unwrap_or(None);

    // T2.3 cutover: the memory slots' endpoint/class/has_api_key are DERIVED
    // from the per-preset credential registry (keyed by the slot's stored
    // `provider`), never read off a stored `endpoint`/`endpoint_class`/
    // `api_key` row — those rows no longer exist.
    let memory_gen_provider = read_string_setting(conn, settings_keys::memory_gen::PROVIDER);
    let (memory_gen_endpoint, memory_gen_endpoint_class, memory_gen_has_api_key) =
        match &memory_gen_provider {
            Some(p) => {
                let (endpoint, key) = resolve_credential(conn, p).unwrap_or_default();
                let class = credential_class(p, &endpoint);
                (Some(endpoint), Some(class), key.is_some())
            }
            None => (None, None, false),
        };
    let memory_embed_provider = read_string_setting(conn, settings_keys::memory_embed::PROVIDER);
    let (memory_embed_endpoint, memory_embed_endpoint_class, memory_embed_has_api_key) =
        match &memory_embed_provider {
            Some(p) => {
                let (endpoint, key) = resolve_credential(conn, p).unwrap_or_default();
                let class = credential_class(p, &endpoint);
                (Some(endpoint), Some(class), key.is_some())
            }
            None => (None, None, false),
        };

    AIFullSettings {
        provider,
        endpoint,
        endpoint_class,
        chat_model,
        embedding_model,
        has_api_key,
        privacy_accepted_at,
        semantic_search_enabled: read_feature_toggle_defaulting_on(
            conn,
            settings_keys::SEMANTIC_SEARCH_ENABLED,
        ),
        emotion_suggestions_enabled: read_feature_toggle_defaulting_on(
            conn,
            settings_keys::EMOTION_SUGGESTIONS_ENABLED,
        ),
        title_suggestions_enabled: read_feature_toggle_defaulting_on(
            conn,
            settings_keys::TITLE_SUGGESTIONS_ENABLED,
        ),
        entry_highlights_enabled: read_feature_toggle_defaulting_on(
            conn,
            settings_keys::ENTRY_HIGHLIGHTS_ENABLED,
        ),
        go_deeper_enabled: read_feature_toggle_defaulting_on(
            conn,
            settings_keys::GO_DEEPER_ENABLED,
        ),
        continue_writing_enabled: read_feature_toggle_defaulting_on(
            conn,
            settings_keys::CONTINUE_WRITING_ENABLED,
        ),
        daily_chat_enabled: read_feature_toggle_defaulting_on(
            conn,
            settings_keys::DAILY_CHAT_ENABLED,
        ),
        chat_memory_enabled: read_bool_setting(conn, settings_keys::CHAT_MEMORY_ENABLED),
        image_generation_enabled: read_feature_toggle_defaulting_on(
            conn,
            settings_keys::IMAGE_GENERATION_ENABLED,
        ),
        multi_entry_summary_enabled: read_feature_toggle_defaulting_on(
            conn,
            settings_keys::MULTI_ENTRY_SUMMARY_ENABLED,
        ),
        periodic_review_enabled: read_feature_toggle_defaulting_on(
            conn,
            settings_keys::PERIODIC_REVIEW_ENABLED,
        ),
        insights_enabled: read_feature_toggle_defaulting_on(conn, settings_keys::INSIGHTS_ENABLED),
        dashboard_insights_enabled: read_bool_setting(
            conn,
            settings_keys::DASHBOARD_INSIGHTS_ENABLED,
        ),
        tag_suggestions_enabled: read_feature_toggle_defaulting_on(
            conn,
            settings_keys::TAG_SUGGESTIONS_ENABLED,
        ),
        chat_rag_enabled: read_bool_setting(conn, settings_keys::CHAT_RAG_ENABLED),
        title_suggestions_system_prompt: feature_prompts::read_prompt_override(
            conn,
            FeaturePromptKind::TitleSuggestions,
        )
        .unwrap_or_default(),
        entry_highlights_system_prompt: feature_prompts::read_prompt_override(
            conn,
            FeaturePromptKind::EntryHighlights,
        )
        .unwrap_or_default(),
        multi_entry_summary_system_prompt: feature_prompts::read_prompt_override(
            conn,
            FeaturePromptKind::MultiEntrySummary,
        )
        .unwrap_or_default(),
        go_deeper_system_prompt: feature_prompts::read_prompt_override(
            conn,
            FeaturePromptKind::GoDeeper,
        )
        .unwrap_or_default(),
        daily_chat_persona: read_string_setting(conn, settings_keys::DAILY_CHAT_PERSONA)
            .unwrap_or_else(|| "empathetic".to_string()),
        daily_chat_custom_persona: read_string_setting(
            conn,
            settings_keys::DAILY_CHAT_CUSTOM_PERSONA,
        )
        .unwrap_or_default(),
        daily_chat_ai_title: read_bool_setting(conn, settings_keys::DAILY_CHAT_AI_TITLE),
        response_language: read_string_setting(conn, settings_keys::AI_RESPONSE_LANGUAGE)
            .unwrap_or_else(|| "auto".to_string()),
        emotion_suggestion_language: read_string_setting(
            conn,
            settings_keys::EMOTION_SUGGESTION_LANGUAGE,
        )
        .unwrap_or_else(|| "auto".to_string()),
        // ── Memory feature model slots (Phase 2 T2.3) ───────────────────────
        // Read-side only — populate the Settings pickers. The api_key VALUE
        // is never exposed; only `*_has_api_key: bool` (mirrors how the
        // legacy `has_api_key` is computed above). The on-machine class +
        // capability rule is enforced at WRITE time (see `set_memory_*`
        // commands below), not here — a row that violates it cannot be
        // written through this surface.
        memory_gen_chat_model: read_string_setting(conn, settings_keys::memory_gen::CHAT_MODEL),
        memory_embed_embedding_model: read_string_setting(
            conn,
            settings_keys::memory_embed::EMBEDDING_MODEL,
        ),
        // Master preference toggle (default ON). Runtime work still needs
        // both memory slots — see [`is_user_memory_active`].
        user_memory_enabled: read_feature_toggle_defaulting_on(
            conn,
            settings_keys::USER_MEMORY_ENABLED,
        ),
        // A missing/unreadable persona row reads as OFF: persona-gated
        // features must fail closed rather than assume a voice profile the
        // user never opted into.
        persona_enabled: db::persona::read_persona(conn)
            .map(|p| p.enabled)
            .unwrap_or(false),
        memory_gen_provider,
        memory_gen_endpoint,
        memory_gen_endpoint_class,
        memory_gen_has_api_key,
        memory_embed_provider,
        memory_embed_endpoint,
        memory_embed_endpoint_class,
        memory_embed_has_api_key,
    }
}

// ─── Commands ───────────────────────────────────────────────────────────────

/// Read every AI setting in one round-trip. Replaces the old per-key
/// `getSetting`-fan-out the v1 panel used.
///
/// `user_memory_enabled` is the user's master preference toggle (default ON).
/// Whether memory is *runnable* is preference ∧ both memory slots — see
/// [`is_user_memory_active`]. The Settings → Memories page derives slot
/// readiness from the per-slot fields on this snapshot.
#[tauri::command]
pub fn get_ai_settings(
    state: State<'_, AppState>,
    _registry: State<'_, ProviderRegistry>,
) -> Result<AIFullSettings, String> {
    let conn = state.lock()?;
    Ok(read_full_settings(&conn))
}

/// Unified privacy receipt for non-local AI providers. One acceptance
/// covers every hosted API and subscription CLI, plus every multi-entry
/// AI feature that sends journal text off-device. Local endpoints are
/// auto-exempt and never require this stamp.
///
/// The acceptance is **independent of provider configuration** — the
/// modal can show before any slot is configured (e.g. as part of an
/// onboarding flow).
///
/// ## Trust boundary
///
/// This command writes a single source-of-truth row that gates every
/// AI feature in the app. Any renderer-side process able to call
/// `invoke('accept_ai_privacy')` can silently unlock data egress.
/// Mitigation: this command is only exposed under the `default`
/// capability scoped to the `main` window (see
/// `capabilities/default.json`). It must NOT be added to any future
/// webview / iframe / multi-window scope.
#[tauri::command]
pub fn accept_ai_privacy(state: State<'_, AppState>) -> Result<i64, String> {
    let conn = state.lock()?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| AiError::IoError(format!("clock skew: {e}")))
        .map_err(String::from)?
        .as_secs() as i64;
    stamp_privacy_accepted(&conn, now).map_err(|e| e.to_string())?;
    Ok(now)
}

/// Legacy alias kept for multi-entry flows that still call the old
/// command name. Writes the same unified receipt as
/// [`accept_ai_privacy`].
#[tauri::command]
pub fn accept_ai_bulk_context(state: State<'_, AppState>) -> Result<i64, String> {
    accept_ai_privacy(state)
}

/// Toggle one per-feature flag. When `enabled = true`, each feature
/// is gated on the slot it consumes — embedding-side features
/// (`semantic_search`, `emotion_suggestions`) require the embedding
/// slot's provider + privacy receipt; everything else requires the
/// generation slot. `image_generation` additionally requires a
/// non-empty `ai_gen_image_model` row.
///
/// Disabling a feature is allowed regardless of slot state (turning a
/// thing off can't be more sensitive than turning it on).
///
/// **Phase 2 Task 6 — mid-session worker wake:** enabling one of the
/// embedding-consuming features (`semantic_search` / `emotion_suggestions`
/// / `chat_rag`, i.e. exactly the keys `embedding_features_enabled`
/// ORs together) nudges the continuous indexing worker awake
/// (`start_indexing_worker`). This closes the Task 4 gap where the worker
/// only auto-starts at app startup/unlock: a user who starts a session
/// with every embedding feature off, then flips one on mid-session, would
/// otherwise wait for the next restart before dirty/opportunistic
/// indexing resumes. `BackfillManager`'s single-slot reservation makes
/// this a no-op when the worker is already running. Never fires when
/// `enabled == false` — turning a feature off must not spawn anything.
#[tauri::command]
pub fn set_ai_feature(
    feature: String,
    enabled: bool,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let conn = state.lock()?;
    // User Memory uses its own slot pair (not app gen/embed), so it bypasses
    // `feature_requirement`. Enabling is always allowed — the user can turn
    // the feature on before configuring models; runtime gates still require
    // both slots via `is_user_memory_active`.
    if feature == "user_memory" {
        db::set_setting(
            &conn,
            settings_keys::USER_MEMORY_ENABLED,
            if enabled { "true" } else { "false" },
        )
        .map_err(|e| e.to_string())?;
        return Ok(());
    }
    let req = feature_requirement(&feature).map_err(String::from)?;
    if enabled {
        let (provider_key, image_model_key) = slot_keys(req.slot);
        if read_string_setting(&conn, provider_key).is_none() {
            return Err(AiError::ProviderNotConfigured.into());
        }
        // `slot_provider_privacy_accepted` fails closed: a slot with no
        // configured provider (or an unrecognised registry entry) returns
        // `Ok(false)`, so the feature stays off even if the user happens to
        // have accepted *some* class. Centralising the fallback policy in
        // one helper (`ai_provider.rs`) means the gate here and the gates in
        // `commands/ai.rs` + `search.rs` share one rule.
        if !slot_provider_privacy_accepted(&conn, provider_key).map_err(String::from)? {
            return Err(AiError::PrivacyNotAccepted.into());
        }
        if req.extra_image_model && read_string_setting(&conn, image_model_key).is_none() {
            return Err(AiError::ProviderError(
                "image_generation requires a configured image model".into(),
            )
            .into());
        }
        // C8 fix: some features (chat_rag) need a SECOND slot's provider
        // + privacy receipt — check it with the same rules as `req.slot`.
        if let Some(extra_slot) = req.extra_slot {
            let (extra_provider_key, _) = slot_keys(extra_slot);
            if read_string_setting(&conn, extra_provider_key).is_none() {
                return Err(AiError::ProviderNotConfigured.into());
            }
            if !slot_provider_privacy_accepted(&conn, extra_provider_key).map_err(String::from)? {
                return Err(AiError::PrivacyNotAccepted.into());
            }
        }
    }
    db::set_setting(
        &conn,
        req.setting_key,
        if enabled { "true" } else { "false" },
    )
    .map_err(|e| e.to_string())?;
    drop(conn);

    if enabled && is_embedding_consuming_feature_key(req.setting_key) {
        crate::commands::ai::start_indexing_worker(app);
    }
    Ok(())
}

/// `true` for the settings key of a feature that consumes the chunk
/// vector store — exactly the three keys [`embedding_features_enabled`]
/// ORs together. Factored out as a pure, AppHandle-free predicate so it's
/// unit-testable without a `tauri::AppHandle` (mirrors
/// `commands::ai_provider::apply_embedding_slot_change`'s split between
/// DB/pure logic and the AppHandle-driven worker nudge).
fn is_embedding_consuming_feature_key(key: &str) -> bool {
    matches!(
        key,
        settings_keys::SEMANTIC_SEARCH_ENABLED
            | settings_keys::EMOTION_SUGGESTIONS_ENABLED
            | settings_keys::CHAT_RAG_ENABLED
    )
}

// ─── Memory model slots — read/write with on-machine enforcement (T2.3) ─────
//
// The AI User Memory feature (Phase 2 of ai-user-memory) has its OWN
// independent provider slot pair, separate from the app-wide `gen`/`embed`
// slots. Both slots are on-machine BY DEFAULT (`Local` HTTP endpoint OR
// `OnDevice` in-process/sidecar) so that raw entry/chat content used for
// extraction does not leave the machine unless the user explicitly opts in
// via `settings_keys::MEMORY_ALLOW_HOSTED` (post-ship amendment — see
// `docs/plans/2026-07-29-ai-user-memory/README.md`'s Amendment section).
// The enforcement of that rule lives HERE, at write time, so the Settings UI
// (Phase 5) surfaces the rejection immediately instead of silently no-op'ing
// later (decisions 1 + 3, as amended).
//
// The two commands below persist to the `settings_keys::memory_gen::*` /
// `settings_keys::memory_embed::*` rows (NOT the `gen_*`/`embed_*` rows),
// then swap the registry's memory slots via
// `ProviderRegistry::swap_memory_generation` / `swap_memory_embedding`.
// `is_memory_enabled()` (AND of both slots) is the single gate every later
// phase checks.

/// Which memory slot a write command targets. Drives the capability half
/// of the on-machine rule: the gen slot must reject the embedding-only
/// `on-device` sentinel; the embed slot must reject the generation-only
/// `on-device-llm` sentinel.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MemorySlotKind {
    Generation,
    Embedding,
}

/// Classify the disclosure surface of a (provider_id, endpoint) pair the
/// same way `commands::ai_provider::classify_provider_disclosure` does.
/// That helper is private to `commands/ai_provider.rs`, so this is its
/// in-module mirror (the reachable helpers it composes —
/// `provider_uses_subprocess`, `provider_is_on_device`,
/// `classify_endpoint` — ARE `pub(crate)`/`pub`).
///
/// One deliberate extension vs. the original: `on-device-llm` is ALSO
/// classified `OnDevice` here. `provider_is_on_device` returns `true` only
/// for the embedding sentinel (`"on-device"`); the legacy code never relies
/// on `classify_provider_disclosure` to recognise the generation sentinel
/// `"on-device-llm"` because `set_ai_generation_provider` special-cases it
/// in a dedicated branch that hardcodes `class = OnDevice` BEFORE the shared
/// classify path runs. The memory commands below likewise special-case
/// `on-device-llm`, but they route through [`enforce_memory_slot_class`] for
/// the class+capability check, so the classifier itself must recognise both
/// on-device sentinels — otherwise `on-device-llm` would fall through to
/// `classify_endpoint("")` and be mis-tagged `Remote`. The capability half
/// of the rule (which sentinel each slot accepts) is enforced in
/// [`enforce_memory_slot_class`].
fn classify_memory_disclosure(provider_id: &str, endpoint: &str) -> EndpointClass {
    if provider_uses_subprocess(provider_id) {
        EndpointClass::Subscription
    } else if provider_is_on_device(provider_id) || provider_id == ON_DEVICE_LLM_SENTINEL_ID {
        EndpointClass::OnDevice
    } else {
        classify_endpoint(endpoint)
    }
}

/// The on-machine-by-default class+capability rule, factored as a PURE
/// helper so the exact decision the write commands make is directly
/// unit-testable without manufacturing a `tauri::State<'_>` wrapper (the
/// production commands call this BEFORE any DB write or registry swap).
///
/// **`allow_hosted`** is the persisted `settings_keys::MEMORY_ALLOW_HOSTED`
/// flag (default OFF, read by the caller before this is invoked). With it
/// off, memory stays on-machine-only exactly as decisions 1 + 3 originally
/// specified — raw entry/chat content used for extraction never leaves the
/// machine. With it ON, the user has explicitly acknowledged that a hosted
/// or CLI provider may power a memory slot, meaning raw journal entries and
/// full Daily Chat transcripts DO leave the machine for that slot's calls —
/// this is a broader disclosure than decision 9's short distilled facts.
///
/// Returns the resolved [`EndpointClass`] on success, or an `Err(AiError)`
/// describing the violation. Rejections:
/// - `Remote` — hosted providers send data off-machine — UNLESS `allow_hosted`.
/// - `Subscription` — CLI subprocess providers hand the prompt to a local
///   process that then calls a hosted service with credentials Memlore
///   never sees — UNLESS `allow_hosted`.
/// - the wrong-capability on-device sentinel for the slot (`on-device` is
///   embedding-only and must be rejected for the gen slot; `on-device-llm`
///   is generation-only and must be rejected for the embed slot). NEVER
///   relaxed by `allow_hosted` — this is a correctness rule, not a privacy
///   one.
///
/// Accepted unconditionally: `Local` HTTP endpoints, and the right-capability
/// on-device sentinel for each slot (`on-device-llm` for gen, `on-device`
/// for embed).
pub(crate) fn enforce_memory_slot_class(
    provider: &str,
    endpoint: &str,
    slot_kind: MemorySlotKind,
    allow_hosted: bool,
) -> Result<EndpointClass, AiError> {
    let class = classify_memory_disclosure(provider, endpoint);
    match class {
        EndpointClass::Remote => {
            if allow_hosted {
                Ok(class)
            } else {
                Err(AiError::ProviderError(
                    "memory models must run on your machine — hosted (remote) providers are not allowed"
                        .into(),
                ))
            }
        }
        EndpointClass::Subscription => {
            if allow_hosted {
                Ok(class)
            } else {
                Err(AiError::ProviderError(
                    "memory models must run on your machine — CLI/subscription providers are not allowed"
                        .into(),
                ))
            }
        }
        EndpointClass::OnDevice => {
            // Class is fine (in-process / sidecar); now enforce CAPABILITY.
            match slot_kind {
                MemorySlotKind::Generation => {
                    if provider == ON_DEVICE_EMBED_ID {
                        return Err(AiError::ProviderError(
                            "on-device is an embedding-only provider; memory generation needs a \
                             generation-capable model (use on-device-llm or a local \
                             Ollama/OpenAI-compatible endpoint)"
                                .into(),
                        ));
                    }
                    Ok(class)
                }
                MemorySlotKind::Embedding => {
                    if provider == ON_DEVICE_LLM_SENTINEL_ID {
                        return Err(AiError::ProviderError(
                            "on-device-llm is a generation-only provider; memory embedding needs \
                             an embedding-capable model (use on-device or a local \
                             Ollama/OpenAI-compatible embedder)"
                                .into(),
                        ));
                    }
                    Ok(class)
                }
            }
        }
        EndpointClass::Local => Ok(class),
    }
}

/// Input for [`set_memory_gen_provider`] — mirrors `AIGenProviderConfigInput`
/// but is intentionally a distinct type so the IPC surface (and the persisted
/// settings rows) cannot be confused with the app-wide gen slot. Image model
/// is omitted — memory generation never does image generation.
///
/// **T2.3 cutover:** `endpoint` / `api_key` no longer live here — the
/// per-preset credential registry (`commands::ai_provider::resolve_credential`)
/// owns both, keyed by `provider`. Nothing sensitive remains on this struct,
/// so `#[derive(Debug)]` is safe.
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MemoryGenProviderConfigInput {
    pub provider: String,
    pub chat_model: String,
}

/// Mirrors [`MemoryGenProviderConfigInput`]'s cutover, for the memory embed
/// slot.
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MemoryEmbedProviderConfigInput {
    pub provider: String,
    pub embedding_model: String,
}

/// Persist the memory GENERATION slot in a single transaction. Mirrors the
/// shape of `commands::ai_provider::persist_gen_config` but writes the
/// `settings_keys::memory_gen::*` rows. Deliberately omits everything the
/// gen slot carries that memory does not: NO background-indexing consent
/// logic, NO image-model handling.
///
/// `requires_consent` mirrors `persist_gen_config` exactly: `false` for
/// `Local`/`OnDevice` (auto-exempt, see `class_privacy_accepted`) and for a
/// `Remote`/`Subscription` class that already has the unified AI privacy
/// receipt stamped; `true` otherwise. Since the post-amendment
/// `ai_memory_allow_hosted` opt-in now lets `enforce_memory_slot_class`
/// return `Remote`/`Subscription` for a memory slot, this is no longer
/// unconditionally `false` — a user who never accepted the general AI
/// notice must still see the same receipt gate before a memory slot is
/// allowed to send raw entries/transcripts to that provider.
fn persist_memory_gen_config(
    conn: &rusqlite::Connection,
    input: &MemoryGenProviderConfigInput,
    new_class: EndpointClass,
) -> Result<bool, AiError> {
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| AiError::IoError(format!("memory_gen: begin transaction: {e}")))?;
    db::set_setting(conn, settings_keys::memory_gen::PROVIDER, &input.provider)
        .map_err(|e| AiError::IoError(e.to_string()))?;
    db::set_setting(
        conn,
        settings_keys::memory_gen::CHAT_MODEL,
        &input.chat_model,
    )
    .map_err(|e| AiError::IoError(e.to_string()))?;
    let needs_consent =
        new_class != EndpointClass::Local && !class_privacy_accepted(conn, new_class)?;
    tx.commit()
        .map_err(|e| AiError::IoError(format!("memory_gen: commit transaction: {e}")))?;
    Ok(needs_consent)
}

/// Persist the memory EMBEDDING slot — mirror of
/// `commands::ai_provider::persist_embed_config` shape, writing the
/// `settings_keys::memory_embed::*` rows. Tracks provider/model identity so
/// a slot swap clears the device-local embed-sync decision receipt (same
/// contract as entry `persist_embed_config`). `requires_consent` is
/// computed the same way `persist_memory_gen_config` does — see its doc
/// comment.
fn persist_memory_embed_config(
    conn: &rusqlite::Connection,
    input: &MemoryEmbedProviderConfigInput,
    new_class: EndpointClass,
) -> Result<bool, AiError> {
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| AiError::IoError(format!("memory_embed: begin transaction: {e}")))?;
    let old_provider = db::get_setting(conn, settings_keys::memory_embed::PROVIDER)
        .map_err(|e| AiError::IoError(e.to_string()))?
        .unwrap_or_default();
    let old_model = db::get_setting(conn, settings_keys::memory_embed::EMBEDDING_MODEL)
        .map_err(|e| AiError::IoError(e.to_string()))?
        .unwrap_or_default();
    let identity_changed = format!("{old_provider}:{old_model}")
        != format!("{}:{}", input.provider, input.embedding_model);
    db::set_setting(conn, settings_keys::memory_embed::PROVIDER, &input.provider)
        .map_err(|e| AiError::IoError(e.to_string()))?;
    db::set_setting(
        conn,
        settings_keys::memory_embed::EMBEDDING_MODEL,
        &input.embedding_model,
    )
    .map_err(|e| AiError::IoError(e.to_string()))?;
    if identity_changed {
        crate::ai::embedding_decision::clear_decision_on_slot_identity_change(
            conn,
            crate::ai::embedding_decision::EmbedSyncSlot::Memory,
        )
        .map_err(AiError::IoError)?;
    }
    let needs_consent =
        new_class != EndpointClass::Local && !class_privacy_accepted(conn, new_class)?;
    tx.commit()
        .map_err(|e| AiError::IoError(format!("memory_embed: commit transaction: {e}")))?;
    Ok(needs_consent)
}

/// Validate the slot input fields the same way `commands::ai_provider::validate_slot`
/// does. Replicated here because that helper is private to `commands/ai_provider.rs`.
/// CLI-backed (`claude-cli`/`codex-cli`) and on-device sentinels have no
/// endpoint and skip the URL check — but both are rejected for memory slots
/// by `enforce_memory_slot_class` before this is reached for those ids, so
/// the only paths that get here with an empty endpoint are the on-device
/// sentinels (which legitimately have none).
///
/// MUST be followed by `enforce_memory_slot_class` — this helper validates
/// input SHAPE only (non-empty fields, well-formed endpoint URL) and does NOT
/// check the on-machine class rule (Local|OnDevice unless
/// `ai_memory_allow_hosted` is on — post-ship amendment, see
/// `docs/plans/2026-07-29-ai-user-memory/README.md`'s Amendment section).
/// Calling it alone would silently accept a Remote/Subscription endpoint the
/// user has not opted into, bypassing the consent gate (decisions 1 + 3).
fn validate_memory_slot_input(
    provider: &str,
    endpoint: &str,
    model: &str,
    model_label: &str,
) -> Result<(), AiError> {
    if provider.trim().is_empty() {
        return Err(AiError::ProviderError("provider id required".into()));
    }
    if !provider_uses_subprocess(provider) && !provider_is_on_device(provider) {
        if endpoint.trim().is_empty() {
            return Err(AiError::ProviderError("endpoint required".into()));
        }
        validate_endpoint_url(endpoint)?;
    }
    if model.trim().is_empty() {
        return Err(AiError::ProviderError(format!("{model_label} required")));
    }
    Ok(())
}

/// Configure (or replace) the memory GENERATION provider. Independent of
/// the app-wide gen slot — persists to `ai_memory_gen_*` rows and swaps
/// `ProviderRegistry`'s memory_generation slot.
///
/// Enforces the on-machine class + generation-capability rule at WRITE time
/// (decisions 1 + 3) so the Settings UI surfaces rejection immediately:
/// rejects `Remote` and `Subscription` UNLESS `ai_memory_allow_hosted` is on
/// (post-ship amendment, see
/// `docs/plans/2026-07-29-ai-user-memory/README.md`'s Amendment section),
/// and always rejects the embedding-only `on-device` sentinel. Accepts
/// `Local` HTTP endpoints and `on-device-llm` unconditionally.
///
/// For `on-device-llm` the sidecar is NOT eagerly spawned (first chat does
/// that lazily, same as the app-wide gen slot), and the model is NOT
/// required to be downloaded at save time — the Settings model picker only
/// appears once the slot is saved, so gating the save on a downloaded model
/// would deadlock the UI. Catalog membership is still enforced by
/// `OnDeviceLlmProvider::new`, and the real "must be downloaded" guard
/// lives at chat time in `LlamaServerManager::ensure_running`.
#[tauri::command]
pub async fn set_memory_gen_provider(
    input: MemoryGenProviderConfigInput,
    state: State<'_, AppState>,
    registry: State<'_, ProviderRegistry>,
    server_manager: State<'_, Arc<LlamaServerManager>>,
    asset_manager: State<'_, Arc<LlmAssetManager>>,
) -> Result<SetProviderResult, String> {
    // Read the hosted-acknowledgement flag once, up front, so both branches
    // below enforce against the same value.
    // T2.3 cutover: endpoint/key are resolved from the per-preset credential
    // registry, keyed by `input.provider` — no longer part of the input.
    let (allow_hosted, endpoint, api_key) = {
        let conn = state.lock()?;
        let allow_hosted = read_memory_allow_hosted(&conn);
        let (endpoint, api_key) =
            resolve_credential(&conn, &input.provider).map_err(String::from)?;
        (allow_hosted, endpoint, api_key)
    };
    // ── on-device-llm: dedicated branch (no endpoint, no API key) ──────────
    // Mirrors the structure of `set_ai_generation_provider`'s on-device-llm
    // branch. Enforce the slot rule first (accepts on-device-llm for gen).
    if input.provider == ON_DEVICE_LLM_SENTINEL_ID {
        let class = enforce_memory_slot_class(
            &input.provider,
            &endpoint,
            MemorySlotKind::Generation,
            allow_hosted,
        )
        .map_err(String::from)?;
        if input.chat_model.trim().is_empty() {
            return Err(AiError::ProviderError("chat_model required".into()).into());
        }
        let provider: Arc<dyn AIProvider> = Arc::new(OnDeviceLlmProvider::new(
            server_manager.inner().clone(),
            asset_manager.inner().clone(),
            input.chat_model.clone(),
        )?) as Arc<dyn AIProvider>;
        let requires_consent = {
            let conn = state.lock()?;
            let sanitized = MemoryGenProviderConfigInput {
                provider: input.provider.clone(),
                chat_model: input.chat_model.clone(),
            };
            let requires_consent =
                persist_memory_gen_config(&conn, &sanitized, class).map_err(String::from)?;
            registry.swap_memory_generation(Arc::clone(&provider));
            requires_consent
        };
        return Ok(SetProviderResult {
            provider: input.provider,
            endpoint_class: class,
            requires_privacy_consent: requires_consent,
        });
    }

    // ── HTTP / OpenAI-compatible branch ────────────────────────────────────
    validate_memory_slot_input(&input.provider, &endpoint, &input.chat_model, "chat_model")
        .map_err(String::from)?;
    let class = enforce_memory_slot_class(
        &input.provider,
        &endpoint,
        MemorySlotKind::Generation,
        allow_hosted,
    )
    .map_err(String::from)?;
    // Critical-fix (Phase 2): a Remote-class memory provider with no
    // resolvable API key must never be built — this command persists
    // AFTER building the provider, so failing here leaves both the DB row
    // and the registry slot untouched (nothing to clean up).
    if remote_provider_missing_key(&input.provider, &endpoint, api_key.as_deref()) {
        return Err(AiError::AuthFailed.into());
    }
    let provider: Arc<dyn AIProvider> = {
        let cfg = OpenAICompatibleConfig {
            id: input.provider.clone(),
            display_name: input.provider.clone(),
            endpoint: endpoint.clone(),
            api_key: api_key.as_deref().map(|k| Zeroizing::new(k.to_string())),
            chat_model: input.chat_model.clone(),
            embedding_model: String::new(),
            image_model: None,
        };
        Arc::new(OpenAICompatibleProvider::new(cfg)?) as Arc<dyn AIProvider>
    };
    let requires_consent = {
        let conn = state.lock()?;
        let requires_consent =
            persist_memory_gen_config(&conn, &input, class).map_err(String::from)?;
        registry.swap_memory_generation(Arc::clone(&provider));
        requires_consent
    };
    Ok(SetProviderResult {
        provider: input.provider,
        endpoint_class: class,
        requires_privacy_consent: requires_consent,
    })
}

/// Configure (or replace) the memory EMBEDDING provider. Independent of the
/// app-wide embed slot — persists to `ai_memory_embed_*` rows and swaps
/// `ProviderRegistry`'s memory_embedding slot. Memory embedding goes through
/// this slot, NEVER the app's `embed` slot (which may be hosted) — that
/// fallback would let entry-derived text egress.
///
/// Enforces the on-machine class + embedding-capability rule at WRITE time
/// (decisions 1 + 3): rejects `Remote`, `Subscription`, and the
/// generation-only `on-device-llm` sentinel. Accepts `Local` HTTP endpoints
/// and the `on-device` fastembed sentinel (the zero-config default).
#[tauri::command]
pub async fn set_memory_embed_provider(
    input: MemoryEmbedProviderConfigInput,
    state: State<'_, AppState>,
    registry: State<'_, ProviderRegistry>,
    downloads: State<'_, Arc<DownloadManager>>,
) -> Result<SetProviderResult, String> {
    // Read the hosted-acknowledgement flag once, up front, so both branches
    // below enforce against the same value.
    // T2.3 cutover: endpoint/key are resolved from the per-preset credential
    // registry, keyed by `input.provider` — no longer part of the input.
    let (allow_hosted, endpoint, api_key) = {
        let conn = state.lock()?;
        let allow_hosted = read_memory_allow_hosted(&conn);
        let (endpoint, api_key) =
            resolve_credential(&conn, &input.provider).map_err(String::from)?;
        (allow_hosted, endpoint, api_key)
    };
    // ── on-device fastembed: dedicated branch (no endpoint, no API key) ────
    if input.provider == ON_DEVICE_EMBED_ID {
        let class = enforce_memory_slot_class(
            &input.provider,
            &endpoint,
            MemorySlotKind::Embedding,
            allow_hosted,
        )
        .map_err(String::from)?;
        // The catalog model id is required; fall back to the catalog default
        // only when the persisted setting is empty (mirrors `build_slot_provider`).
        let model_id = if input.embedding_model.trim().is_empty() {
            return Err(AiError::ProviderError("embedding_model required".into()).into());
        } else {
            input.embedding_model.clone()
        };
        let provider: Arc<dyn AIProvider> = Arc::new(OnDeviceEmbedProvider::new(
            model_id,
            downloads.inner().clone(),
        )) as Arc<dyn AIProvider>;
        let requires_consent = {
            let conn = state.lock()?;
            let sanitized = MemoryEmbedProviderConfigInput {
                provider: input.provider.clone(),
                embedding_model: input.embedding_model.clone(),
            };
            let requires_consent =
                persist_memory_embed_config(&conn, &sanitized, class).map_err(String::from)?;
            registry.swap_memory_embedding(Arc::clone(&provider));
            requires_consent
        };
        return Ok(SetProviderResult {
            provider: input.provider,
            endpoint_class: class,
            requires_privacy_consent: requires_consent,
        });
    }

    // ── HTTP / OpenAI-compatible branch ────────────────────────────────────
    validate_memory_slot_input(
        &input.provider,
        &endpoint,
        &input.embedding_model,
        "embedding_model",
    )
    .map_err(String::from)?;
    let class = enforce_memory_slot_class(
        &input.provider,
        &endpoint,
        MemorySlotKind::Embedding,
        allow_hosted,
    )
    .map_err(String::from)?;
    // Critical-fix (Phase 2): mirrors the identical guard in
    // `set_memory_gen_provider` — fail before building/persisting rather
    // than swap in a keyless Remote provider.
    if remote_provider_missing_key(&input.provider, &endpoint, api_key.as_deref()) {
        return Err(AiError::AuthFailed.into());
    }
    let provider: Arc<dyn AIProvider> = {
        let cfg = OpenAICompatibleConfig {
            id: input.provider.clone(),
            display_name: input.provider.clone(),
            endpoint: endpoint.clone(),
            api_key: api_key.as_deref().map(|k| Zeroizing::new(k.to_string())),
            chat_model: String::new(),
            embedding_model: input.embedding_model.clone(),
            image_model: None,
        };
        Arc::new(OpenAICompatibleProvider::new(cfg)?) as Arc<dyn AIProvider>
    };
    let requires_consent = {
        let conn = state.lock()?;
        let requires_consent =
            persist_memory_embed_config(&conn, &input, class).map_err(String::from)?;
        registry.swap_memory_embedding(Arc::clone(&provider));
        requires_consent
    };
    Ok(SetProviderResult {
        provider: input.provider,
        endpoint_class: class,
        requires_privacy_consent: requires_consent,
    })
}

/// Re-validate the two persisted memory slot rows against the CURRENT
/// `settings_keys::MEMORY_ALLOW_HOSTED` flag and drop any in-memory
/// `ProviderRegistry` slot that no longer satisfies it.
///
/// Called by the Settings UI immediately after the user revokes the hosted-
/// memory acknowledgement (flips `ai_memory_allow_hosted` to `"false"` via
/// the generic `set_setting` command). Without this, a slot that was valid
/// under the old flag value stays live in the registry's `Arc` for the rest
/// of the session — `enforce_memory_slot_class` only runs at write time and
/// at unlock-time hydration, neither of which fires on a bare settings-key
/// flip. This closes that gap: **reject**, not silently-still-active.
///
/// Deliberately does NOT delete the persisted `ai_memory_gen_*` /
/// `ai_memory_embed_*` rows — same "leave it configured but inert" posture
/// as `load_memory_gen_slot` / `load_memory_embed_slot` skipping hydration
/// on a failed re-check. Re-enabling the flag makes the existing config
/// live again without the user re-entering anything. `user_memory_enabled`
/// (via `ProviderRegistry::is_memory_enabled`) reflects the rejection
/// immediately because it reads the registry, not the settings rows.
///
/// Idempotent and safe to call even when nothing needs rejecting (e.g. both
/// slots are on-machine, or `allow_hosted` is now `true`) — a no-op in both
/// cases.
///
/// Testable core of [`reject_disallowed_memory_slots`] — takes plain
/// references (no `tauri::State`) so it composes directly with the
/// `make_state_and_conn`-style test helpers already used for
/// `load_memory_gen_slot` / `load_memory_embed_slot`.
pub(crate) fn reject_disallowed_memory_slots_impl(
    conn: &rusqlite::Connection,
    registry: &ProviderRegistry,
) {
    let allow_hosted = read_memory_allow_hosted(conn);

    let gen_provider = read_string_setting(conn, settings_keys::memory_gen::PROVIDER);
    if let Some(gen_provider) = gen_provider.filter(|p| !p.is_empty() && p != "none") {
        // T2.3 cutover: endpoint is resolved from the per-preset credential
        // registry, keyed by the slot's stored provider — no longer a
        // stored per-slot row.
        let gen_endpoint = resolve_credential(conn, &gen_provider)
            .map(|(e, _)| e)
            .unwrap_or_default();
        if enforce_memory_slot_class(
            &gen_provider,
            &gen_endpoint,
            MemorySlotKind::Generation,
            allow_hosted,
        )
        .is_err()
        {
            registry.clear_memory_generation();
        }
    }

    let embed_provider = read_string_setting(conn, settings_keys::memory_embed::PROVIDER);
    if let Some(embed_provider) = embed_provider.filter(|p| !p.is_empty() && p != "none") {
        let embed_endpoint = resolve_credential(conn, &embed_provider)
            .map(|(e, _)| e)
            .unwrap_or_default();
        if enforce_memory_slot_class(
            &embed_provider,
            &embed_endpoint,
            MemorySlotKind::Embedding,
            allow_hosted,
        )
        .is_err()
        {
            registry.clear_memory_embedding();
        }
    }
}

/// Thin `tauri::State` wrapper around [`reject_disallowed_memory_slots_impl`].
#[tauri::command]
pub async fn reject_disallowed_memory_slots(
    state: State<'_, AppState>,
    registry: State<'_, ProviderRegistry>,
) -> Result<(), String> {
    let conn = state.lock()?;
    reject_disallowed_memory_slots_impl(&conn, &registry);
    Ok(())
}

/// Reconciled state after flipping `ai_memory_allow_hosted`, returned so the
/// caller can apply the ACTUAL post-write state instead of racing a fresh
/// `hydrate()` read (Settings review F4/F6/F7/F8).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryAllowHostedResult {
    pub allow_hosted: bool,
    pub memory_enabled: bool,
}

/// Persist `ai_memory_allow_hosted` and reconcile the in-memory
/// `ProviderRegistry` memory slots against the new value, atomically in one
/// command — the previous frontend flow (`set_setting` then, only on
/// turn-off, a separate `reject_disallowed_memory_slots` call) could leave
/// the DB and the registry disagreeing for the rest of the session if the
/// second call ever failed (review F4).
///
/// Turning the flag OFF rejects (clears) any slot that no longer satisfies
/// the on-machine rule, via [`reject_disallowed_memory_slots_impl`]. Turning
/// it ON re-hydrates both memory slots from their persisted config
/// (`load_memory_gen_slot` / `load_memory_embed_slot`) — without this, a
/// slot that was rejected while the flag was off stayed inert until restart
/// or an unrelated manual re-save (review F8). Re-hydrate failures are
/// logged, not propagated — same "leave the slot empty, don't fail the
/// call" posture the loaders already use at unlock time.
/// Testable core of [`set_memory_allow_hosted`] — takes a plain `&Connection`
/// instead of `tauri::State` so tests can drive the turn-ON re-hydrate wiring
/// (review F8's actual fix) directly, the same way
/// [`reject_disallowed_memory_slots_impl`] covers the turn-OFF path.
fn set_memory_allow_hosted_impl(
    conn: &rusqlite::Connection,
    registry: &ProviderRegistry,
    next: bool,
    server_manager: Option<&Arc<LlamaServerManager>>,
    asset_manager: Option<&Arc<LlmAssetManager>>,
    downloads: Option<&Arc<DownloadManager>>,
) -> Result<MemoryAllowHostedResult, String> {
    db::set_setting(
        conn,
        settings_keys::MEMORY_ALLOW_HOSTED,
        if next { "true" } else { "false" },
    )
    .map_err(|e| e.to_string())?;
    if next {
        if let Err(e) = crate::commands::ai_provider::load_memory_gen_slot(
            conn,
            registry,
            server_manager,
            asset_manager,
        ) {
            log::warn!("set_memory_allow_hosted: memory generation re-hydrate failed: {e}");
        }
        if let Err(e) =
            crate::commands::ai_provider::load_memory_embed_slot(conn, registry, downloads)
        {
            log::warn!("set_memory_allow_hosted: memory embedding re-hydrate failed: {e}");
        }
    } else {
        reject_disallowed_memory_slots_impl(conn, registry);
    }
    Ok(MemoryAllowHostedResult {
        allow_hosted: next,
        memory_enabled: registry.is_memory_enabled(),
    })
}

#[tauri::command]
pub async fn set_memory_allow_hosted(
    next: bool,
    state: State<'_, AppState>,
    registry: State<'_, ProviderRegistry>,
    server_manager: State<'_, Arc<LlamaServerManager>>,
    asset_manager: State<'_, Arc<LlmAssetManager>>,
    downloads: State<'_, Arc<DownloadManager>>,
) -> Result<MemoryAllowHostedResult, String> {
    let conn = state.lock()?;
    set_memory_allow_hosted_impl(
        &conn,
        &registry,
        next,
        Some(&server_manager),
        Some(&asset_manager),
        Some(&downloads),
    )
}

// ─── R3 v2-migration cleanup ────────────────────────────────────────────────

/// One-shot cleanup that runs after the user unlocks the SQLCipher DB.
/// Idempotent via the `ai_v2_migrated` settings flag.
///
/// **Lock-state safety:** this function MUST NOT be called against the
/// startup `:memory:` placeholder connection. Doing so would set the
/// migration flag in a connection that's about to be discarded, and the
/// real encrypted DB would then never get cleaned up. The defensive guard
/// here checks for the placeholder fingerprint (`encryption_mode=password`
/// AND zero entries — only the placeholder seeded by `startup_init` looks
/// like that) and refuses to run with `MigrationOutcome { ran: false,
/// reason: DeferredLocked }`. Real callers (`crypto::initialize_encryption`)
/// hit this only after the real encrypted DB is swapped in.
///
/// Behaviour on the real DB:
/// 1. Wrap steps 1+3 (the DB ops) in ONE transaction so a process kill
///    can't leave the DB cleaned up but the flag unset (or vice versa).
/// 2. Delete every `entry_embedding_chunks` row whose `model_id` does NOT
///    start with the active provider's id-prefix (`<provider>:`). Phase 6
///    v1 rows (`embedding-stub-*`, `embedding-gemma-*`) become orphans
///    the moment a provider is configured; this clears them.
/// 3. Stamp `ai_v2_migrated = "true"`.
/// 4. **After commit**, best-effort `remove_dir_all` on the on-disk
///    `models/` cache. Frees ~300MB on machines that downloaded the
///    abandoned EmbeddingGemma weights. Filesystem errors are LOGGED,
///    not returned — a stale `models/` dir is annoying but not fatal.
pub fn run_ai_v2_migration(
    conn: &rusqlite::Connection,
    app_data_dir: Option<&Path>,
) -> Result<MigrationOutcome, AiError> {
    // Promote any legacy per-class receipt into the unified row before
    // deleting the obsolete keys — otherwise consent from the prior
    // per-class scheme is lost on first unlock after upgrade.
    promote_legacy_privacy_receipt(conn).map_err(|e| AiError::IoError(e.to_string()))?;

    // Drop obsolete per-class privacy/bulk rows and per-slot legacy
    // keys. Privacy is now stored in the unified `ai_privacy_accepted_at`
    // row (see `stamp_privacy_accepted`).
    for legacy in [
        "ai_gen_privacy_accepted_at",
        "ai_embed_privacy_accepted_at",
        settings_keys::privacy::ACCEPTED_LOCAL,
        settings_keys::privacy::ACCEPTED_REMOTE,
        settings_keys::privacy::ACCEPTED_SUBSCRIPTION,
        settings_keys::bulk_context::ACCEPTED_LOCAL,
        settings_keys::bulk_context::ACCEPTED_REMOTE,
        settings_keys::bulk_context::ACCEPTED_SUBSCRIPTION,
    ] {
        db::delete_setting(conn, legacy).map_err(|e| AiError::IoError(e.to_string()))?;
    }

    if read_bool_setting(conn, settings_keys::AI_V2_MIGRATED) {
        return Ok(MigrationOutcome {
            ran: false,
            reason: Some(MigrationDeferReason::AlreadyMigrated),
            orphan_rows_deleted: 0,
            models_dir_removed: false,
        });
    }

    if looks_like_locked_placeholder(conn) {
        log::info!(
            "ai_v2 migration: deferred — connection looks like the startup placeholder; \
             will retry after unlock"
        );
        return Ok(MigrationOutcome {
            ran: false,
            reason: Some(MigrationDeferReason::DeferredLocked),
            orphan_rows_deleted: 0,
            models_dir_removed: false,
        });
    }

    // Atomic DB ops: orphan delete + flag set inside one transaction.
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| AiError::IoError(format!("ai_v2 migration: begin transaction: {e}")))?;

    // Determine the active provider's row prefix. If none configured, we
    // can wipe ALL rows safely (everything is orphaned).
    let active_prefix = read_string_setting(conn, settings_keys::PROVIDER)
        .filter(|p| p != "none")
        .map(|p| format!("{p}:"));

    let orphan_rows_deleted = match active_prefix {
        Some(prefix) => db::embeddings::delete_chunks_for_other_models(conn, &prefix)
            .map_err(|e| AiError::IoError(e.to_string()))?,
        None => {
            db::embeddings::delete_all_chunks(conn).map_err(|e| AiError::IoError(e.to_string()))?
        }
    };

    db::set_setting(conn, settings_keys::AI_V2_MIGRATED, "true")
        .map_err(|e| AiError::IoError(e.to_string()))?;

    tx.commit()
        .map_err(|e| AiError::IoError(format!("ai_v2 migration: commit: {e}")))?;

    // Filesystem op runs AFTER commit — a TX rollback can't leave DB and
    // disk inconsistent. Errors here are non-fatal.
    let models_dir_removed = if let Some(dir) = app_data_dir {
        let models_path = dir.join("models");
        if models_path.exists() {
            match std::fs::remove_dir_all(&models_path) {
                Ok(_) => true,
                Err(e) => {
                    log::warn!(
                        "ai_v2 migration: removing {} failed (non-fatal): {e}",
                        models_path.display()
                    );
                    false
                }
            }
        } else {
            false
        }
    } else {
        false
    };

    Ok(MigrationOutcome {
        ran: true,
        reason: None,
        orphan_rows_deleted,
        models_dir_removed,
    })
}

/// Detect the startup `:memory:` placeholder connection by its fingerprint.
///
/// `lib.rs::startup_init` opens a placeholder when the boot file says the
/// DB is encrypted and the user hasn't unlocked yet. The placeholder gets
/// `encryption_mode = 'password'` seeded into its `settings` table but has
/// NO entries (the real DB rows live behind SQLCipher). If we see both,
/// we're on the placeholder and must defer.
///
/// Real DBs have `encryption_mode = 'password'` only after at least one
/// entry exists (post-unlock the user has either created entries or
/// imported them). A truly fresh + encrypted + zero-entry DB existing
/// post-unlock is theoretically possible (user just enabled encryption,
/// hasn't written yet) — in that case the migration is a no-op anyway
/// (no orphan rows to delete) so deferring once is harmless.
fn looks_like_locked_placeholder(conn: &rusqlite::Connection) -> bool {
    let is_password_mode = db::get_encryption_mode(conn)
        .map(|m| m == db::EncryptionMode::Password)
        .unwrap_or(false);
    if !is_password_mode {
        return false;
    }
    let entry_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM entries", [], |r| r.get(0))
        .unwrap_or(0);
    entry_count == 0
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MigrationOutcome {
    pub ran: bool,
    /// `Some(reason)` when `ran == false` — distinguishes "already
    /// migrated" from "deferred because the DB is locked." Lets the
    /// frontend lifecycle hook log meaningfully or schedule a retry.
    pub reason: Option<MigrationDeferReason>,
    pub orphan_rows_deleted: usize,
    pub models_dir_removed: bool,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum MigrationDeferReason {
    AlreadyMigrated,
    DeferredLocked,
}

/// Tauri-exposed wrapper around `run_ai_v2_migration` so the frontend can
/// trigger the cleanup on first mount of the new panel. Best-effort —
/// failures are logged + return `MigrationOutcome { ran: false, … }`.
#[tauri::command]
pub fn ai_v2_migrate(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<MigrationOutcome, String> {
    let app_data_dir = app.path().app_data_dir().ok();
    let conn = state.lock()?;
    run_ai_v2_migration(&conn, app_data_dir.as_deref()).map_err(String::from)
}

/// Persist a per-feature system-prompt override. Pass an empty string to
/// reset to the built-in default (deletes the setting row). Re-validates
/// the feature id and caps length server-side regardless of the UI.
#[tauri::command]
pub fn set_ai_feature_prompt(
    feature: String,
    prompt: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let kind = parse_feature_prompt_kind(&feature)?;
    let trimmed = prompt.trim();
    let conn = state.lock()?;
    if trimmed.is_empty() {
        db::delete_setting(&conn, kind.setting_key()).map_err(|e| e.to_string())?;
        return Ok(());
    }
    let capped: String = trimmed.chars().take(FEATURE_PROMPT_MAX_CHARS).collect();
    db::set_setting(&conn, kind.setting_key(), &capped).map_err(|e| e.to_string())
}

/// Persist the Daily Chat persona / custom-persona preferences. Both are
/// write-many: any subsequent `daily_chat_create_session` will read these
/// values and snapshot them onto the new session row. Older sessions are
/// unaffected (their snapshot was taken at create time).
///
/// Daily Chat's reply language is no longer a per-feature setting — it
/// uses the global `ai_response_language` setting (see
/// [`set_ai_response_language`]), so this command no longer accepts a
/// `language` parameter.
#[tauri::command]
pub fn set_daily_chat_preferences(
    persona: String,
    custom_persona: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // Validate persona id against the known allow-list.
    let allowed_personas = [
        "empathetic",
        "tough",
        "jolly",
        "wise",
        "custom",
        "cbt_reframe",
        "gratitude",
        "inversion",
        "stoic",
    ];
    if !allowed_personas.contains(&persona.as_str()) {
        return Err(format!("unknown persona: {persona}"));
    }
    // Char-cap the custom prompt at 1000. Frontend's textarea also caps at
    // 1000 (`DAILY_CHAT_CUSTOM_PERSONA_MAX_CHARS`), but this IPC surface is
    // the trust boundary — re-cap server-side regardless.
    let trimmed_custom = custom_persona.chars().take(1000).collect::<String>();

    let conn = state.lock()?;
    db::set_setting(&conn, settings_keys::DAILY_CHAT_PERSONA, &persona)
        .map_err(|e| e.to_string())?;
    db::set_setting(
        &conn,
        settings_keys::DAILY_CHAT_CUSTOM_PERSONA,
        &trimmed_custom,
    )
    .map_err(|e| e.to_string())
}

/// Persist the nested Daily Chat preference that enables an extra LLM
/// call to generate the session title from the first user message.
/// Default is off — missing/`"false"` keeps the truncated first-message
/// title only.
#[tauri::command]
pub fn set_daily_chat_ai_title(enabled: bool, state: State<'_, AppState>) -> Result<(), String> {
    let conn = state.lock()?;
    db::set_setting(
        &conn,
        settings_keys::DAILY_CHAT_AI_TITLE,
        if enabled { "true" } else { "false" },
    )
    .map_err(|e| e.to_string())
}

/// Persist the emotion-suggestion prototype language. `language` MUST be
/// `"auto"` (fall back to the global response language, see
/// [`crate::commands::ai::resolve_ai_language`]) or one of the shipped
/// prototype sets — currently `"en"`, `"vi"`, `"fr"`, `"es"`, `"zh-Hans"`,
/// `"zh-Hant"`. The IPC surface re-validates regardless of the UI's
/// restriction. Keep this list in lockstep with `prototypes_for_language`
/// in `src-tauri/src/ai/emotion.rs`.
#[tauri::command]
pub fn set_emotion_suggestion_language(
    language: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let allowed = ["auto", "en", "vi", "fr", "es", "zh-Hans", "zh-Hant"];
    if !allowed.contains(&language.as_str()) {
        return Err(format!("unknown emotion language: {language}"));
    }
    let conn = state.lock()?;
    db::set_setting(&conn, settings_keys::EMOTION_SUGGESTION_LANGUAGE, &language)
        .map_err(|e| e.to_string())
}

/// Persist the global AI response language applied to every generation
/// feature. Accepts the presets `"auto"`, `"en"`, `"vi"`, or a custom
/// English-language name (e.g. `"French"`) — see
/// [`crate::commands::ai::validate_response_language`] for the exact
/// validation rules. Re-validates server-side regardless of the UI.
#[tauri::command]
pub fn set_ai_response_language(
    language: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let conn = state.lock()?;
    set_ai_response_language_inner(&conn, &language)
}

/// Testable core of [`set_ai_response_language`] — no `State<'_>` wrapper.
pub(crate) fn set_ai_response_language_inner(
    conn: &rusqlite::Connection,
    language: &str,
) -> Result<(), String> {
    let validated = crate::commands::ai::validate_response_language(language)?;
    db::set_setting(conn, settings_keys::AI_RESPONSE_LANGUAGE, &validated)
        .map_err(|e| e.to_string())
}

// ─── Background indexing consent (Phase 2 — Task 1) ────────────────────────

/// Snapshot the Phase 3 Settings panel needs to render the background-
/// indexing toggle + hosted-consent notice in one round-trip.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundIndexingSettings {
    /// The user-controlled master toggle.
    pub enabled: bool,
    /// `Some(unix_seconds)` when the hosted token-cost notice has been
    /// accepted for the CURRENT embedding provider/model. `None` if never
    /// accepted, or invalidated by a provider/model change.
    pub hosted_consent_at: Option<i64>,
    /// Convenience mirror of `background_indexing_allowed` — `true` iff the
    /// worker may spend a provider call right now.
    pub allowed: bool,
}

/// Testable core of [`get_background_indexing_settings`] — no `State<'_>`
/// wrapper, so unit tests can call it directly instead of only setting the
/// underlying DB flag and inferring behavior.
pub(crate) fn get_background_indexing_settings_impl(
    conn: &rusqlite::Connection,
) -> BackgroundIndexingSettings {
    BackgroundIndexingSettings {
        enabled: read_bool_setting(conn, settings_keys::BACKGROUND_INDEXING_ENABLED),
        hosted_consent_at: read_string_setting(
            conn,
            settings_keys::BACKGROUND_INDEXING_HOSTED_CONSENT_AT,
        )
        .and_then(|s| s.parse::<i64>().ok()),
        allowed: background_indexing_allowed(conn),
    }
}

/// Read the background-indexing toggle + consent state in one round-trip.
#[tauri::command]
pub fn get_background_indexing_settings(
    state: State<'_, AppState>,
) -> Result<BackgroundIndexingSettings, String> {
    let conn = state.lock()?;
    Ok(get_background_indexing_settings_impl(&conn))
}

/// Testable core of [`set_background_indexing_enabled`].
pub(crate) fn set_background_indexing_enabled_impl(
    conn: &rusqlite::Connection,
    enabled: bool,
) -> Result<(), String> {
    db::set_setting(
        conn,
        settings_keys::BACKGROUND_INDEXING_ENABLED,
        if enabled { "true" } else { "false" },
    )
    .map_err(|e| e.to_string())
}

/// Flip the background-indexing master toggle. Does NOT touch hosted
/// consent — turning the master toggle off and back on should not force
/// re-acceptance of a notice the user already saw for the same provider.
#[tauri::command]
pub fn set_background_indexing_enabled(
    enabled: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let conn = state.lock()?;
    set_background_indexing_enabled_impl(&conn, enabled)
}

/// Testable core of [`accept_background_indexing_hosted_consent`].
pub(crate) fn accept_background_indexing_hosted_consent_impl(
    conn: &rusqlite::Connection,
) -> Result<i64, String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| AiError::IoError(format!("clock skew: {e}")))
        .map_err(String::from)?
        .as_secs() as i64;
    db::set_setting(
        conn,
        settings_keys::BACKGROUND_INDEXING_HOSTED_CONSENT_AT,
        &now.to_string(),
    )
    .map_err(|e| e.to_string())?;
    Ok(now)
}

/// Record acceptance of the hosted token-cost notice for the CURRENT
/// embedding provider/model. Scoped by identity, not by a boolean — see
/// `persist_embed_config`, which clears this row whenever the embedding
/// slot's provider or model changes.
#[tauri::command]
pub fn accept_background_indexing_hosted_consent(
    state: State<'_, AppState>,
) -> Result<i64, String> {
    let conn = state.lock()?;
    accept_background_indexing_hosted_consent_impl(&conn)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::ai_provider::{
        bulk_context_key_for_class, class_privacy_accepted, persist_provider_credential,
        preset_default_endpoint, privacy_key_for_class, read_privacy_accepted_at,
        require_bulk_consent,
    };
    use crate::db::schema::migrate;
    use rusqlite::Connection;
    use tempfile::TempDir;

    fn make_state() -> AppState {
        let conn = Connection::open_in_memory().expect("in-memory db");
        migrate(&conn).expect("migrate");
        AppState::new(conn)
    }

    #[test]
    fn read_full_settings_unconfigured_returns_defaults() {
        let state = make_state();
        let conn = state.lock().unwrap();
        let s = read_full_settings(&conn);
        assert!(s.provider.is_none());
        assert!(s.endpoint.is_none());
        assert!(s.endpoint_class.is_none());
        assert!(!s.has_api_key);
        assert!(s.privacy_accepted_at.is_none());
        // Every one of the twelve default-on feature toggles defaults to
        // ENABLED when its key is missing — a user who configures a provider
        // lands with all features on. Asserting each field guards against a
        // future copy-paste regression that reverts one to `read_bool_setting`.
        // (`chat_rag_enabled` and `dashboard_insights_enabled` are NOT among
        // these — see `chat_rag_defaults_off` and
        // `dashboard_insights_defaults_off` below.)
        assert!(
            s.semantic_search_enabled,
            "semantic_search should default on"
        );
        assert!(
            s.emotion_suggestions_enabled,
            "emotion_suggestions should default on"
        );
        assert!(
            s.title_suggestions_enabled,
            "title_suggestions should default on"
        );
        assert!(
            s.entry_highlights_enabled,
            "entry_highlights should default on"
        );
        assert!(s.go_deeper_enabled, "go_deeper should default on");
        assert!(
            s.continue_writing_enabled,
            "continue_writing should default on"
        );
        assert!(s.daily_chat_enabled, "daily_chat should default on");
        assert!(
            s.image_generation_enabled,
            "image_generation should default on"
        );
        assert!(
            s.multi_entry_summary_enabled,
            "multi_entry_summary should default on"
        );
        assert!(
            s.periodic_review_enabled,
            "periodic_review should default on"
        );
        assert!(s.insights_enabled, "insights should default on");
        assert!(
            s.tag_suggestions_enabled,
            "tag_suggestions should default on"
        );
        assert!(
            !s.daily_chat_ai_title,
            "daily_chat_ai_title should default off"
        );
        assert_eq!(s.response_language, "auto");
        assert_eq!(s.emotion_suggestion_language, "auto");
    }

    /// Contrast with `daily_chat_enabled` above: `chat_rag_enabled` is read
    /// with `read_bool_setting`, which is fail-closed — a missing key must
    /// stay OFF. Using `read_feature_toggle_defaulting_on` here (like every
    /// other feature toggle) would ship auto-retrieval of journal content
    /// default-ON for every existing install.
    #[test]
    fn chat_rag_defaults_off() {
        let state = make_state();
        let conn = state.lock().unwrap();
        let s = read_full_settings(&conn);
        assert!(!s.chat_rag_enabled, "chat_rag should default off");
    }

    /// Chat memory is opt-in like `chat_rag`, NOT default-on like the rest:
    /// a first run must not start feeding distilled facts about the user into
    /// a possibly-hosted chat provider.
    #[test]
    fn chat_memory_defaults_off_and_round_trips() {
        let state = make_state();
        let conn = state.lock().unwrap();
        assert!(
            !read_full_settings(&conn).chat_memory_enabled,
            "chat_memory should default off"
        );

        db::set_setting(&conn, settings_keys::CHAT_MEMORY_ENABLED, "true").unwrap();
        assert!(read_full_settings(&conn).chat_memory_enabled);
        db::set_setting(&conn, settings_keys::CHAT_MEMORY_ENABLED, "false").unwrap();
        assert!(!read_full_settings(&conn).chat_memory_enabled);
    }

    /// Contrast with `insights_enabled` (theme insights, default ON):
    /// `dashboard_insights_enabled` is fail-closed like `chat_rag` — a
    /// missing key must stay OFF. The dashboard card is shown on every
    /// launch, so defaulting ON would fire a generation path without an
    /// explicit opt-in.
    #[test]
    fn dashboard_insights_defaults_off() {
        let state = make_state();
        let conn = state.lock().unwrap();
        let s = read_full_settings(&conn);
        assert!(
            !s.dashboard_insights_enabled,
            "dashboard_insights should default off"
        );
    }

    #[test]
    fn dashboard_insights_set_then_read_roundtrip() {
        let state = make_state();
        let conn = state.lock().unwrap();
        assert!(
            !read_full_settings(&conn).dashboard_insights_enabled,
            "dashboard_insights should default off"
        );

        db::set_setting(&conn, settings_keys::DASHBOARD_INSIGHTS_ENABLED, "true").unwrap();
        assert!(read_full_settings(&conn).dashboard_insights_enabled);
        db::set_setting(&conn, settings_keys::DASHBOARD_INSIGHTS_ENABLED, "false").unwrap();
        assert!(!read_full_settings(&conn).dashboard_insights_enabled);
    }

    #[test]
    fn set_ai_response_language_inner_persists_presets_and_custom() {
        let state = make_state();
        let conn = state.lock().unwrap();
        set_ai_response_language_inner(&conn, "vi").unwrap();
        assert_eq!(read_full_settings(&conn).response_language, "vi");
        set_ai_response_language_inner(&conn, "French").unwrap();
        assert_eq!(read_full_settings(&conn).response_language, "French");
        set_ai_response_language_inner(&conn, "auto").unwrap();
        assert_eq!(read_full_settings(&conn).response_language, "auto");
    }

    #[test]
    fn set_ai_response_language_inner_rejects_invalid() {
        let state = make_state();
        let conn = state.lock().unwrap();
        assert!(set_ai_response_language_inner(&conn, "").is_err());
        assert!(set_ai_response_language_inner(&conn, "   ").is_err());
        assert!(set_ai_response_language_inner(&conn, "French\nGerman").is_err());
        let long = "a".repeat(65);
        assert!(set_ai_response_language_inner(&conn, &long).is_err());
        // Failed writes must not clobber a previously valid value.
        set_ai_response_language_inner(&conn, "en").unwrap();
        assert!(set_ai_response_language_inner(&conn, "").is_err());
        assert_eq!(read_full_settings(&conn).response_language, "en");
    }

    #[test]
    fn set_daily_chat_preferences_persists_persona_without_language() {
        let state = make_state();
        // Drive the same persistence path the command uses (persona +
        // custom only — language lives on the global setting now).
        {
            let conn = state.lock().unwrap();
            db::set_setting(&conn, settings_keys::DAILY_CHAT_PERSONA, "wise").unwrap();
            db::set_setting(
                &conn,
                settings_keys::DAILY_CHAT_CUSTOM_PERSONA,
                "be concise",
            )
            .unwrap();
            let s = read_full_settings(&conn);
            assert_eq!(s.daily_chat_persona, "wise");
            assert_eq!(s.daily_chat_custom_persona, "be concise");
            assert_eq!(s.response_language, "auto");
        }
    }

    #[test]
    fn set_daily_chat_ai_title_round_trips() {
        let state = make_state();
        {
            let conn = state.lock().unwrap();
            assert!(
                !read_full_settings(&conn).daily_chat_ai_title,
                "default off"
            );
            // Same write path as set_daily_chat_ai_title command.
            db::set_setting(&conn, settings_keys::DAILY_CHAT_AI_TITLE, "true").unwrap();
            assert!(read_full_settings(&conn).daily_chat_ai_title);
            db::set_setting(&conn, settings_keys::DAILY_CHAT_AI_TITLE, "false").unwrap();
            assert!(!read_full_settings(&conn).daily_chat_ai_title);
        }
    }

    #[test]
    fn read_full_settings_does_not_return_api_key_value() {
        let state = make_state();
        let conn = state.lock().unwrap();
        db::set_setting(&conn, settings_keys::API_KEY, "sk-secret-xyz").unwrap();
        let s = read_full_settings(&conn);
        assert!(s.has_api_key);
        // The serialised JSON must not contain the key — runtime guard
        // against accidentally adding a raw `api_key` field later.
        let json = serde_json::to_string(&s).unwrap();
        assert!(!json.contains("sk-secret-xyz"), "leaked: {json}");
    }

    #[test]
    fn read_full_settings_provider_none_treats_as_unconfigured() {
        let state = make_state();
        let conn = state.lock().unwrap();
        db::set_setting(&conn, settings_keys::PROVIDER, "none").unwrap();
        let s = read_full_settings(&conn);
        assert!(s.provider.is_none(), "`none` literal should map to None");
    }

    #[test]
    fn read_full_settings_classifies_endpoint() {
        let state = make_state();
        let conn = state.lock().unwrap();
        db::set_setting(&conn, settings_keys::PROVIDER, "openai").unwrap();
        db::set_setting(&conn, settings_keys::ENDPOINT_CLASS, "remote").unwrap();
        let s = read_full_settings(&conn);
        assert_eq!(s.endpoint_class, Some(EndpointClass::Remote));
    }

    #[test]
    fn read_full_settings_returns_per_feature_toggles() {
        let state = make_state();
        let conn = state.lock().unwrap();
        db::set_setting(&conn, settings_keys::SEMANTIC_SEARCH_ENABLED, "true").unwrap();
        db::set_setting(&conn, settings_keys::EMOTION_SUGGESTIONS_ENABLED, "true").unwrap();
        let s = read_full_settings(&conn);
        assert!(s.semantic_search_enabled);
        assert!(s.emotion_suggestions_enabled);
        // Unset feature toggles default to ENABLED.
        assert!(s.title_suggestions_enabled);
    }

    #[test]
    fn read_full_settings_explicit_false_stays_off() {
        // An explicit stored "false" always wins over the default-on
        // behaviour — a user who turns a feature off stays off.
        let state = make_state();
        let conn = state.lock().unwrap();
        db::set_setting(&conn, settings_keys::TITLE_SUGGESTIONS_ENABLED, "false").unwrap();
        let s = read_full_settings(&conn);
        assert!(!s.title_suggestions_enabled);
        // A sibling toggle that was never set still defaults on.
        assert!(s.tag_suggestions_enabled);
    }

    #[test]
    fn embedding_features_enabled_false_when_all_off() {
        let state = make_state();
        let conn = state.lock().unwrap();
        // The two default-on embedding-consuming toggles default ON, so
        // "all off" is only reached by an explicit "false" on each.
        db::set_setting(&conn, settings_keys::SEMANTIC_SEARCH_ENABLED, "false").unwrap();
        db::set_setting(&conn, settings_keys::EMOTION_SUGGESTIONS_ENABLED, "false").unwrap();
        assert!(!embedding_features_enabled(&conn));
    }

    /// Regression: a user who configures an embedding provider but never
    /// touches the feature toggles leaves the `*_ENABLED` rows unset. The gate
    /// must read those as ON (matching the Settings UI's default-on display),
    /// or the background worker / "Index now" never run and the indexer stalls
    /// at "waiting for edits to settle" forever.
    #[test]
    fn embedding_features_enabled_defaults_on_when_untouched() {
        let state = make_state();
        let conn = state.lock().unwrap();
        assert!(embedding_features_enabled(&conn));
    }

    #[test]
    fn embedding_features_enabled_true_when_any_one_on() {
        for key in [
            settings_keys::SEMANTIC_SEARCH_ENABLED,
            settings_keys::EMOTION_SUGGESTIONS_ENABLED,
        ] {
            let state = make_state();
            let conn = state.lock().unwrap();
            db::set_setting(&conn, key, "true").unwrap();
            assert!(
                embedding_features_enabled(&conn),
                "{key} alone should enable the shared gate"
            );
        }
    }

    #[test]
    fn embedding_features_enabled_ignores_unrelated_features() {
        let state = make_state();
        let conn = state.lock().unwrap();
        // Turn the two default-on embedding-consuming toggles explicitly OFF
        // (they default on), so this test proves the gate ignores unrelated
        // features rather than passing on the default.
        db::set_setting(&conn, settings_keys::SEMANTIC_SEARCH_ENABLED, "false").unwrap();
        db::set_setting(&conn, settings_keys::EMOTION_SUGGESTIONS_ENABLED, "false").unwrap();
        db::set_setting(&conn, settings_keys::DAILY_CHAT_ENABLED, "true").unwrap();
        db::set_setting(&conn, settings_keys::TITLE_SUGGESTIONS_ENABLED, "true").unwrap();
        assert!(!embedding_features_enabled(&conn));
    }

    /// Regression guard for the indexer-gate membership bug: enabling chat
    /// RAG mid-session must wake the shared gate, or the background worker
    /// never runs and RAG retrieves nothing, forever, with no visible error.
    #[test]
    fn enabling_chat_rag_marks_embedding_features_enabled() {
        let state = make_state();
        let conn = state.lock().unwrap();
        // Explicitly turn off every other embedding-consuming toggle so the
        // assertion below cannot pass on some other feature's default-on
        // behavior.
        db::set_setting(&conn, settings_keys::SEMANTIC_SEARCH_ENABLED, "false").unwrap();
        db::set_setting(&conn, settings_keys::EMOTION_SUGGESTIONS_ENABLED, "false").unwrap();
        db::set_setting(&conn, settings_keys::CHAT_RAG_ENABLED, "true").unwrap();
        assert!(embedding_features_enabled(&conn));
    }

    #[test]
    fn feature_requirement_maps_known_features() {
        assert!(feature_requirement("semantic_search").is_ok());
        assert!(feature_requirement("emotion_suggestions").is_ok());
        assert!(feature_requirement("daily_chat").is_ok());
        assert!(feature_requirement("image_generation").is_ok());
        assert!(feature_requirement("dashboard_insights").is_ok());
    }

    #[test]
    fn feature_requirement_dashboard_insights_is_generation_slot() {
        let r = feature_requirement("dashboard_insights").unwrap();
        assert_eq!(r.slot, FeatureSlot::Generation);
        assert_eq!(r.setting_key, settings_keys::DASHBOARD_INSIGHTS_ENABLED);
    }

    #[test]
    fn feature_requirement_rejects_unknown() {
        assert!(feature_requirement("nope").is_err());
        assert!(feature_requirement("").is_err());
        assert!(feature_requirement("ai_semantic_search_enabled").is_err());
    }

    /// `persona_enabled` mirrors the `user_persona.enabled` column and is
    /// independent of the User Memory master toggle — the two travel in
    /// `AIFullSettings` as separate flags.
    #[test]
    fn persona_enabled_mirrors_the_persona_row_independently_of_user_memory() {
        let state = make_state();
        let conn = state.lock().unwrap();
        // The seeded singleton has `enabled INTEGER NOT NULL DEFAULT 1`, so
        // persona reads ON out of the box — an empty persona is simply a
        // no-op at prompt-build time.
        assert!(read_full_settings(&conn).persona_enabled);

        db::set_setting(&conn, settings_keys::USER_MEMORY_ENABLED, "false").unwrap();
        let s = read_full_settings(&conn);
        assert!(s.persona_enabled, "persona stays on when memory is off");
        assert!(!s.user_memory_enabled);

        db::persona::set_persona_enabled(&conn, false).unwrap();
        db::set_setting(&conn, settings_keys::USER_MEMORY_ENABLED, "true").unwrap();
        let s = read_full_settings(&conn);
        assert!(!s.persona_enabled, "persona stays off when memory is on");
        assert!(s.user_memory_enabled);
    }

    #[test]
    fn feature_requirement_includes_chat_memory() {
        let r = feature_requirement("chat_memory").unwrap();
        assert_eq!(r.slot, FeatureSlot::Generation);
        assert_eq!(r.setting_key, settings_keys::CHAT_MEMORY_ENABLED);
    }

    /// Chat memory retrieval rides the MEMORY embed slot, not the app-wide
    /// one, so it must never widen the shared entry-embedding gate.
    #[test]
    fn chat_memory_does_not_widen_embedding_gate() {
        let state = make_state();
        let conn = state.lock().unwrap();
        db::set_setting(&conn, settings_keys::SEMANTIC_SEARCH_ENABLED, "false").unwrap();
        db::set_setting(&conn, settings_keys::EMOTION_SUGGESTIONS_ENABLED, "false").unwrap();
        db::set_setting(&conn, settings_keys::CHAT_MEMORY_ENABLED, "true").unwrap();
        assert!(!embedding_features_enabled(&conn));
    }

    #[test]
    fn feature_requirement_includes_continue_writing() {
        let r = feature_requirement("continue_writing").unwrap();
        assert_eq!(r.slot, FeatureSlot::Generation);
        assert_eq!(r.setting_key, settings_keys::CONTINUE_WRITING_ENABLED);
    }

    /// Continue-writing is generation-only — it must never widen the shared
    /// embedding gate, or the background indexer starts spending embedding
    /// calls for a feature that never reads the vector store.
    #[test]
    fn continue_writing_does_not_widen_embedding_gate() {
        let state = make_state();
        let conn = state.lock().unwrap();
        db::set_setting(&conn, settings_keys::SEMANTIC_SEARCH_ENABLED, "false").unwrap();
        db::set_setting(&conn, settings_keys::EMOTION_SUGGESTIONS_ENABLED, "false").unwrap();
        db::set_setting(&conn, settings_keys::CONTINUE_WRITING_ENABLED, "true").unwrap();
        assert!(!embedding_features_enabled(&conn));
    }

    #[test]
    fn feature_requirement_includes_tag_suggestions() {
        let r = feature_requirement("tag_suggestions").unwrap();
        assert_eq!(r.slot, FeatureSlot::Generation);
    }

    #[test]
    fn set_ai_feature_prompt_round_trip_and_reset() {
        let state = make_state();
        let conn = state.lock().unwrap();
        db::set_setting(&conn, settings_keys::GO_DEEPER_SYSTEM_PROMPT, "custom lens").unwrap();
        let s = read_full_settings(&conn);
        assert_eq!(s.go_deeper_system_prompt, "custom lens");
        db::delete_setting(&conn, settings_keys::GO_DEEPER_SYSTEM_PROMPT).unwrap();
        let s2 = read_full_settings(&conn);
        assert!(s2.go_deeper_system_prompt.is_empty());
    }

    #[test]
    fn feature_requirement_partitions_features_across_slots() {
        // Embedding-side features → Embedding slot.
        for f in ["semantic_search", "emotion_suggestions"] {
            let r = feature_requirement(f).unwrap();
            assert_eq!(r.slot, FeatureSlot::Embedding, "{f} should be embed-side");
            assert!(!r.extra_image_model);
        }
        // Generation-side features → Generation slot.
        for f in [
            "title_suggestions",
            "entry_highlights",
            "go_deeper",
            "daily_chat",
            "multi_entry_summary",
            "dashboard_insights",
        ] {
            let r = feature_requirement(f).unwrap();
            assert_eq!(r.slot, FeatureSlot::Generation, "{f} should be gen-side");
            assert!(!r.extra_image_model);
        }
        // image_generation is gated by its OWN slot since the image
        // provider split — NOT the chat slot — plus the extra model check.
        let img = feature_requirement("image_generation").unwrap();
        assert_eq!(img.slot, FeatureSlot::Image);
        assert!(img.extra_image_model);
    }

    /// Replicate `set_ai_feature`'s inner gate exactly. The Tauri
    /// `State<'_>` wrapper isn't unit-mockable, so we call the pure
    /// gate logic against an in-memory DB and assert the same error
    /// path the production command surfaces.
    fn check_set_feature_gate(
        conn: &rusqlite::Connection,
        feature: &str,
        enabled: bool,
    ) -> Result<(), AiError> {
        let req = feature_requirement(feature)?;
        if !enabled {
            return Ok(());
        }
        let (provider_key, image_model_key) = slot_keys(req.slot);
        if read_string_setting(conn, provider_key).is_none() {
            return Err(AiError::ProviderNotConfigured);
        }
        // Mirrors the production gate (`set_ai_feature`) bit-for-bit
        // — single source of truth via `slot_provider_privacy_accepted`.
        if !slot_provider_privacy_accepted(conn, provider_key)? {
            return Err(AiError::PrivacyNotAccepted);
        }
        if req.extra_image_model && read_string_setting(conn, image_model_key).is_none() {
            return Err(AiError::ProviderError(
                "image_generation requires a configured image model".into(),
            ));
        }
        if let Some(extra_slot) = req.extra_slot {
            let (extra_provider_key, _) = slot_keys(extra_slot);
            if read_string_setting(conn, extra_provider_key).is_none() {
                return Err(AiError::ProviderNotConfigured);
            }
            if !slot_provider_privacy_accepted(conn, extra_provider_key)? {
                return Err(AiError::PrivacyNotAccepted);
            }
        }
        Ok(())
    }

    fn accept_privacy(conn: &rusqlite::Connection) {
        db::set_setting(conn, settings_keys::PRIVACY_ACCEPTED_AT, "1").unwrap();
    }

    #[test]
    fn set_ai_feature_gen_feature_rejected_without_gen_slot() {
        let state = make_state();
        let conn = state.lock().unwrap();
        // No gen provider configured.
        assert!(matches!(
            check_set_feature_gate(&conn, "daily_chat", true),
            Err(AiError::ProviderNotConfigured)
        ));
        // Disable always allowed.
        assert!(check_set_feature_gate(&conn, "daily_chat", false).is_ok());
        // An embed-only setup must NOT unlock a gen-side toggle.
        db::set_setting(&conn, settings_keys::embed::PROVIDER, "openai").unwrap();
        accept_privacy(&conn);
        assert!(matches!(
            check_set_feature_gate(&conn, "daily_chat", true),
            Err(AiError::ProviderNotConfigured)
        ));
    }

    #[test]
    fn set_ai_feature_embed_feature_rejected_without_embed_slot() {
        let state = make_state();
        let conn = state.lock().unwrap();
        // Configure gen slot only — semantic_search must still refuse.
        db::set_setting(&conn, settings_keys::gen::PROVIDER, "anthropic").unwrap();
        accept_privacy(&conn);
        assert!(matches!(
            check_set_feature_gate(&conn, "semantic_search", true),
            Err(AiError::ProviderNotConfigured)
        ));
    }

    #[test]
    fn set_ai_feature_gen_feature_succeeds_when_gen_class_accepted() {
        let state = make_state();
        let conn = state.lock().unwrap();
        db::set_setting(&conn, settings_keys::gen::PROVIDER, "anthropic").unwrap();
        accept_privacy(&conn);
        assert!(check_set_feature_gate(&conn, "daily_chat", true).is_ok());
        assert!(check_set_feature_gate(&conn, "title_suggestions", true).is_ok());
    }

    #[test]
    fn set_ai_feature_embed_feature_succeeds_when_embed_class_accepted() {
        let state = make_state();
        let conn = state.lock().unwrap();
        db::set_setting(&conn, settings_keys::embed::PROVIDER, "openai").unwrap();
        accept_privacy(&conn);
        assert!(check_set_feature_gate(&conn, "semantic_search", true).is_ok());
        assert!(check_set_feature_gate(&conn, "emotion_suggestions", true).is_ok());
    }

    #[test]
    fn set_ai_feature_chat_rag_requires_both_gen_and_embed_slots() {
        let state = make_state();
        let conn = state.lock().unwrap();
        db::set_setting(&conn, settings_keys::gen::PROVIDER, "anthropic").unwrap();
        accept_privacy(&conn);

        // Generation slot alone must still be rejected.
        assert!(matches!(
            check_set_feature_gate(&conn, "chat_rag", true),
            Err(AiError::ProviderNotConfigured)
        ));

        // Adding the embedding slot's provider + accepted privacy succeeds.
        db::set_setting(&conn, settings_keys::embed::PROVIDER, "openai").unwrap();
        assert!(check_set_feature_gate(&conn, "chat_rag", true).is_ok());
    }

    #[test]
    fn set_ai_feature_rejects_when_class_privacy_missing() {
        let state = make_state();
        let conn = state.lock().unwrap();
        db::set_setting(&conn, settings_keys::gen::PROVIDER, "anthropic").unwrap();
        // No privacy receipt for the `remote` class — must reject.
        assert!(matches!(
            check_set_feature_gate(&conn, "daily_chat", true),
            Err(AiError::PrivacyNotAccepted)
        ));
    }

    #[test]
    fn set_ai_feature_local_slot_auto_exempt_from_privacy() {
        let state = make_state();
        let conn = state.lock().unwrap();
        db::set_setting(&conn, settings_keys::gen::PROVIDER, "ollama").unwrap();
        assert!(check_set_feature_gate(&conn, "daily_chat", true).is_ok());
    }

    #[test]
    fn set_ai_feature_subscription_slot_uses_unified_receipt() {
        let state = make_state();
        let conn = state.lock().unwrap();
        db::set_setting(&conn, settings_keys::gen::PROVIDER, "claude-cli").unwrap();
        assert!(matches!(
            check_set_feature_gate(&conn, "daily_chat", true),
            Err(AiError::PrivacyNotAccepted)
        ));
        accept_privacy(&conn);
        assert!(check_set_feature_gate(&conn, "daily_chat", true).is_ok());
    }

    // NOTE: `set_ai_feature_fails_closed_on_unknown_endpoint_class` (a T2.3
    // pre-cutover regression guard for "a missing/unrecognised stored
    // `endpoint_class` row must fail closed") was deleted here — its premise
    // no longer exists. `endpointClass` is DERIVED from a live provider id
    // via `slot_provider_class`/`credential_class` on every read now; there
    // is no separate stored class row left to go missing or hold a garbage
    // value. A configured provider always classifies cleanly.

    #[test]
    fn set_ai_feature_image_generation_requires_image_provider_and_model() {
        let state = make_state();
        let conn = state.lock().unwrap();
        accept_privacy(&conn);

        // A configured CHAT provider is no longer enough — since the slots
        // split, `image_generation` is gated by the IMAGE provider.
        db::set_setting(&conn, settings_keys::gen::PROVIDER, "anthropic").unwrap();
        assert!(matches!(
            check_set_feature_gate(&conn, "image_generation", true),
            Err(AiError::ProviderNotConfigured)
        ));

        // Image provider set, but no model → rejects on the model check.
        db::set_setting(&conn, settings_keys::image::PROVIDER, "openai").unwrap();
        assert!(matches!(
            check_set_feature_gate(&conn, "image_generation", true),
            Err(AiError::ProviderError(_))
        ));

        // Both set → succeeds.
        db::set_setting(&conn, settings_keys::image::IMAGE_MODEL, "gpt-image-2").unwrap();
        assert!(check_set_feature_gate(&conn, "image_generation", true).is_ok());
    }

    /// The image slot carries its OWN privacy receipt requirement — a user
    /// who accepted for a local chat provider must not silently get a
    /// hosted image provider approved along with it.
    #[test]
    fn set_ai_feature_image_generation_requires_the_image_slots_privacy_receipt() {
        let state = make_state();
        let conn = state.lock().unwrap();
        db::set_setting(&conn, settings_keys::image::PROVIDER, "openai").unwrap();
        db::set_setting(&conn, settings_keys::image::IMAGE_MODEL, "gpt-image-2").unwrap();
        assert!(matches!(
            check_set_feature_gate(&conn, "image_generation", true),
            Err(AiError::PrivacyNotAccepted)
        ));
        accept_privacy(&conn);
        assert!(check_set_feature_gate(&conn, "image_generation", true).is_ok());
    }

    #[test]
    fn set_ai_feature_disable_always_allowed() {
        let state = make_state();
        let conn = state.lock().unwrap();
        // No slots, no privacy — disable must still succeed for any feature.
        for f in [
            "semantic_search",
            "daily_chat",
            "image_generation",
            "go_deeper",
            "user_memory",
        ] {
            if f == "user_memory" {
                // Handled outside feature_requirement — preference write only.
                db::set_setting(&conn, settings_keys::USER_MEMORY_ENABLED, "false").unwrap();
                assert!(!read_feature_toggle_defaulting_on(
                    &conn,
                    settings_keys::USER_MEMORY_ENABLED
                ));
                continue;
            }
            assert!(
                check_set_feature_gate(&conn, f, false).is_ok(),
                "disable of {f} must always succeed"
            );
        }
    }

    #[test]
    fn user_memory_feature_requirement_is_not_via_app_slots() {
        // user_memory is deliberately absent from feature_requirement —
        // it uses the independent memory slot pair.
        assert!(matches!(
            feature_requirement("user_memory"),
            Err(AiError::ProviderError(_))
        ));
    }

    #[test]
    fn is_user_memory_active_requires_preference_and_slots() {
        use crate::ai::provider_registry::ProviderRegistry;
        let state = make_state();
        let conn = state.lock().unwrap();
        let registry = ProviderRegistry::default();
        // Default preference ON, but no slots → inactive.
        assert!(!is_user_memory_active(&conn, &registry));
        db::set_setting(&conn, settings_keys::USER_MEMORY_ENABLED, "false").unwrap();
        assert!(!is_user_memory_active(&conn, &registry));
    }

    // ── Phase 2 Task 6: mid-session worker wake ─────────────────────────────

    /// `is_embedding_consuming_feature_key` is the AppHandle-free core of
    /// `set_ai_feature`'s worker-nudge decision (the `AppHandle`-dependent
    /// `start_indexing_worker` call itself isn't unit-mockable — same
    /// pattern as `check_set_feature_gate` above). Must match exactly the
    /// three keys `embedding_features_enabled` ORs together.
    #[test]
    fn is_embedding_consuming_feature_key_matches_embedding_features_enabled_keys() {
        assert!(is_embedding_consuming_feature_key(
            settings_keys::SEMANTIC_SEARCH_ENABLED
        ));
        assert!(is_embedding_consuming_feature_key(
            settings_keys::EMOTION_SUGGESTIONS_ENABLED
        ));
        // Generation-side features must never trigger the nudge.
        for key in [
            settings_keys::DAILY_CHAT_ENABLED,
            settings_keys::TITLE_SUGGESTIONS_ENABLED,
            settings_keys::IMAGE_GENERATION_ENABLED,
        ] {
            assert!(!is_embedding_consuming_feature_key(key));
        }
    }

    #[test]
    fn chat_rag_is_an_embedding_consuming_feature_key() {
        assert!(is_embedding_consuming_feature_key(
            settings_keys::CHAT_RAG_ENABLED
        ));
    }

    // ── ai_v2 migration ─────────────────────────────────────────────────────

    fn seed_embedding_row(conn: &rusqlite::Connection, entry_id: &str, model_id: &str) {
        conn.execute(
            "INSERT INTO journals (id, name, color, created_at, updated_at, sort_order)
             VALUES (?1, 'j', NULL, 1, 1, 0)
             ON CONFLICT DO NOTHING",
            rusqlite::params!["j1"],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO entries (id, journal_id, title, content_text, entry_date, created_at, updated_at)
             VALUES (?1, 'j1', 't', '', 1, 1, 1)
             ON CONFLICT DO NOTHING",
            rusqlite::params![entry_id],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO entry_embedding_chunks
                (entry_id, model_id, chunk_index, content_hash, char_start, char_end,
                 preview, dim, vec, indexed_at)
             VALUES (?1, ?2, 0, 'seed-hash', 0, 1, NULL, 4, X'00000000000000000000000000000000', 1)",
            rusqlite::params![entry_id, model_id],
        )
        .unwrap();
    }

    fn count_embeddings(conn: &rusqlite::Connection) -> i64 {
        conn.query_row("SELECT COUNT(*) FROM entry_embedding_chunks", [], |r| {
            r.get(0)
        })
        .unwrap()
    }

    #[test]
    fn migration_idempotent_when_flag_set() {
        let state = make_state();
        let conn = state.lock().unwrap();
        db::set_setting(&conn, settings_keys::AI_V2_MIGRATED, "true").unwrap();
        let outcome = run_ai_v2_migration(&conn, None).unwrap();
        assert!(!outcome.ran);
        assert_eq!(outcome.reason, Some(MigrationDeferReason::AlreadyMigrated));
        assert_eq!(outcome.orphan_rows_deleted, 0);
    }

    #[test]
    fn migration_defers_when_db_looks_locked() {
        // Reproduce the placeholder-DB topology: encryption_mode=password
        // and zero entries (the fingerprint a locked startup placeholder
        // has). Migration must defer rather than set the flag here.
        let state = make_state();
        let conn = state.lock().unwrap();
        db::set_encryption_mode(&conn, db::EncryptionMode::Password).unwrap();
        // No entries seeded — count is 0.
        let outcome = run_ai_v2_migration(&conn, None).unwrap();
        assert!(!outcome.ran);
        assert_eq!(outcome.reason, Some(MigrationDeferReason::DeferredLocked));
        // CRITICAL: the flag MUST NOT be set on a deferred run, otherwise
        // the real DB never gets migrated post-unlock.
        assert!(
            db::get_setting(&conn, settings_keys::AI_V2_MIGRATED)
                .unwrap()
                .is_none(),
            "ai_v2_migrated flag must not be set on a deferred migration"
        );
    }

    #[test]
    fn migration_runs_when_encrypted_db_has_entries() {
        // Same encryption_mode=password, but with at least one entry — i.e.
        // the user has unlocked at least once. Migration runs normally.
        let state = make_state();
        let conn = state.lock().unwrap();
        db::set_encryption_mode(&conn, db::EncryptionMode::Password).unwrap();
        seed_embedding_row(&conn, "e1", "embedding-gemma-300m");
        let outcome = run_ai_v2_migration(&conn, None).unwrap();
        assert!(outcome.ran);
        assert_eq!(outcome.orphan_rows_deleted, 1);
    }

    #[test]
    fn migration_deletes_all_rows_when_no_provider_configured() {
        let state = make_state();
        let conn = state.lock().unwrap();
        seed_embedding_row(&conn, "e1", "embedding-gemma-300m");
        seed_embedding_row(&conn, "e2", "embedding-stub-768");
        assert_eq!(count_embeddings(&conn), 2);
        let outcome = run_ai_v2_migration(&conn, None).unwrap();
        assert!(outcome.ran);
        assert_eq!(outcome.orphan_rows_deleted, 2);
        assert_eq!(count_embeddings(&conn), 0);
        assert_eq!(
            db::get_setting(&conn, settings_keys::AI_V2_MIGRATED)
                .unwrap()
                .as_deref(),
            Some("true")
        );
    }

    #[test]
    fn migration_keeps_active_provider_rows() {
        let state = make_state();
        let conn = state.lock().unwrap();
        db::set_setting(&conn, settings_keys::PROVIDER, "openai").unwrap();
        seed_embedding_row(&conn, "e1", "openai:text-embedding-3-small");
        seed_embedding_row(&conn, "e2", "embedding-gemma-300m");
        seed_embedding_row(&conn, "e3", "embedding-stub-768");
        assert_eq!(count_embeddings(&conn), 3);
        let outcome = run_ai_v2_migration(&conn, None).unwrap();
        assert!(outcome.ran);
        assert_eq!(outcome.orphan_rows_deleted, 2);
        assert_eq!(count_embeddings(&conn), 1);
        // The openai: row survives.
        let surviving: String = conn
            .query_row("SELECT model_id FROM entry_embedding_chunks", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(surviving, "openai:text-embedding-3-small");
    }

    #[test]
    fn migration_removes_models_dir_when_present() {
        let state = make_state();
        let conn = state.lock().unwrap();
        let tmp = TempDir::new().unwrap();
        let models = tmp.path().join("models");
        std::fs::create_dir_all(&models).unwrap();
        std::fs::write(models.join("placeholder.bin"), b"x").unwrap();
        let outcome = run_ai_v2_migration(&conn, Some(tmp.path())).unwrap();
        assert!(outcome.ran);
        assert!(outcome.models_dir_removed);
        assert!(!models.exists(), "models dir should be gone");
    }

    #[test]
    fn migration_no_op_when_models_dir_missing() {
        let state = make_state();
        let conn = state.lock().unwrap();
        let tmp = TempDir::new().unwrap();
        // No models/ subdir.
        let outcome = run_ai_v2_migration(&conn, Some(tmp.path())).unwrap();
        assert!(outcome.ran);
        assert!(!outcome.models_dir_removed);
    }

    #[test]
    fn migration_runs_only_once() {
        let state = make_state();
        let conn = state.lock().unwrap();
        seed_embedding_row(&conn, "e1", "embedding-gemma-300m");
        let first = run_ai_v2_migration(&conn, None).unwrap();
        assert!(first.ran);
        // Re-seed; second call must NOT delete because flag is set.
        seed_embedding_row(&conn, "e2", "embedding-gemma-300m");
        let second = run_ai_v2_migration(&conn, None).unwrap();
        assert!(!second.ran);
        assert_eq!(count_embeddings(&conn), 1, "second call must not delete");
    }

    // ── Unified privacy receipt ───────────────────────────────────────────

    #[test]
    fn class_privacy_local_auto_exempt_remote_requires_receipt() {
        let state = make_state();
        let conn = state.lock().unwrap();
        assert!(class_privacy_accepted(&conn, EndpointClass::Local).unwrap());
        assert!(!class_privacy_accepted(&conn, EndpointClass::Remote).unwrap());
        assert!(!class_privacy_accepted(&conn, EndpointClass::Subscription).unwrap());
    }

    #[test]
    fn unified_receipt_covers_remote_and_subscription() {
        let state = make_state();
        let conn = state.lock().unwrap();
        db::set_setting(&conn, settings_keys::PRIVACY_ACCEPTED_AT, "200").unwrap();
        assert!(class_privacy_accepted(&conn, EndpointClass::Remote).unwrap());
        assert!(class_privacy_accepted(&conn, EndpointClass::Subscription).unwrap());
    }

    #[test]
    fn read_full_settings_returns_privacy_accepted_at() {
        let state = make_state();
        let conn = state.lock().unwrap();
        db::set_setting(&conn, settings_keys::PRIVACY_ACCEPTED_AT, "100").unwrap();
        let s = read_full_settings(&conn);
        assert_eq!(s.privacy_accepted_at, Some(100));
    }

    #[test]
    fn read_privacy_accepted_at_migrates_legacy_remote_receipt() {
        let state = make_state();
        let conn = state.lock().unwrap();
        db::set_setting(&conn, privacy_key_for_class(EndpointClass::Remote), "150").unwrap();
        assert_eq!(read_privacy_accepted_at(&conn).unwrap(), Some(150));
    }

    #[test]
    fn require_bulk_consent_local_exempt_even_without_receipt() {
        let state = make_state();
        let conn = state.lock().unwrap();
        assert!(require_bulk_consent(&conn, EndpointClass::Local, 3).is_ok());
    }

    #[test]
    fn require_bulk_consent_remote_unaccepted_returns_error() {
        let state = make_state();
        let conn = state.lock().unwrap();
        let err = require_bulk_consent(&conn, EndpointClass::Remote, 2).unwrap_err();
        assert!(matches!(err, AiError::BulkContextNotAccepted));
    }

    #[test]
    fn require_bulk_consent_remote_accepted_ok() {
        let state = make_state();
        let conn = state.lock().unwrap();
        db::set_setting(&conn, settings_keys::PRIVACY_ACCEPTED_AT, "99").unwrap();
        assert!(require_bulk_consent(&conn, EndpointClass::Remote, 2).is_ok());
    }

    #[test]
    fn read_full_settings_migrates_legacy_bulk_receipt() {
        let state = make_state();
        let conn = state.lock().unwrap();
        db::set_setting(
            &conn,
            bulk_context_key_for_class(EndpointClass::Subscription),
            "300",
        )
        .unwrap();
        let s = read_full_settings(&conn);
        assert_eq!(s.privacy_accepted_at, Some(300));
    }

    #[test]
    fn migration_promotes_legacy_per_class_receipt_to_unified() {
        let state = make_state();
        let conn = state.lock().unwrap();
        db::set_setting(&conn, privacy_key_for_class(EndpointClass::Remote), "150").unwrap();
        let _ = run_ai_v2_migration(&conn, None).unwrap();
        assert_eq!(
            db::get_setting(&conn, settings_keys::PRIVACY_ACCEPTED_AT)
                .unwrap()
                .as_deref(),
            Some("150"),
            "legacy remote receipt must be promoted before deletion",
        );
        assert!(
            db::get_setting(&conn, privacy_key_for_class(EndpointClass::Remote))
                .unwrap()
                .is_none(),
            "legacy key should be wiped after promotion",
        );
        assert_eq!(read_full_settings(&conn).privacy_accepted_at, Some(150));
    }

    #[test]
    fn migration_drops_legacy_per_class_keys() {
        let state = make_state();
        let conn = state.lock().unwrap();
        db::set_setting(&conn, settings_keys::PRIVACY_ACCEPTED_AT, "10").unwrap();
        db::set_setting(&conn, "ai_gen_privacy_accepted_at", "20").unwrap();
        db::set_setting(&conn, "ai_embed_privacy_accepted_at", "30").unwrap();
        db::set_setting(&conn, privacy_key_for_class(EndpointClass::Remote), "40").unwrap();
        let _ = run_ai_v2_migration(&conn, None).unwrap();
        assert_eq!(
            db::get_setting(&conn, settings_keys::PRIVACY_ACCEPTED_AT)
                .unwrap()
                .as_deref(),
            Some("10"),
            "unified receipt must be preserved",
        );
        for legacy in [
            "ai_gen_privacy_accepted_at",
            "ai_embed_privacy_accepted_at",
            privacy_key_for_class(EndpointClass::Remote),
            bulk_context_key_for_class(EndpointClass::Subscription),
        ] {
            assert!(
                db::get_setting(&conn, legacy).unwrap().is_none(),
                "legacy key `{legacy}` should be wiped",
            );
        }
    }

    // ── Background indexing consent gate (Phase 2 — Task 1) ────────────────

    mod background_indexing {
        use super::*;
        use crate::commands::ai_provider::{
            persist_embed_config, persist_provider_credential, AIEmbedProviderConfigInput,
        };

        fn embed_input(provider: &str, model: &str) -> AIEmbedProviderConfigInput {
            AIEmbedProviderConfigInput {
                provider: provider.into(),
                embedding_model: model.into(),
            }
        }

        #[test]
        fn background_indexing_local_auto_allowed_without_consent() {
            let state = make_state();
            let conn = state.lock().unwrap();
            // "ollama"'s default resolved endpoint classifies as `local` —
            // no separate class row to write under the registry model.
            db::set_setting(&conn, settings_keys::embed::PROVIDER, "ollama").unwrap();
            db::set_setting(&conn, settings_keys::BACKGROUND_INDEXING_ENABLED, "true").unwrap();

            assert!(
                background_indexing_allowed(&conn),
                "local/loopback embedding slot should be auto-allowed with no consent timestamp"
            );
        }

        #[test]
        fn background_indexing_hosted_requires_consent() {
            let state = make_state();
            let conn = state.lock().unwrap();
            // "openai"'s default resolved endpoint classifies as `remote`.
            // A key is on file throughout — this test is purely about the
            // consent dimension; the key dimension is covered separately by
            // `background_indexing_hosted_requires_key`.
            db::set_setting(&conn, settings_keys::embed::PROVIDER, "openai").unwrap();
            db::set_setting(&conn, settings_keys::BACKGROUND_INDEXING_ENABLED, "true").unwrap();
            persist_provider_credential(
                &conn,
                "openai",
                "https://api.openai.com/v1",
                Some("sk-test"),
            )
            .unwrap();

            assert!(
                !background_indexing_allowed(&conn),
                "hosted embedding slot without consent must stay blocked"
            );

            db::set_setting(
                &conn,
                settings_keys::BACKGROUND_INDEXING_HOSTED_CONSENT_AT,
                "1700000000",
            )
            .unwrap();

            assert!(
                background_indexing_allowed(&conn),
                "hosted embedding slot with consent recorded AND a key on file should be allowed"
            );
        }

        /// Critical fix (Phase 2): a Remote embed slot with the hosted
        /// consent receipt present but NO resolvable API key must stay
        /// blocked — this is the exact shape the R12 migration leaves an
        /// upgraded user in (provider/model + consent survive the key
        /// wipe), and also what a normal "cleared the key without
        /// switching provider" leaves behind. Re-entering the key must
        /// immediately unblock it without touching consent again.
        #[test]
        fn background_indexing_hosted_requires_key() {
            let state = make_state();
            let conn = state.lock().unwrap();
            db::set_setting(&conn, settings_keys::embed::PROVIDER, "openai").unwrap();
            db::set_setting(&conn, settings_keys::BACKGROUND_INDEXING_ENABLED, "true").unwrap();
            db::set_setting(
                &conn,
                settings_keys::BACKGROUND_INDEXING_HOSTED_CONSENT_AT,
                "1700000000",
            )
            .unwrap();

            assert!(
                !background_indexing_allowed(&conn),
                "hosted embedding slot with consent but no resolvable API key must stay blocked"
            );

            persist_provider_credential(
                &conn,
                "openai",
                "https://api.openai.com/v1",
                Some("sk-test"),
            )
            .unwrap();

            assert!(
                background_indexing_allowed(&conn),
                "re-entering the key must unblock the hosted slot without touching consent"
            );
        }

        /// Local providers work keyless — many local servers have no auth.
        #[test]
        fn background_indexing_local_auto_allowed_without_key() {
            let state = make_state();
            let conn = state.lock().unwrap();
            db::set_setting(&conn, settings_keys::embed::PROVIDER, "ollama").unwrap();
            db::set_setting(&conn, settings_keys::BACKGROUND_INDEXING_ENABLED, "true").unwrap();

            assert!(
                background_indexing_allowed(&conn),
                "local embedding slot with no key on file must stay auto-allowed"
            );
        }

        /// On-device (in-process `fastembed`) never needs a key.
        #[test]
        fn background_indexing_on_device_auto_allowed_without_key() {
            let state = make_state();
            let conn = state.lock().unwrap();
            db::set_setting(&conn, settings_keys::embed::PROVIDER, "on-device").unwrap();
            db::set_setting(&conn, settings_keys::BACKGROUND_INDEXING_ENABLED, "true").unwrap();

            assert!(
                background_indexing_allowed(&conn),
                "on-device embedding slot with no key on file must stay auto-allowed"
            );
        }

        #[test]
        fn background_indexing_master_toggle_off_blocks_regardless_of_class_or_consent() {
            let state = make_state();
            let conn = state.lock().unwrap();
            // Hosted + consent, but master toggle never turned on.
            db::set_setting(&conn, settings_keys::embed::PROVIDER, "openai").unwrap();
            db::set_setting(
                &conn,
                settings_keys::BACKGROUND_INDEXING_HOSTED_CONSENT_AT,
                "1700000000",
            )
            .unwrap();
            assert!(!background_indexing_allowed(&conn));

            // Local class, but master toggle still off.
            db::set_setting(&conn, settings_keys::embed::PROVIDER, "ollama").unwrap();
            assert!(!background_indexing_allowed(&conn));
        }

        #[test]
        fn background_indexing_provider_change_invalidates_hosted_consent() {
            let state = make_state();
            let conn = state.lock().unwrap();
            db::set_setting(&conn, settings_keys::BACKGROUND_INDEXING_ENABLED, "true").unwrap();

            // Configure a hosted provider and accept consent. "openai"'s
            // default endpoint classifies as `remote`. A key is on file so
            // this test stays about consent invalidation, not the separate
            // key dimension covered by `background_indexing_hosted_requires_key`.
            let first = embed_input("openai", "text-embedding-3-small");
            persist_embed_config(&conn, &first, EndpointClass::Remote).unwrap();
            persist_provider_credential(
                &conn,
                "openai",
                "https://api.openai.com/v1",
                Some("sk-test"),
            )
            .unwrap();
            db::set_setting(
                &conn,
                settings_keys::BACKGROUND_INDEXING_HOSTED_CONSENT_AT,
                "1700000000",
            )
            .unwrap();
            assert!(background_indexing_allowed(&conn));

            // Switching to a different hosted provider/model must clear
            // consent — "voyage"'s default endpoint also classifies as
            // `remote`, but the PROVIDER itself changed.
            let second = embed_input("voyage", "voyage-3");
            persist_embed_config(&conn, &second, EndpointClass::Remote).unwrap();

            assert!(
                db::get_setting(&conn, settings_keys::BACKGROUND_INDEXING_HOSTED_CONSENT_AT)
                    .unwrap()
                    .is_none(),
                "hosted consent must be cleared when the embedding provider/model changes"
            );
            assert!(
                !background_indexing_allowed(&conn),
                "worker must be blocked again until the user re-consents to the new provider"
            );
        }

        // ─── Task 7: the consent-granting commands, tested directly ──────

        #[test]
        fn get_background_indexing_settings_impl_defaults_to_disabled_and_no_consent() {
            let state = make_state();
            let conn = state.lock().unwrap();
            let s = get_background_indexing_settings_impl(&conn);
            assert!(!s.enabled);
            assert!(s.hosted_consent_at.is_none());
            assert!(!s.allowed, "master toggle off => not allowed");
        }

        #[test]
        fn set_background_indexing_enabled_impl_flips_and_persists() {
            let state = make_state();
            let conn = state.lock().unwrap();
            set_background_indexing_enabled_impl(&conn, true).unwrap();
            assert!(get_background_indexing_settings_impl(&conn).enabled);
            set_background_indexing_enabled_impl(&conn, false).unwrap();
            assert!(!get_background_indexing_settings_impl(&conn).enabled);
        }

        #[test]
        fn accept_background_indexing_hosted_consent_impl_stamps_and_is_reflected_in_settings() {
            let state = make_state();
            let conn = state.lock().unwrap();
            assert!(get_background_indexing_settings_impl(&conn)
                .hosted_consent_at
                .is_none());

            let stamped = accept_background_indexing_hosted_consent_impl(&conn).unwrap();
            assert!(stamped > 0);
            assert_eq!(
                get_background_indexing_settings_impl(&conn).hosted_consent_at,
                Some(stamped)
            );
        }

        /// Edge case named in the doc comment: toggling the master switch
        /// off/on must NOT force re-acceptance of a notice the user
        /// already saw for the same provider.
        #[test]
        fn set_background_indexing_enabled_impl_does_not_touch_hosted_consent() {
            let state = make_state();
            let conn = state.lock().unwrap();
            accept_background_indexing_hosted_consent_impl(&conn).unwrap();
            set_background_indexing_enabled_impl(&conn, true).unwrap();
            set_background_indexing_enabled_impl(&conn, false).unwrap();
            assert!(
                get_background_indexing_settings_impl(&conn)
                    .hosted_consent_at
                    .is_some(),
                "toggling the master switch must not clear hosted consent"
            );
        }
    }

    // ── Memory model slots (Phase 2 T2.3) ───────────────────────────────────
    //
    // The write commands take `tauri::State<'_>` (not unit-mockable in this
    // codebase), so the load-bearing enforcement rule is factored into the
    // pure `enforce_memory_slot_class` helper and tested directly — that is
    // the part decisions 1 + 3 actually require at write time. The read
    // paths (`read_full_settings` memory fields) ARE unit-tested directly
    // against an in-memory DB.

    mod memory_slots {
        use super::*;

        #[test]
        fn read_full_settings_returns_memory_slots_unconfigured() {
            let state = make_state();
            let conn = state.lock().unwrap();
            let s = read_full_settings(&conn);
            assert!(s.memory_gen_provider.is_none());
            assert!(s.memory_gen_endpoint.is_none());
            assert!(s.memory_gen_endpoint_class.is_none());
            assert!(s.memory_gen_chat_model.is_none());
            assert!(!s.memory_gen_has_api_key);
            assert!(s.memory_embed_provider.is_none());
            assert!(s.memory_embed_endpoint.is_none());
            assert!(s.memory_embed_endpoint_class.is_none());
            assert!(s.memory_embed_embedding_model.is_none());
            assert!(!s.memory_embed_has_api_key);
            assert!(
                s.user_memory_enabled,
                "user_memory_enabled is the preference toggle — default ON even without slots"
            );
        }

        #[test]
        fn read_full_settings_reads_saved_memory_slots() {
            let state = make_state();
            let conn = state.lock().unwrap();
            // Gen slot — local Ollama endpoint. T2.3 cutover: endpoint/key
            // live in the per-preset credential registry now, keyed by
            // provider id, not on the memory_gen::* rows.
            db::set_setting(&conn, settings_keys::memory_gen::PROVIDER, "ollama").unwrap();
            persist_provider_credential(
                &conn,
                "ollama",
                preset_default_endpoint("ollama"),
                Some("sk-mem-gen"),
            )
            .unwrap();
            db::set_setting(&conn, settings_keys::memory_gen::CHAT_MODEL, "llama3.1").unwrap();
            // Embed slot — on-device fastembed (no HTTP endpoint, no key).
            db::set_setting(&conn, settings_keys::memory_embed::PROVIDER, "on-device").unwrap();
            db::set_setting(
                &conn,
                settings_keys::memory_embed::EMBEDDING_MODEL,
                "nomic-embed-text-v1.5",
            )
            .unwrap();

            let s = read_full_settings(&conn);
            assert_eq!(s.memory_gen_provider.as_deref(), Some("ollama"));
            assert_eq!(
                s.memory_gen_endpoint.as_deref(),
                Some(preset_default_endpoint("ollama"))
            );
            assert_eq!(s.memory_gen_endpoint_class, Some(EndpointClass::Local));
            assert_eq!(s.memory_gen_chat_model.as_deref(), Some("llama3.1"));
            assert!(s.memory_gen_has_api_key);
            assert_eq!(s.memory_embed_provider.as_deref(), Some("on-device"));
            assert_eq!(s.memory_embed_endpoint_class, Some(EndpointClass::OnDevice));
            assert_eq!(
                s.memory_embed_embedding_model.as_deref(),
                Some("nomic-embed-text-v1.5")
            );
            assert!(
                !s.memory_embed_has_api_key,
                "embed api_key was never written"
            );
            assert!(
                s.user_memory_enabled,
                "preference defaults ON regardless of slots"
            );
        }

        #[test]
        fn read_full_settings_user_memory_preference_can_be_turned_off() {
            let state = make_state();
            let conn = state.lock().unwrap();
            db::set_setting(&conn, settings_keys::USER_MEMORY_ENABLED, "false").unwrap();
            let s = read_full_settings(&conn);
            assert!(!s.user_memory_enabled);
        }

        #[test]
        fn read_full_settings_memory_slots_independent_of_preference() {
            let state = make_state();
            let conn = state.lock().unwrap();
            // Only the gen slot is configured.
            db::set_setting(&conn, settings_keys::memory_gen::PROVIDER, "ollama").unwrap();
            let s = read_full_settings(&conn);
            assert_eq!(s.memory_gen_provider.as_deref(), Some("ollama"));
            assert!(s.memory_embed_provider.is_none());
            // Preference still default-on; half a pair is handled by the
            // runtime gate (`is_user_memory_active`), not this flag.
            assert!(s.user_memory_enabled);
        }

        /// Guard against a future regression that adds a raw `memory_*_api_key`
        /// field to `AIFullSettings` — the VALUE must never leave the backend.
        #[test]
        fn read_full_settings_does_not_return_memory_api_key_values() {
            let state = make_state();
            let conn = state.lock().unwrap();
            db::set_setting(&conn, settings_keys::memory_gen::PROVIDER, "ollama").unwrap();
            db::set_setting(&conn, settings_keys::memory_embed::PROVIDER, "on-device").unwrap();
            // T2.3 cutover: the key lives in the per-preset credential
            // registry, keyed by provider id.
            persist_provider_credential(
                &conn,
                "ollama",
                "http://127.0.0.1:11434/v1",
                Some("sk-mem-gen-secret"),
            )
            .unwrap();
            persist_provider_credential(&conn, "on-device", "", Some("sk-mem-embed-secret"))
                .unwrap();
            let s = read_full_settings(&conn);
            assert!(s.memory_gen_has_api_key);
            assert!(s.memory_embed_has_api_key);
            let json = serde_json::to_string(&s).unwrap();
            assert!(
                !json.contains("sk-mem-gen-secret"),
                "leaked gen key: {json}"
            );
            assert!(
                !json.contains("sk-mem-embed-secret"),
                "leaked embed key: {json}"
            );
        }

        // ── Pure enforcement helper (the load-bearing write-time rule) ──────

        #[test]
        fn set_memory_gen_provider_accepts_local_http_endpoint() {
            let class = enforce_memory_slot_class(
                "ollama",
                "http://localhost:11434",
                MemorySlotKind::Generation,
                false,
            )
            .unwrap();
            assert_eq!(class, EndpointClass::Local);
        }

        #[test]
        fn set_memory_gen_provider_accepts_on_device_llm_sentinel() {
            let class =
                enforce_memory_slot_class("on-device-llm", "", MemorySlotKind::Generation, false)
                    .unwrap();
            assert_eq!(class, EndpointClass::OnDevice);
        }

        #[test]
        fn set_memory_gen_provider_rejects_remote() {
            let err = enforce_memory_slot_class(
                "openai",
                "https://api.openai.com/v1",
                MemorySlotKind::Generation,
                false,
            )
            .unwrap_err();
            assert!(matches!(err, AiError::ProviderError(_)));
            assert!(
                err.to_string().contains("remote"),
                "remote rejection message should mention remote: {}",
                err
            );
        }

        #[test]
        fn set_memory_gen_provider_rejects_subscription() {
            let err =
                enforce_memory_slot_class("claude-cli", "", MemorySlotKind::Generation, false)
                    .unwrap_err();
            assert!(matches!(err, AiError::ProviderError(_)));
            assert!(
                err.to_string().to_lowercase().contains("subscription"),
                "subscription rejection message should mention subscription/CLI: {}",
                err
            );
        }

        #[test]
        fn set_memory_gen_provider_rejects_on_device_embed_sentinel() {
            let err = enforce_memory_slot_class("on-device", "", MemorySlotKind::Generation, false)
                .unwrap_err();
            assert!(matches!(err, AiError::ProviderError(_)));
            assert!(
                err.to_string().contains("embedding-only"),
                "gen slot should reject embedding-only on-device sentinel: {}",
                err
            );
        }

        #[test]
        fn set_memory_embed_provider_accepts_local_http_endpoint() {
            let class = enforce_memory_slot_class(
                "ollama",
                "http://localhost:11434",
                MemorySlotKind::Embedding,
                false,
            )
            .unwrap();
            assert_eq!(class, EndpointClass::Local);
        }

        #[test]
        fn set_memory_embed_provider_accepts_on_device_embed_sentinel() {
            let class =
                enforce_memory_slot_class("on-device", "", MemorySlotKind::Embedding, false)
                    .unwrap();
            assert_eq!(class, EndpointClass::OnDevice);
        }

        #[test]
        fn set_memory_embed_provider_rejects_remote() {
            let err = enforce_memory_slot_class(
                "openai",
                "https://api.openai.com/v1",
                MemorySlotKind::Embedding,
                false,
            )
            .unwrap_err();
            assert!(matches!(err, AiError::ProviderError(_)));
            assert!(
                err.to_string().contains("remote"),
                "remote rejection message should mention remote: {}",
                err
            );
        }

        #[test]
        fn set_memory_embed_provider_rejects_subscription() {
            let err = enforce_memory_slot_class("claude-cli", "", MemorySlotKind::Embedding, false)
                .unwrap_err();
            assert!(matches!(err, AiError::ProviderError(_)));
            assert!(
                err.to_string().to_lowercase().contains("subscription"),
                "subscription rejection message should mention subscription/CLI: {}",
                err
            );
        }

        #[test]
        fn set_memory_embed_provider_rejects_on_device_llm_sentinel() {
            let err =
                enforce_memory_slot_class("on-device-llm", "", MemorySlotKind::Embedding, false)
                    .unwrap_err();
            assert!(matches!(err, AiError::ProviderError(_)));
            assert!(
                err.to_string().contains("generation-only"),
                "embed slot should reject generation-only on-device-llm sentinel: {}",
                err
            );
        }

        // ── C1: `allow_hosted` acknowledgement flag ─────────────────────────

        #[test]
        fn allow_hosted_true_accepts_remote_for_both_slots() {
            let class = enforce_memory_slot_class(
                "openai",
                "https://api.openai.com/v1",
                MemorySlotKind::Generation,
                true,
            )
            .unwrap();
            assert_eq!(class, EndpointClass::Remote);

            let class = enforce_memory_slot_class(
                "openai",
                "https://api.openai.com/v1",
                MemorySlotKind::Embedding,
                true,
            )
            .unwrap();
            assert_eq!(class, EndpointClass::Remote);
        }

        #[test]
        fn allow_hosted_true_accepts_subscription_for_both_slots() {
            let class =
                enforce_memory_slot_class("claude-cli", "", MemorySlotKind::Generation, true)
                    .unwrap();
            assert_eq!(class, EndpointClass::Subscription);

            let class = enforce_memory_slot_class("codex-cli", "", MemorySlotKind::Embedding, true)
                .unwrap();
            assert_eq!(class, EndpointClass::Subscription);
        }

        #[test]
        fn allow_hosted_true_does_not_relax_capability_rejections() {
            // The embedding-only sentinel must still be rejected for the gen
            // slot, and the generation-only sentinel must still be rejected
            // for the embed slot, regardless of `allow_hosted` — this is a
            // correctness rule, not a privacy one.
            let err = enforce_memory_slot_class("on-device", "", MemorySlotKind::Generation, true)
                .unwrap_err();
            assert!(err.to_string().contains("embedding-only"));

            let err =
                enforce_memory_slot_class("on-device-llm", "", MemorySlotKind::Embedding, true)
                    .unwrap_err();
            assert!(err.to_string().contains("generation-only"));
        }

        #[test]
        fn allow_hosted_true_does_not_affect_local_or_on_device() {
            // Local/OnDevice were already accepted with the flag off; they
            // must remain accepted (and still classify the same) with it on.
            let class = enforce_memory_slot_class(
                "ollama",
                "http://localhost:11434",
                MemorySlotKind::Generation,
                true,
            )
            .unwrap();
            assert_eq!(class, EndpointClass::Local);

            let class = enforce_memory_slot_class("on-device", "", MemorySlotKind::Embedding, true)
                .unwrap();
            assert_eq!(class, EndpointClass::OnDevice);
        }

        /// Symmetry guard: the two capability rejections are slot-specific.
        /// The embedding-only sentinel must be REJECTED for gen but ACCEPTED
        /// for embed; the generation-only sentinel must be REJECTED for embed
        /// but ACCEPTED for gen. A future refactor that swaps the two
        /// capability checks would otherwise pass the per-slot tests above.
        #[test]
        fn enforce_memory_slot_capability_rejection_is_slot_specific() {
            // on-device (embed sentinel): gen rejects, embed accepts.
            assert!(
                enforce_memory_slot_class("on-device", "", MemorySlotKind::Generation, false)
                    .is_err()
            );
            assert!(
                enforce_memory_slot_class("on-device", "", MemorySlotKind::Embedding, false)
                    .is_ok()
            );
            // on-device-llm (gen sentinel): embed rejects, gen accepts.
            assert!(enforce_memory_slot_class(
                "on-device-llm",
                "",
                MemorySlotKind::Embedding,
                false
            )
            .is_err());
            assert!(enforce_memory_slot_class(
                "on-device-llm",
                "",
                MemorySlotKind::Generation,
                false
            )
            .is_ok());
        }

        // ── C1: revocation clears an already-active hosted slot ─────────────

        #[test]
        fn reject_disallowed_memory_slots_clears_registry_when_flag_turned_off() {
            let state = make_state();
            let registry = ProviderRegistry::default();
            let conn = state.lock().unwrap();
            // Persist a hosted gen row and a hosted embed row, both allowed
            // while the flag was on, and swap them into the registry — this
            // simulates the state right before the user revokes.
            // "openai"'s default resolved endpoint is already
            // `https://api.openai.com/v1` — no registry override needed.
            db::set_setting(&conn, settings_keys::memory_gen::PROVIDER, "openai").unwrap();
            db::set_setting(&conn, settings_keys::memory_embed::PROVIDER, "claude-cli").unwrap();
            db::set_setting(&conn, settings_keys::MEMORY_ALLOW_HOSTED, "false").unwrap();
            registry.swap_memory_generation(Arc::new(
                crate::ai::providers::openai_compat::OpenAICompatibleProvider::new(
                    crate::ai::providers::openai_compat::OpenAICompatibleConfig {
                        id: "openai".into(),
                        display_name: "openai".into(),
                        endpoint: "https://api.openai.com/v1".into(),
                        api_key: None,
                        chat_model: "gpt-4o-mini".into(),
                        embedding_model: String::new(),
                        image_model: None,
                    },
                )
                .unwrap(),
            ));
            // F10: the embed side of this test previously only wrote the
            // persisted `memory_embed::PROVIDER` row without ever swapping a
            // provider into the registry — `registry.memory_embedder()` was
            // already `None` before the call, so the embed clear path ran
            // with zero coverage. Swap one in (concrete type doesn't matter;
            // the class check reads the settings row, not the live object)
            // so the assertion below actually exercises `clear_memory_embedding`.
            registry.swap_memory_embedding(Arc::new(
                crate::ai::providers::openai_compat::OpenAICompatibleProvider::new(
                    crate::ai::providers::openai_compat::OpenAICompatibleConfig {
                        id: "claude-cli".into(),
                        display_name: "claude-cli".into(),
                        endpoint: String::new(),
                        api_key: None,
                        chat_model: String::new(),
                        embedding_model: "fake-embed-model".into(),
                        image_model: None,
                    },
                )
                .unwrap(),
            ));

            reject_disallowed_memory_slots_impl(&conn, &registry);

            assert!(
                registry.memory_generation().is_none(),
                "a hosted gen slot must be rejected once allow_hosted is false"
            );
            assert!(
                registry.memory_embedder().is_none(),
                "a hosted/CLI embed slot must be rejected once allow_hosted is false"
            );
        }

        #[test]
        fn reject_disallowed_memory_slots_is_noop_when_allow_hosted_true() {
            let state = make_state();
            let registry = ProviderRegistry::default();
            let conn = state.lock().unwrap();
            // "openai"'s default resolved endpoint is already
            // `https://api.openai.com/v1` — no registry override needed.
            db::set_setting(&conn, settings_keys::memory_gen::PROVIDER, "openai").unwrap();
            db::set_setting(&conn, settings_keys::MEMORY_ALLOW_HOSTED, "true").unwrap();
            registry.swap_memory_generation(Arc::new(
                crate::ai::providers::openai_compat::OpenAICompatibleProvider::new(
                    crate::ai::providers::openai_compat::OpenAICompatibleConfig {
                        id: "openai".into(),
                        display_name: "openai".into(),
                        endpoint: "https://api.openai.com/v1".into(),
                        api_key: None,
                        chat_model: "gpt-4o-mini".into(),
                        embedding_model: String::new(),
                        image_model: None,
                    },
                )
                .unwrap(),
            ));

            reject_disallowed_memory_slots_impl(&conn, &registry);

            assert!(
                registry.memory_generation().is_some(),
                "allow_hosted true must leave an already-hosted slot alone"
            );
        }

        #[test]
        fn reject_disallowed_memory_slots_is_noop_when_slot_unconfigured() {
            let state = make_state();
            let registry = ProviderRegistry::default();
            let conn = state.lock().unwrap();
            db::set_setting(&conn, settings_keys::MEMORY_ALLOW_HOSTED, "false").unwrap();
            // Nothing configured — must not panic, must not touch the registry.
            reject_disallowed_memory_slots_impl(&conn, &registry);
            assert!(registry.memory_generation().is_none());
            assert!(registry.memory_embedder().is_none());
        }

        // ── set_memory_allow_hosted: turn-ON re-hydrate wiring (review F8) ───

        /// Turning the flag ON must re-hydrate BOTH persisted memory slots
        /// from disk into the registry — before this fix, a slot that was
        /// rejected while the flag was off stayed inert until restart or an
        /// unrelated manual re-save. Previously only exercised indirectly
        /// through the frontend flow; this drives the testable core directly.
        #[test]
        fn set_memory_allow_hosted_on_rehydrates_both_persisted_slots() {
            let state = make_state();
            let registry = ProviderRegistry::default();
            let conn = state.lock().unwrap();
            // "ollama"'s default resolved endpoint is already
            // `http://127.0.0.1:11434/v1` — no registry override needed.
            for (k, v) in [
                (settings_keys::memory_gen::PROVIDER, "ollama"),
                (settings_keys::memory_gen::CHAT_MODEL, "llama3.1"),
                (settings_keys::memory_embed::PROVIDER, "ollama"),
                (
                    settings_keys::memory_embed::EMBEDDING_MODEL,
                    "nomic-embed-text",
                ),
                (settings_keys::MEMORY_ALLOW_HOSTED, "false"),
            ] {
                db::set_setting(&conn, k, v).unwrap();
            }
            assert!(
                registry.memory_generation().is_none(),
                "test precondition: registry starts empty (simulates a fresh unlock)"
            );
            assert!(registry.memory_embedder().is_none());

            let result = set_memory_allow_hosted_impl(&conn, &registry, true, None, None, None)
                .expect("turn-on must not error");

            assert!(result.allow_hosted);
            assert!(
                registry.memory_generation().is_some(),
                "gen slot must be re-hydrated from its persisted config on turn-ON"
            );
            assert!(
                registry.memory_embedder().is_some(),
                "embed slot must be re-hydrated from its persisted config on turn-ON"
            );
            assert!(
                result.memory_enabled,
                "both slots hydrated → is_memory_enabled() reads true"
            );
        }

        /// Turning the flag OFF still routes through
        /// `reject_disallowed_memory_slots_impl` — pins the branch so a
        /// future edit can't accidentally make turn-OFF also re-hydrate.
        #[test]
        fn set_memory_allow_hosted_off_clears_hosted_slot() {
            let state = make_state();
            let registry = ProviderRegistry::default();
            let conn = state.lock().unwrap();
            // "openai"'s default resolved endpoint is already
            // `https://api.openai.com/v1` — no registry override needed.
            db::set_setting(&conn, settings_keys::memory_gen::PROVIDER, "openai").unwrap();
            db::set_setting(&conn, settings_keys::MEMORY_ALLOW_HOSTED, "true").unwrap();
            registry.swap_memory_generation(Arc::new(
                crate::ai::providers::openai_compat::OpenAICompatibleProvider::new(
                    crate::ai::providers::openai_compat::OpenAICompatibleConfig {
                        id: "openai".into(),
                        display_name: "openai".into(),
                        endpoint: "https://api.openai.com/v1".into(),
                        api_key: None,
                        chat_model: "gpt-4o-mini".into(),
                        embedding_model: String::new(),
                        image_model: None,
                    },
                )
                .unwrap(),
            ));

            let result = set_memory_allow_hosted_impl(&conn, &registry, false, None, None, None)
                .expect("turn-off must not error");

            assert!(!result.allow_hosted);
            assert!(
                registry.memory_generation().is_none(),
                "an already-hosted gen slot must be rejected on turn-OFF"
            );
        }
    }
}
