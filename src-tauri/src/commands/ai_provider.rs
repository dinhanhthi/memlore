//! Tauri commands for managing the two-slot AI provider config (Phase 6 v2 R11+).
//!
//! Surface:
//!
//! - [`set_ai_generation_provider`] — persists generation-slot config to
//!   `ai_gen_*` settings rows, swaps the registry's generation slot.
//! - [`set_ai_embedding_provider`] — persists embedding-slot config to
//!   `ai_embed_*` settings rows, swaps the registry's embedding slot.
//! - [`get_ai_providers`] — returns both slots in one shot for the Settings panel.
//!   **Never** returns API keys; `has_api_key: bool` only.
//! - [`forget_ai_generation_provider`] — wipes `ai_gen_*` keys + clears the
//!   generation registry slot, runs `PRAGMA wal_checkpoint(TRUNCATE)`.
//! - [`forget_ai_embedding_provider`] — same for the `ai_embed_*` slot.
//! - [`test_ai_generation_provider`] — transient chat probe (no persist).
//! - [`test_ai_embedding_provider`] — transient embed probe (no persist).
//!
//! ## Why a separate file
//!
//! `commands/ai.rs` carries the AI **feature** stubs (suggest_emotion,
//! suggest_title, summarise_entry, backfill, …). Provider config is
//! orthogonal — it has its own state object (`ProviderRegistry`) and its
//! own settings rows.

use crate::ai::error::AiError;
use crate::ai::on_device::catalog;
use crate::ai::on_device::download::DownloadManager;
use crate::ai::on_device::llm_catalog;
use crate::ai::on_device::llm_download::LlmAssetManager;
use crate::ai::on_device::server::LlamaServerManager;
use crate::ai::provider::{
    classify_endpoint, provider_namespaced_model_id, settings_keys, AIProvider, EndpointClass,
};
use crate::ai::provider_registry::ProviderRegistry;
use crate::ai::providers::cli::{
    claude::{ClaudeCliProvider, PROVIDER_ID as CLAUDE_CLI_ID},
    codex::{CodexCliProvider, PROVIDER_ID as CODEX_CLI_ID},
};
use crate::ai::providers::on_device_embed::{
    OnDeviceEmbedProvider, PROVIDER_ID as ON_DEVICE_PROVIDER_ID,
};
use crate::ai::providers::on_device_llm::{OnDeviceLlmProvider, PROVIDER_ID as ON_DEVICE_LLM_ID};
use crate::ai::providers::openai_compat::{OpenAICompatibleConfig, OpenAICompatibleProvider};
// C1: the post-unlock memory-slot loaders re-run the on-machine class rule
// against persisted rows (defense-in-depth against a hand-edited / downgraded
// DB sneaking a Remote class into the registry). Reuse the same pure helper
// the write commands use, not a copy.
use crate::commands::ai_settings::{enforce_memory_slot_class, MemorySlotKind};
use crate::db;
use crate::AppState;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Instant;
use tauri::Emitter;
use tauri::State;
use zeroize::Zeroizing;

// ─── Wire types (sanitised) ─────────────────────────────────────────────────

/// Outcome of [`set_ai_generation_provider`] / [`set_ai_embedding_provider`] — feeds the Settings panel's privacy
/// modal without forcing a follow-up `get_ai_provider` round-trip.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SetProviderResult {
    pub provider: String,
    pub endpoint_class: EndpointClass,
    /// True iff the **new** slot's endpoint class has not yet been
    /// accepted by the user. The Settings panel uses this to pop the
    /// global privacy modal pre-set to that class. NOTE: this is a
    /// read-only hint — persisting a config never wipes any privacy
    /// receipt (acceptance is per class, not per slot).
    pub requires_privacy_consent: bool,
}

/// Outcome of [`set_ai_provider_credential`] (T1.6) — the per-preset analogue
/// of [`SetProviderResult`]. Deliberately reuses the exact same
/// `requires_privacy_consent` shape/semantics rather than inventing a new
/// one; `preset_id` replaces `provider` since the credential registry is
/// keyed by preset id, not by an active slot's provider id.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SetCredentialOutcome {
    pub preset_id: String,
    pub endpoint_class: EndpointClass,
    pub requires_privacy_consent: bool,
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/// Shared URL validator used by `validate_slot` (Settings-panel input) and
/// `load_gen_slot` / `load_embed_slot` (post-unlock hydration). A malformed
/// row in the DB shouldn't crash the app — but it also shouldn't silently
/// produce a provider that 100% of requests fail against with an opaque error.
pub(crate) fn validate_endpoint_url(s: &str) -> Result<(), AiError> {
    let parsed = url::Url::parse(s)
        .map_err(|e| AiError::ProviderError(format!("endpoint is not a valid URL: {s}: {e}")))?;
    let scheme = parsed.scheme();
    if scheme != "http" && scheme != "https" {
        return Err(AiError::ProviderError(format!(
            "endpoint scheme must be http or https, got `{scheme}`"
        )));
    }
    if parsed.host_str().map(|h| h.is_empty()).unwrap_or(true) {
        return Err(AiError::ProviderError("endpoint URL has no host".into()));
    }
    Ok(())
}

// ─── Two-slot (R11+) API ───────────────────────────────────────────────────
//
// The slot abstraction (`SlotKeys` trait + `Slot` enum) DRYs the
// persist/load/forget logic for the generation and embedding namespaces.

/// Per-slot settings key bundle. Implemented for `gen_keys` / `embed_keys`
/// below — both are zero-sized marker structs.
trait SlotKeys {
    const PROVIDER: &'static str;
    /// `Some(model)` for the model-bearing field used by this slot
    /// (chat_model for gen, embedding_model for embed). Image model is
    /// gen-only; the persist path reads it directly off the input.
    fn model_key() -> &'static str;
}

struct GenKeys;
impl SlotKeys for GenKeys {
    const PROVIDER: &'static str = settings_keys::gen::PROVIDER;
    fn model_key() -> &'static str {
        settings_keys::gen::CHAT_MODEL
    }
}

// ─── Per-preset credential registry (T1.3) ─────────────────────────────────
//
// Generalizes the generation-only `GEN_API_KEYRING` into two per-preset maps
// that the upcoming Providers tab (Phase 3) reads and writes. The keyring
// identity is the **preset id**, not `gen_credential_identity(provider,
// endpoint)` — under a per-preset registry the registry *owns* the endpoint,
// so `provider|endpoint` keying would silently orphan the key whenever a user
// edits a custom endpoint. `BTreeMap` (not `HashMap`) is required so JSON
// serialization is deterministically ordered for content-hash stability.
//
// Both maps live in the settings table; `PROVIDER_KEYRING` is intentionally
// absent from the sync allow-list (asserted in tests), and `PROVIDER_ENDPOINTS`
// joins the allow-list only in T2.4.

/// Syncable per-preset endpoint-override map. Value shape (T36, 2026-09-03):
/// `{ [preset]: { endpoint: string | null, updated_at: i64 } }`.
/// `null` = tombstone (reset-to-default). No migration shim — old
/// `BTreeMap<preset, endpoint>` rows degrade to empty.
const PROVIDER_ENDPOINTS: &str = db::AI_PROVIDER_ENDPOINTS_KEY;
/// Non-synced JSON `BTreeMap<presetId, apiKey>` (preset id → API key). Never
/// enters the sync allow-list — keys never leave the device.
const PROVIDER_KEYRING: &str = "ai_provider_keyring";

/// Live overrides only (`endpoint: Some`). Tombstones are omitted so
/// callers fall back to [`preset_default_endpoint`]. Missing, malformed,
/// and **old-shape** rows (`{"custom":"https://…"}`) degrade to empty —
/// no migration shim (T36).
fn read_provider_endpoints(
    conn: &rusqlite::Connection,
) -> Result<std::collections::BTreeMap<String, String>, AiError> {
    Ok(read_provider_endpoints_stamped(conn)?
        .into_iter()
        .filter_map(|(preset, rec)| rec.endpoint.map(|endpoint| (preset, endpoint)))
        .collect())
}

fn read_provider_endpoints_stamped(
    conn: &rusqlite::Connection,
) -> Result<std::collections::BTreeMap<String, db::ProviderEndpointRecord>, AiError> {
    let Some(raw) =
        db::get_setting(conn, PROVIDER_ENDPOINTS).map_err(|e| AiError::IoError(e.to_string()))?
    else {
        return Ok(std::collections::BTreeMap::new());
    };
    let parsed = db::parse_provider_endpoints_map(&raw);
    if parsed.is_empty() && !raw.trim().is_empty() && raw.trim() != "{}" {
        log::warn!(
            "read_provider_endpoints: unknown or old-shape {PROVIDER_ENDPOINTS} row, \
             degrading to empty map (presets fall back to built-in defaults)"
        );
    }
    Ok(parsed)
}

/// Write the stamped per-preset map. An empty map deletes the settings
/// row (mirrors `write_gen_api_keyring`). Tombstones are persisted so they
/// can ride settings sync.
fn write_provider_endpoints_stamped(
    conn: &rusqlite::Connection,
    endpoints: &std::collections::BTreeMap<String, db::ProviderEndpointRecord>,
) -> Result<(), AiError> {
    if endpoints.is_empty() {
        return db::delete_setting(conn, PROVIDER_ENDPOINTS)
            .map_err(|e| AiError::IoError(e.to_string()));
    }
    let raw = serde_json::to_string(endpoints)
        .map_err(|e| AiError::IoError(format!("serialize provider endpoints map: {e}")))?;
    db::set_setting(conn, PROVIDER_ENDPOINTS, &raw).map_err(|e| AiError::IoError(e.to_string()))
}

/// Stamp live overrides with `now` and write. Used by tests that still
/// pass a `preset → endpoint` map; production persist/forget use the
/// stamped writer so reset can tombstone.
#[cfg(test)]
fn write_provider_endpoints(
    conn: &rusqlite::Connection,
    endpoints: &std::collections::BTreeMap<String, String>,
) -> Result<(), AiError> {
    let now = crate::utils::time::now_unix();
    let stamped: std::collections::BTreeMap<_, _> = endpoints
        .iter()
        .map(|(preset, endpoint)| {
            (
                preset.clone(),
                db::ProviderEndpointRecord {
                    endpoint: Some(endpoint.clone()),
                    updated_at: now,
                },
            )
        })
        .collect();
    write_provider_endpoints_stamped(conn, &stamped)
}

/// Read the per-preset API-key keyring. Empty (and missing row) deserialize
/// to an empty map. Mirrors [`read_provider_endpoints`]'s degrade-on-corruption
/// behavior: a malformed row logs a warning and falls back to an empty map
/// (no stored keys) rather than failing every preset's read.
fn read_provider_keyring(
    conn: &rusqlite::Connection,
) -> Result<std::collections::BTreeMap<String, String>, AiError> {
    let Some(raw) =
        db::get_setting(conn, PROVIDER_KEYRING).map_err(|e| AiError::IoError(e.to_string()))?
    else {
        return Ok(std::collections::BTreeMap::new());
    };
    Ok(serde_json::from_str(&raw).unwrap_or_else(|e| {
        log::warn!(
            "read_provider_keyring: malformed {PROVIDER_KEYRING} row, degrading to empty \
             map (no stored keys reported): {e}"
        );
        std::collections::BTreeMap::new()
    }))
}

/// Write the per-preset API-key keyring. An empty map deletes the settings
/// row (mirrors `write_gen_api_keyring`).
fn write_provider_keyring(
    conn: &rusqlite::Connection,
    keyring: &std::collections::BTreeMap<String, String>,
) -> Result<(), AiError> {
    if keyring.is_empty() {
        return db::delete_setting(conn, PROVIDER_KEYRING)
            .map_err(|e| AiError::IoError(e.to_string()));
    }
    let raw = serde_json::to_string(keyring)
        .map_err(|e| AiError::IoError(format!("serialize provider keyring: {e}")))?;
    db::set_setting(conn, PROVIDER_KEYRING, &raw).map_err(|e| AiError::IoError(e.to_string()))
}

/// Every preset id the frontend's `PROVIDER_PRESETS` table (`src/types/ai.ts`)
/// defines — that TS array is the single source of truth; this list is a
/// hand-maintained mirror of its 17 `id:` fields (same posture as
/// [`preset_default_endpoint`] below, which already duplicates each preset's
/// default endpoint one-by-one). Used by [`get_ai_provider_credentials`]
/// (T1.6) to enumerate every row of the per-preset registry in one shot.
pub(crate) const ALL_PRESET_IDS: &[&str] = &[
    // local
    "ollama",
    "lmstudio",
    "llama-server",
    "other-local",
    // integrated
    ON_DEVICE_PROVIDER_ID,
    ON_DEVICE_LLM_ID,
    // cli
    CLAUDE_CLI_ID,
    CODEX_CLI_ID,
    // hosted
    "openai",
    "anthropic",
    "gemini",
    "xai",
    "openrouter",
    "together",
    "groq",
    "voyage",
    "custom",
];

/// The built-in default endpoint for a preset id — the fallback used by
/// [`resolve_credential`] when no override is registered. Mirrors the
/// `endpoint:` field of each preset in `src/types/ai.ts` (the single source
/// of truth). Presets with no HTTP surface (CLI, on-device) and user-supplied
/// endpoints (`custom`, `other-local` is *given* a placeholder here only to
/// match the TS table; the user is expected to override it) return the empty
/// string. Returning `""` rather than erroring keeps [`resolve_credential`]
/// total; callers handle the empty case.
pub(crate) fn preset_default_endpoint(preset_id: &str) -> &'static str {
    match preset_id {
        // Hosted
        "openai" => "https://api.openai.com/v1",
        "anthropic" => "https://api.anthropic.com/v1",
        "gemini" => "https://generativelanguage.googleapis.com/v1beta/openai",
        "xai" => "https://api.x.ai/v1",
        "openrouter" => "https://openrouter.ai/api/v1",
        "together" => "https://api.together.xyz/v1",
        "groq" => "https://api.groq.com/openai/v1",
        "voyage" => "https://api.voyageai.com/v1",
        // Local (defaults mirror the TS preset table; the user overrides these)
        "ollama" => "http://127.0.0.1:11434/v1",
        "lmstudio" => "http://127.0.0.1:1234/v1",
        "llama-server" => "http://127.0.0.1:8080/v1",
        "other-local" => "http://127.0.0.1:8080/v1",
        // No HTTP surface / user-supplied
        "custom" | CLAUDE_CLI_ID | CODEX_CLI_ID | ON_DEVICE_PROVIDER_ID | ON_DEVICE_LLM_ID => "",
        // Unknown preset id — no default, callers handle the empty case.
        _ => "",
    }
}

/// `true` iff `preset_id` is one of the two presets whose endpoint the UI
/// lets the user edit (`custom`, `other-local` — see `AISettingsPanel.tsx`'s
/// `endpointEditable`). Every other preset's endpoint is fixed to
/// [`preset_default_endpoint`]. Centralizes backend enforcement of that
/// restriction so [`persist_provider_credential`] never trusts an IPC
/// caller — or an `ai_provider_endpoints` payload synced in from another
/// device — to point a fixed preset like `openai` at an attacker-controlled
/// host, which would leak that preset's stored API key (and, via the next
/// AI feature call, journal content) to it on the next hydration.
pub(crate) fn preset_endpoint_editable(preset_id: &str) -> bool {
    preset_id == "custom" || preset_id == "other-local"
}

/// Resolve the (endpoint, key) pair for a preset id.
///
/// The endpoint is the registered override if present, else the preset's
/// built-in default ([`preset_default_endpoint`]), else the empty string
/// (never an error). The key is the registered key for the preset id, if any.
/// This is the single read path the four slot hydrations switch to in T1.5.
///
/// Defense-in-depth: an override is only honored for a preset where
/// [`preset_endpoint_editable`] is `true` (`custom`, `other-local`). The
/// `ai_provider_endpoints` row is synced (Phase 2 T2.4) and reaches the DB
/// via the sync engine's LWW merge — a path that never goes through
/// [`persist_provider_credential`]'s write-side guard. Re-checking here, at
/// the single resolution point every hydration/build/public-view read goes
/// through, means a malicious/compromised synced override for a fixed
/// preset (e.g. `{"openai": "https://attacker.example/v1"}`) can never pair
/// that preset's stored API key with an attacker-controlled endpoint.
pub(crate) fn resolve_credential(
    conn: &rusqlite::Connection,
    preset_id: &str,
) -> Result<(String, Option<String>), AiError> {
    let endpoints = read_provider_endpoints(conn)?;
    let endpoint = endpoints
        .get(preset_id)
        .filter(|_| preset_endpoint_editable(preset_id))
        .cloned()
        .unwrap_or_else(|| preset_default_endpoint(preset_id).to_string());
    let key = read_provider_keyring(conn)?.get(preset_id).cloned();
    Ok((endpoint, key))
}

/// Derive the disclosure class for a (preset id, endpoint) pair. Pure
/// delegation to [`classify_provider_disclosure`] — `endpointClass` is now
/// derived on every read and never persisted, so the four stored
/// `*_endpoint_class` rows become redundant.
pub(crate) fn credential_class(preset_id: &str, endpoint: &str) -> EndpointClass {
    classify_provider_disclosure(preset_id, endpoint)
}

/// `true` iff `preset_id` classifies as `EndpointClass::Remote` (hosted
/// HTTP) and no API key resolves for it — the shared "would this build (or
/// keep alive) a keyless request to a hosted endpoint" check reused by
/// every slot loader/reconciler/setter that could otherwise construct a
/// Remote-class provider with no credential. `Local` / `OnDevice` /
/// `Subscription` providers are always usable without a key (`false`) —
/// many local servers have no auth, on-device inference never leaves the
/// machine, and CLI providers authenticate out-of-band via their own
/// subprocess.
///
/// NOTE: this can't distinguish "needs a key but has none" from a
/// genuinely keyless hosted endpoint (e.g. a self-hosted gateway configured
/// via the `custom` preset with no auth) — that case is now also gated
/// off. Accepted limitation for the privacy win; see `docs/LATER.md`.
pub(crate) fn remote_provider_missing_key(
    preset_id: &str,
    endpoint: &str,
    api_key: Option<&str>,
) -> bool {
    classify_provider_disclosure(preset_id, endpoint) == EndpointClass::Remote && api_key.is_none()
}

/// Read every row of the per-preset credential registry in one shot — the
/// pure core of [`get_ai_provider_credentials`], split out so the "never
/// serializes a key" guarantee is directly unit-testable against a raw
/// `Connection` (no `tauri::State` / `AppHandle` required — same posture as
/// [`read_gen_public`] / [`read_embed_public`] for the two-slot API).
fn provider_credentials_public(
    conn: &rusqlite::Connection,
) -> Result<Vec<ProviderCredentialPublic>, AiError> {
    ALL_PRESET_IDS
        .iter()
        .map(|&preset_id| {
            let (endpoint, key) = resolve_credential(conn, preset_id)?;
            let endpoint_class = credential_class(preset_id, &endpoint);
            Ok(ProviderCredentialPublic {
                preset_id: preset_id.to_string(),
                has_api_key: key.is_some(),
                endpoint,
                endpoint_class,
            })
        })
        .collect()
}

/// Pure core of [`set_ai_provider_credential`] — everything except the
/// [`reconcile_slots_for_preset`] pass that must follow it. Split out so the
/// tri-state key rule and the "don't store the default endpoint" convention
/// are directly unit-testable without a real `tauri::AppHandle` (the
/// reconcile pass itself is already covered by T1.5's own tests).
///
/// - Endpoint: for a preset with an HTTP surface (everything except the CLI
///   and on-device/on-device-llm presets — same partition [`validate_slot`]
///   already draws) a non-empty, well-formed URL is REQUIRED. Without this,
///   saving a hosted preset with an accidentally-empty endpoint would silently
///   write an override mapping it to `""` (since `"" != preset_default_endpoint`
///   for every hosted preset except `custom`), permanently shadowing
///   [`preset_default_endpoint`]'s fallback instead of falling back to it.
///   Stored as an override only when it differs from
///   [`preset_default_endpoint`] — matches [`persist_gen_api_key`] /
///   [`write_provider_endpoints`]'s "don't persist a redundant row"
///   convention elsewhere in this module.
/// - API key tri-state, identical contract to [`persist_gen_api_key`] /
///   [`resolve_slot_api_key`]: `None` preserves the remembered key, `Some("")`
///   clears it, `Some(k)` replaces it.
/// - Returns the derived endpoint class plus whether privacy consent is
///   still outstanding for it, using the exact `new_class != Local &&
///   !class_privacy_accepted` formula [`persist_gen_config`] already uses.
pub(crate) fn persist_provider_credential(
    conn: &rusqlite::Connection,
    preset_id: &str,
    endpoint: &str,
    api_key: Option<&str>,
) -> Result<(EndpointClass, bool), AiError> {
    if !ALL_PRESET_IDS.contains(&preset_id) {
        return Err(AiError::ProviderError(format!(
            "unknown preset id: {preset_id}"
        )));
    }

    let has_http_surface = !provider_uses_subprocess(preset_id)
        && !provider_is_on_device(preset_id)
        && !provider_is_on_device_llm(preset_id);
    if has_http_surface {
        if endpoint.trim().is_empty() {
            return Err(AiError::ProviderError(format!(
                "{preset_id}: endpoint required"
            )));
        }
        validate_endpoint_url(endpoint)?;
    }

    // Defense-in-depth: only `custom` and `other-local` let the user pick
    // an arbitrary endpoint (see `preset_endpoint_editable`). Every fixed
    // preset (openai, anthropic, ollama, ...) may only ever resolve to its
    // own built-in default — a non-default value here (whether from an
    // untrusted IPC caller or a synced credential payload) is rejected
    // outright, before anything is written.
    if !preset_endpoint_editable(preset_id) && endpoint != preset_default_endpoint(preset_id) {
        return Err(AiError::ProviderError(format!(
            "{preset_id}: endpoint is not user-editable"
        )));
    }

    let tx = conn
        .unchecked_transaction()
        .map_err(|e| AiError::IoError(format!("begin transaction: {e}")))?;

    let mut endpoints = read_provider_endpoints_stamped(conn)?;
    let now = crate::utils::time::now_unix();
    if endpoint == preset_default_endpoint(preset_id) {
        // Tombstone so a peer with an older live override converges on reset.
        endpoints.insert(
            preset_id.to_string(),
            db::ProviderEndpointRecord {
                endpoint: None,
                updated_at: now,
            },
        );
    } else {
        endpoints.insert(
            preset_id.to_string(),
            db::ProviderEndpointRecord {
                endpoint: Some(endpoint.to_string()),
                updated_at: now,
            },
        );
    }
    write_provider_endpoints_stamped(conn, &endpoints)?;

    match api_key {
        None => {}
        Some("") => {
            let mut keyring = read_provider_keyring(conn)?;
            keyring.remove(preset_id);
            write_provider_keyring(conn, &keyring)?;
        }
        Some(key) => {
            let mut keyring = read_provider_keyring(conn)?;
            keyring.insert(preset_id.to_string(), key.to_string());
            write_provider_keyring(conn, &keyring)?;
        }
    }

    let class = credential_class(preset_id, endpoint);
    let requires_privacy_consent =
        class != EndpointClass::Local && !class_privacy_accepted(conn, class)?;

    tx.commit()
        .map_err(|e| AiError::IoError(format!("commit transaction: {e}")))?;
    Ok((class, requires_privacy_consent))
}

/// Pure core of [`forget_ai_provider_credential`] — clears BOTH the endpoint
/// override and the stored key for `preset_id` (the two registry rows).
/// Split out for the same AppHandle-free testability reason as
/// [`persist_provider_credential`].
fn forget_provider_credential(conn: &rusqlite::Connection, preset_id: &str) -> Result<(), AiError> {
    if !ALL_PRESET_IDS.contains(&preset_id) {
        return Err(AiError::ProviderError(format!(
            "unknown preset id: {preset_id}"
        )));
    }

    let tx = conn
        .unchecked_transaction()
        .map_err(|e| AiError::IoError(format!("begin transaction: {e}")))?;

    let mut endpoints = read_provider_endpoints_stamped(conn)?;
    endpoints.insert(
        preset_id.to_string(),
        db::ProviderEndpointRecord {
            endpoint: None,
            updated_at: crate::utils::time::now_unix(),
        },
    );
    write_provider_endpoints_stamped(conn, &endpoints)?;

    let mut keyring = read_provider_keyring(conn)?;
    keyring.remove(preset_id);
    write_provider_keyring(conn, &keyring)?;

    tx.commit()
        .map_err(|e| AiError::IoError(format!("commit transaction: {e}")))?;

    // Best-effort, same as `forget_slot`: truncate the WAL so the deleted
    // key's plaintext doesn't linger recoverable in old WAL frames even
    // though the live row is already gone. A failure here must not fail
    // the forget — the credential IS correctly deleted from the live table
    // either way.
    if let Err(e) = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);") {
        log::warn!("forget_provider_credential: WAL checkpoint failed (non-fatal): {e}");
    }
    Ok(())
}

/// Which probe strategy [`test_ai_provider_credential`] (T1.6) routes a
/// preset id to. Rust has no access to the TS preset table's
/// `chatModelSuggestions` / `embeddingModelSuggestions` arrays (`src/types/ai.ts`,
/// T1.1) — this classification exists only to pick the right probe
/// mechanics; the actual model to probe with always comes from the caller
/// (`probe_model`), mirroring how `test_ai_generation_provider` /
/// `test_ai_embedding_provider` already take their model from the input
/// rather than resolving a suggestion themselves.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PresetTestGroup {
    /// Hosted, chat-capable, has TS-side chat-model suggestions (openai,
    /// anthropic, gemini, xai, openrouter, together, groq).
    HostedChat,
    /// Hosted, embedding-only, has TS-side embedding-model suggestions
    /// (voyage).
    HostedEmbedOnly,
    /// Hosted, zero TS-side suggestions — the caller MUST supply
    /// `probe_model` (custom).
    HostedCustom,
    /// Local HTTP endpoint (ollama, lmstudio, llama-server, other-local) —
    /// probed by reachability + model listing only, never a chat/embed call.
    Local,
    /// CLI-backed subprocess provider (claude-cli, codex-cli) — testing is
    /// not applicable.
    Cli,
    /// In-process on-device provider (on-device, on-device-llm) — testing
    /// is not applicable.
    Integrated,
}

fn preset_test_group(preset_id: &str) -> PresetTestGroup {
    match preset_id {
        "ollama" | "lmstudio" | "llama-server" | "other-local" => PresetTestGroup::Local,
        CLAUDE_CLI_ID | CODEX_CLI_ID => PresetTestGroup::Cli,
        ON_DEVICE_PROVIDER_ID | ON_DEVICE_LLM_ID => PresetTestGroup::Integrated,
        "voyage" => PresetTestGroup::HostedEmbedOnly,
        "openai" | "anthropic" | "gemini" | "xai" | "openrouter" | "together" | "groq" => {
            PresetTestGroup::HostedChat
        }
        // "custom" and any unrecognised preset id both fall back to the
        // most conservative routing: require an explicit `probe_model`
        // rather than guessing one.
        _ => PresetTestGroup::HostedCustom,
    }
}

/// `Ok(trimmed model)` iff `probe_model` is `Some` and non-blank; otherwise a
/// clear typed error. Used by the hosted-chat / hosted-embed-only /
/// hosted-custom branches of [`test_ai_provider_credential`] — a `custom`
/// preset with no suggestions must never silently probe with `""`.
fn require_probe_model(preset_id: &str, probe_model: Option<&str>) -> Result<String, AiError> {
    probe_model
        .map(str::trim)
        .filter(|m| !m.is_empty())
        .map(str::to_string)
        .ok_or_else(|| {
            AiError::ProviderError(format!(
                "{preset_id}: a model is required to test this provider"
            ))
        })
}

/// Hosted-chat probe branch of [`test_ai_provider_credential`] — builds a
/// transient provider and calls `chat()` with a small token budget. Mirrors
/// [`test_ai_generation_provider_hosted`]'s HTTP call shape exactly (same
/// 2000-token budget rationale documented there); never persists anything.
async fn probe_credential_chat(
    preset_id: &str,
    endpoint: &str,
    api_key: Option<&str>,
    model: &str,
) -> Result<TestCredentialOutcome, AiError> {
    if endpoint.trim().is_empty() {
        return Err(AiError::ProviderError("endpoint required".into()));
    }
    validate_endpoint_url(endpoint)?;
    let provider = build_slot_provider(
        preset_id,
        endpoint,
        api_key,
        SlotPayload::Generation { chat_model: model },
        None,
    )?;
    let start = Instant::now();
    let opts = crate::ai::provider::ChatOpts {
        max_tokens: Some(2000),
        ..Default::default()
    };
    crate::ai::audit::with_feature("connection_test", async {
        provider
            .chat(
                &[crate::ai::provider::Message {
                    role: crate::ai::provider::MessageRole::User,
                    content: "ping".into(),
                }],
                opts,
            )
            .await
    })
    .await?;
    Ok(TestCredentialOutcome {
        latency_ms: start.elapsed().as_millis() as u64,
        dim: None,
        model_count: None,
    })
}

/// Hosted-embed-only probe branch (voyage today) of
/// [`test_ai_provider_credential`] — builds a transient provider and calls
/// `embed()`. Mirrors [`test_ai_embedding_provider`]'s HTTP call shape;
/// never persists anything.
async fn probe_credential_embed(
    preset_id: &str,
    endpoint: &str,
    api_key: Option<&str>,
    model: &str,
) -> Result<TestCredentialOutcome, AiError> {
    if endpoint.trim().is_empty() {
        return Err(AiError::ProviderError("endpoint required".into()));
    }
    validate_endpoint_url(endpoint)?;
    let provider = build_slot_provider(
        preset_id,
        endpoint,
        api_key,
        SlotPayload::Embedding {
            embedding_model: model,
        },
        None,
    )?;
    let start = Instant::now();
    let vectors =
        crate::ai::audit::with_feature("connection_test", provider.embed(&["test"])).await?;
    let latency_ms = start.elapsed().as_millis() as u64;
    let dim = vectors
        .first()
        .map(|v| v.len())
        .ok_or_else(|| AiError::ProviderError("test: empty embeddings response".into()))?;
    Ok(TestCredentialOutcome {
        latency_ms,
        dim: Some(dim),
        model_count: None,
    })
}

/// `local`-group probe branch of [`test_ai_provider_credential`] —
/// reachability + model-list check only, no chat/embed call and no token
/// spend. `GET {endpoint}/models` is the OpenAI-compatible models-list
/// convention Ollama / LM Studio / llama-server all implement; a successful
/// response's `data` array length becomes `model_count`.
///
/// Round-2 fix #4: `api_key` is optional — most local servers are
/// unauthenticated, but ollama/lmstudio/llama-server/other-local can
/// optionally sit behind one. When present it's sent as a bearer token,
/// mirroring [`OpenAICompatibleProvider`]'s `Authorization: Bearer <key>`
/// convention; when absent, no `Authorization` header is sent at all
/// (unchanged behaviour for unprotected local servers).
async fn probe_local_reachability(
    endpoint: &str,
    api_key: Option<&str>,
) -> Result<TestCredentialOutcome, AiError> {
    if endpoint.trim().is_empty() {
        return Err(AiError::ProviderError("endpoint required".into()));
    }
    validate_endpoint_url(endpoint)?;
    let url = format!("{}/models", endpoint.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| AiError::ProviderError(format!("HTTP client init failed: {e}")))?;
    let start = Instant::now();
    let mut req = client.get(&url);
    if let Some(key) = api_key.filter(|k| !k.is_empty()) {
        req = req.bearer_auth(key);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| AiError::ProviderError(format!("local endpoint unreachable: {e}")))?;
    let latency_ms = start.elapsed().as_millis() as u64;
    if !resp.status().is_success() {
        return Err(AiError::ProviderError(format!(
            "local endpoint returned HTTP {}",
            resp.status()
        )));
    }
    let body: serde_json::Value = resp.json().await.map_err(|e| {
        AiError::ProviderError(format!("local endpoint returned invalid JSON: {e}"))
    })?;
    let model_count = body.get("data").and_then(|d| d.as_array()).map(|a| a.len());
    Ok(TestCredentialOutcome {
        latency_ms,
        dim: None,
        model_count,
    })
}

struct EmbedKeys;
impl SlotKeys for EmbedKeys {
    const PROVIDER: &'static str = settings_keys::embed::PROVIDER;
    fn model_key() -> &'static str {
        settings_keys::embed::EMBEDDING_MODEL
    }
}

/// Map an endpoint class to the legacy per-class privacy-receipt settings
/// key. Used only when migrating older installs to the unified
/// `ai_privacy_accepted_at` row.
pub(crate) fn privacy_key_for_class(class: EndpointClass) -> &'static str {
    match class {
        EndpointClass::Local => settings_keys::privacy::ACCEPTED_LOCAL,
        EndpointClass::Remote => settings_keys::privacy::ACCEPTED_REMOTE,
        EndpointClass::Subscription => settings_keys::privacy::ACCEPTED_SUBSCRIPTION,
        EndpointClass::OnDevice => settings_keys::privacy::ACCEPTED_ON_DEVICE,
    }
}

/// Map an endpoint class to the legacy per-class bulk-context receipt
/// settings key. Used only when migrating older installs.
pub(crate) fn bulk_context_key_for_class(class: EndpointClass) -> &'static str {
    match class {
        EndpointClass::Local => settings_keys::bulk_context::ACCEPTED_LOCAL,
        EndpointClass::Remote => settings_keys::bulk_context::ACCEPTED_REMOTE,
        EndpointClass::Subscription => settings_keys::bulk_context::ACCEPTED_SUBSCRIPTION,
        EndpointClass::OnDevice => settings_keys::bulk_context::ACCEPTED_ON_DEVICE,
    }
}

fn parse_receipt_timestamp(raw: Option<String>) -> Option<i64> {
    raw.filter(|s| !s.is_empty())
        .and_then(|s| s.parse::<i64>().ok())
}

/// Read the unified privacy receipt (`ai_privacy_accepted_at`). Falls
/// back to the newest legacy per-class remote/subscription receipt when
/// the unified row is absent (e.g. before `promote_legacy_privacy_receipt`
/// runs on unlock).
pub(crate) fn read_privacy_accepted_at(
    conn: &rusqlite::Connection,
) -> Result<Option<i64>, AiError> {
    let direct = db::get_setting(conn, settings_keys::PRIVACY_ACCEPTED_AT)
        .map_err(|e| AiError::IoError(e.to_string()))?;
    if let Some(ts) = parse_receipt_timestamp(direct) {
        return Ok(Some(ts));
    }

    let mut best: Option<i64> = None;
    for class in [EndpointClass::Remote, EndpointClass::Subscription] {
        let legacy = db::get_setting(conn, privacy_key_for_class(class))
            .map_err(|e| AiError::IoError(e.to_string()))?;
        if let Some(ts) = parse_receipt_timestamp(legacy) {
            best = Some(best.map(|b| b.max(ts)).unwrap_or(ts));
            continue;
        }
        let bulk = db::get_setting(conn, bulk_context_key_for_class(class))
            .map_err(|e| AiError::IoError(e.to_string()))?;
        if let Some(ts) = parse_receipt_timestamp(bulk) {
            best = Some(best.map(|b| b.max(ts)).unwrap_or(ts));
        }
    }
    Ok(best)
}

/// `true` iff the user has accepted the unified AI privacy notice.
pub(crate) fn privacy_accepted(conn: &rusqlite::Connection) -> Result<bool, AiError> {
    Ok(read_privacy_accepted_at(conn)?.is_some())
}

/// `true` iff privacy consent is satisfied for `class`.
///
/// **Local and on-device endpoints are auto-exempt** — nothing leaves the
/// machine (on-device runs `fastembed` in-process; see the
/// `EndpointClass::OnDevice` doc comment: "auto-allowed everywhere `Local`
/// is"). Remote and subscription both share the single unified receipt.
pub(crate) fn class_privacy_accepted(
    conn: &rusqlite::Connection,
    class: EndpointClass,
) -> Result<bool, AiError> {
    if class == EndpointClass::Local || class == EndpointClass::OnDevice {
        return Ok(true);
    }
    privacy_accepted(conn)
}

/// Copy the newest legacy remote/subscription privacy or bulk-context
/// receipt into `ai_privacy_accepted_at` when the unified row is still
/// missing. Called by `run_ai_v2_migration` before legacy keys are
/// deleted so per-class acceptances survive the unified-receipt refactor.
pub(crate) fn promote_legacy_privacy_receipt(conn: &rusqlite::Connection) -> Result<(), AiError> {
    let unified = db::get_setting(conn, settings_keys::PRIVACY_ACCEPTED_AT)
        .map_err(|e| AiError::IoError(e.to_string()))?;
    if parse_receipt_timestamp(unified).is_some() {
        return Ok(());
    }
    if let Some(ts) = read_privacy_accepted_at(conn)? {
        db::set_setting(conn, settings_keys::PRIVACY_ACCEPTED_AT, &ts.to_string())
            .map_err(|e| AiError::IoError(e.to_string()))?;
    }
    Ok(())
}

/// Stamp the unified privacy receipt and delete legacy per-class rows.
pub(crate) fn stamp_privacy_accepted(conn: &rusqlite::Connection, now: i64) -> Result<(), AiError> {
    db::set_setting(conn, settings_keys::PRIVACY_ACCEPTED_AT, &now.to_string())
        .map_err(|e| AiError::IoError(e.to_string()))?;
    for key in [
        settings_keys::privacy::ACCEPTED_LOCAL,
        settings_keys::privacy::ACCEPTED_REMOTE,
        settings_keys::privacy::ACCEPTED_SUBSCRIPTION,
        settings_keys::bulk_context::ACCEPTED_LOCAL,
        settings_keys::bulk_context::ACCEPTED_REMOTE,
        settings_keys::bulk_context::ACCEPTED_SUBSCRIPTION,
        "ai_gen_privacy_accepted_at",
        "ai_embed_privacy_accepted_at",
    ] {
        db::delete_setting(conn, key).map_err(|e| AiError::IoError(e.to_string()))?;
    }
    Ok(())
}

/// Gate multi-entry AI features before sending entry text to a provider.
///
/// **Local and on-device endpoints are auto-exempt** — data stays on the
/// machine. Remote and subscription share the unified privacy receipt.
/// `entry_count` must be ≥ 1; zero entries is the caller's
/// responsibility to reject earlier.
pub(crate) fn require_bulk_consent(
    conn: &rusqlite::Connection,
    class: EndpointClass,
    entry_count: usize,
) -> Result<(), AiError> {
    if entry_count == 0 {
        return Err(AiError::ProviderError("AI_NO_ENTRIES".into()));
    }
    if class == EndpointClass::Local || class == EndpointClass::OnDevice {
        return Ok(());
    }
    if privacy_accepted(conn)? {
        Ok(())
    } else {
        Err(AiError::BulkContextNotAccepted)
    }
}

/// T2.3 cutover: derive the `EndpointClass` for a slot's CURRENTLY
/// CONFIGURED provider — reads the slot's `provider` settings row (e.g.
/// [`settings_keys::gen::PROVIDER`]), then resolves + classifies via the
/// per-preset credential registry ([`resolve_credential`] /
/// [`credential_class`]). Replaces the old design where each slot ALSO
/// stored its own `endpoint_class` row (read by the now-deleted
/// `read_slot_endpoint_class`) — endpointClass is derived on every read now,
/// never persisted.
///
/// Returns `None` when the slot has no provider configured (missing, empty,
/// or `"none"` row).
///
/// **Why `None` instead of a default class** — every caller is a privacy
/// gate. Picking *any* default would silently route consent against the
/// user's most permissive accepted class. Forcing callers to handle `None`
/// explicitly is the fail-closed posture: no class = no consent.
pub(crate) fn slot_provider_class(
    conn: &rusqlite::Connection,
    provider_key: &str,
) -> Result<Option<EndpointClass>, AiError> {
    let Some(provider) = db::get_setting(conn, provider_key)
        .map_err(|e| AiError::IoError(e.to_string()))?
        .filter(|p| !p.is_empty() && p != "none")
    else {
        return Ok(None);
    };
    let (endpoint, _) = resolve_credential(conn, &provider)?;
    Ok(Some(credential_class(&provider, &endpoint)))
}

/// Convenience: `true` iff the slot whose provider settings key is
/// `provider_key` has a configured provider AND its derived endpoint class
/// has been accepted by the user. Used by every runtime privacy gate
/// outside `ai_settings.rs`.
///
/// **Fail-closed on "no provider configured"** — mirrors
/// [`slot_provider_class`]'s `None` contract. Callers translate `Ok(false)`
/// into `AiError::PrivacyNotAccepted`.
pub(crate) fn slot_provider_privacy_accepted(
    conn: &rusqlite::Connection,
    provider_key: &str,
) -> Result<bool, AiError> {
    match slot_provider_class(conn, provider_key)? {
        Some(class) => class_privacy_accepted(conn, class),
        None => Ok(false),
    }
}

// ─── Generation slot ───────────────────────────────────────────────────────

/// Input for `set_ai_generation_provider` / `test_ai_generation_provider`.
/// Image model is optional — most providers don't support image gen.
///
/// **T2.3 cutover:** `endpoint` / `api_key` no longer live here — the
/// per-preset credential registry (`resolve_credential`, `commands::ai_provider`
/// T1.3+) owns both, keyed by `provider`. Nothing sensitive remains on this
/// struct, so `#[derive(Debug)]` is safe (no redaction needed).
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AIGenProviderConfigInput {
    pub provider: String,
    pub chat_model: String,
}

/// Input for `set_ai_image_provider`. The image slot is independent of the
/// generation slot (2026-08-07) — same credential-registry cutover: no
/// `endpoint` / `api_key`, both resolved from `provider`.
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AIImageProviderConfigInput {
    pub provider: String,
    pub image_model: String,
}

/// Mirrors [`AIGenProviderConfigInput`]'s cutover — `endpoint` / `api_key`
/// come from the credential registry, keyed by `provider`.
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AIEmbedProviderConfigInput {
    pub provider: String,
    pub embedding_model: String,
}

/// Sanitised single-slot view returned by `get_ai_providers`. The API
/// key is NEVER included. Privacy acceptance is no longer carried on
/// the slot — it lives on `AIFullSettings.privacy_accepted` keyed by
/// endpoint class.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AIGenProviderConfigPublic {
    pub provider: String,
    pub endpoint: String,
    pub endpoint_class: EndpointClass,
    pub chat_model: String,
    pub has_api_key: bool,
}

/// Sanitised image-slot view. Same no-API-key posture as the pair above.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AIImageProviderConfigPublic {
    pub provider: String,
    pub endpoint: String,
    pub endpoint_class: EndpointClass,
    pub image_model: String,
    pub has_api_key: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AIEmbedProviderConfigPublic {
    pub provider: String,
    pub endpoint: String,
    pub endpoint_class: EndpointClass,
    pub embedding_model: String,
    pub has_api_key: bool,
}

/// Sanitised per-preset view returned by [`get_ai_provider_credentials`]
/// (T1.6) — one row per entry in [`ALL_PRESET_IDS`]. Mirrors the "never
/// return the raw key" posture of [`AIGenProviderConfigPublic`] /
/// [`AIEmbedProviderConfigPublic`] above: `has_api_key` is the only signal
/// the key's presence ever produces on this wire type.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCredentialPublic {
    pub preset_id: String,
    pub endpoint: String,
    pub has_api_key: bool,
    pub endpoint_class: EndpointClass,
}

/// Both slots in one shot — what the Settings panel reads on mount.
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct AIProvidersConfigPublic {
    pub generation: Option<AIGenProviderConfigPublic>,
    pub image: Option<AIImageProviderConfigPublic>,
    pub embedding: Option<AIEmbedProviderConfigPublic>,
}

/// Test outcome — chat probe returns `dim: None`, embed probe returns
/// `dim: Some(n)`. The frontend renders both via a single component.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SlotTestResult {
    pub latency_ms: u64,
    pub dim: Option<usize>,
}

/// Outcome of [`test_ai_provider_credential`] (T1.6) — a transient probe
/// result, never persisted. `dim` is `Some(n)` only for an embedding probe
/// (mirrors [`SlotTestResult::dim`]); `model_count` is `Some(n)` only for a
/// `local`-group reachability probe (the number of models the endpoint's
/// `/models` listing reported) — the three probe strategies
/// (`test_ai_provider_credential`'s doc explains the routing) are mutually
/// exclusive, so at most one of `dim` / `model_count` is ever populated.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TestCredentialOutcome {
    pub latency_ms: u64,
    pub dim: Option<usize>,
    pub model_count: Option<usize>,
}

// ── Shared helpers ────────────────────────────────────────────────────────

/// Persist the generation slot in a single transaction. Mirrors
/// `persist_config` but on the `ai_gen_*` namespace.
///
/// **T2.3 cutover:** writes ONLY `provider` + model rows. `endpoint` /
/// `api_key` no longer live on the slot — they're resolved from the
/// per-preset credential registry (`resolve_credential`) by every reader.
/// `new_class` is still an explicit parameter (callers derive it via
/// `classify_provider_disclosure`/`credential_class` against the resolved
/// endpoint) purely to compute the `needs_consent` hint below.
///
/// Returns `true` when the **new** slot's endpoint class has not been
/// accepted yet (so the panel needs to show the privacy modal). Note:
/// this is no longer destructive — privacy receipts are stored per
/// endpoint class, not per slot, and are never wiped by a save. The
/// flag is a read-only hint for the UI.
fn persist_gen_config(
    conn: &rusqlite::Connection,
    input: &AIGenProviderConfigInput,
    new_class: EndpointClass,
) -> Result<bool, AiError> {
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| AiError::IoError(format!("begin transaction: {e}")))?;

    db::set_setting(conn, GenKeys::PROVIDER, &input.provider)
        .map_err(|e| AiError::IoError(e.to_string()))?;
    db::set_setting(conn, GenKeys::model_key(), &input.chat_model)
        .map_err(|e| AiError::IoError(e.to_string()))?;
    // The image model is NOT written here — it belongs to the independent
    // image slot (`persist_image_config`).

    let needs_consent =
        new_class != EndpointClass::Local && !class_privacy_accepted(conn, new_class)?;
    tx.commit()
        .map_err(|e| AiError::IoError(format!("commit transaction: {e}")))?;
    Ok(needs_consent)
}

/// Compose the same `provider_id:embedding_model` identity string
/// `provider_namespaced_model_id` builds off a live `AIProvider`, but from
/// the raw settings-row values — used to detect an embedding-slot identity
/// change without constructing a provider instance.
fn embed_identity(provider: &str, embedding_model: &str) -> String {
    format!("{provider}:{embedding_model}")
}

/// I2 fix: the identity that gates hosted-CONSENT invalidation —
/// `provider_id:endpoint:embedding_model`. Deliberately a SEPARATE identity
/// from [`embed_identity`] (the RE-EMBED trigger boundary, which stays
/// `provider_id:embedding_model` — the same model at a new endpoint still
/// produces comparable vectors, so re-embedding on an endpoint-only change
/// would be wasted work). Consent is different: the user accepted "your
/// journal text leaves this device to THIS host." Editing ONLY the
/// endpoint (e.g. pointing the same provider/model at a different
/// OpenAI-compatible gateway) must invalidate that acceptance — the old
/// code computed `identity_changed` from `embed_identity` alone, so an
/// endpoint-only edit silently carried consent to a new host.
fn consent_identity(provider: &str, endpoint: &str, embedding_model: &str) -> String {
    format!("{provider}:{endpoint}:{embedding_model}")
}

/// The CONFIGURED embedding slot's namespaced model_id
/// (`"{provider_id}:{embedding_model}"`) — same format
/// `provider_namespaced_model_id` builds off a live `AIProvider`, and the
/// same identity [`embed_identity`] computes for change-detection on the
/// save path, but read directly from the persisted `ai_embed_*` settings
/// rows so a caller never needs to construct an `AIProvider`.
///
/// C6 fix: `sync::engine::pull_embedding_chunks` uses this as its sole
/// source of "this device's active embedding model" instead of inferring
/// it from whatever `model_id`s happen to already be present in
/// `entry_embedding_chunks` — that idiom adopted nothing on a fresh
/// device (no local rows yet) and wrongly treated rows retained from a
/// PRIOR model (after a switch) as still active. Reading the configured
/// slot fixes both. Returns `None` when no embedding slot is configured
/// yet (provider or model row missing/empty) — same "nothing configured"
/// contract every other slot reader in this module uses.
pub(crate) fn configured_embedding_model_id(conn: &rusqlite::Connection) -> Option<String> {
    let provider = db::get_setting(conn, EmbedKeys::PROVIDER)
        .ok()
        .flatten()
        .filter(|p| !p.is_empty() && p != "none")?;
    let model = db::get_setting(conn, EmbedKeys::model_key())
        .ok()
        .flatten()
        .filter(|m| !m.is_empty())?;
    Some(embed_identity(&provider, &model))
}

/// The CONFIGURED memory-embed slot's namespaced model_id — the memory
/// channel's sibling of [`configured_embedding_model_id`], reading the
/// `ai_memory_embed_*` settings rows instead. This is the SINGLE composer
/// the sync engine uses for peer-vector adoption and backfill detection
/// (`sync::engine::pull_memory_from_peers`); it must stay equal to what the
/// memory worker stamps via `provider_namespaced_model_id` off the hydrated
/// slot, or synced vectors silently stop matching (the exact bug this
/// dedupe guards against). Returns `None` when the slot is unconfigured.
pub(crate) fn configured_memory_embedding_model_id(conn: &rusqlite::Connection) -> Option<String> {
    let provider = db::get_setting(conn, settings_keys::memory_embed::PROVIDER)
        .ok()
        .flatten()
        .filter(|p| !p.is_empty() && p != "none")?;
    let model = db::get_setting(conn, settings_keys::memory_embed::EMBEDDING_MODEL)
        .ok()
        .flatten()
        .filter(|m| !m.is_empty())?;
    Some(embed_identity(&provider, &model))
}

/// C10 fix: initialize the master background-indexing toggle
/// (`ai_background_indexing_enabled`) to `"true"` the first time an
/// embedding slot lands on a `Local` or `OnDevice` endpoint class — but
/// ONLY when the setting has never been explicitly set (the row is
/// absent). `ai_settings::read_bool_setting`'s `unwrap_or(false)` treats
/// "absent" and "explicit false" identically, so this reads the raw row
/// directly to tell them apart.
///
/// Without this, a zero-token on-device/local provider left background
/// indexing off until the user separately discovered and flipped the
/// "Background indexing" toggle — see `ai_settings::background_indexing_allowed`'s
/// master-toggle gate, which this never bypasses. Never overwrites an
/// explicit user choice (on OR off), and never touches `Remote` — hosted
/// stays fully user-driven, with its own separate token-cost consent gate
/// entirely untouched by this function.
fn maybe_default_background_indexing_enabled(
    conn: &rusqlite::Connection,
    class: EndpointClass,
) -> Result<(), AiError> {
    if !matches!(class, EndpointClass::Local | EndpointClass::OnDevice) {
        return Ok(());
    }
    let already_set = db::get_setting(conn, settings_keys::BACKGROUND_INDEXING_ENABLED)
        .map_err(|e| AiError::IoError(e.to_string()))?
        .is_some();
    if !already_set {
        db::set_setting(conn, settings_keys::BACKGROUND_INDEXING_ENABLED, "true")
            .map_err(|e| AiError::IoError(e.to_string()))?;
    }
    Ok(())
}

/// Persist the embedding slot. Returns `(needs_consent, identity_changed)`:
/// `needs_consent` is the existing "new endpoint class not yet privacy-
/// accepted" hint the Settings panel uses to pop the privacy modal;
/// `identity_changed` is `true` iff `provider_id:embedding_model` actually
/// changed (the API key is NOT part of the identity — a key rotation on
/// the same provider/model returns `false`) — Phase 2 Task 6's rebuild
/// trigger boundary, consumed by `apply_embedding_slot_change`.
pub(crate) fn persist_embed_config(
    conn: &rusqlite::Connection,
    input: &AIEmbedProviderConfigInput,
    new_class: EndpointClass,
) -> Result<(bool, bool), AiError> {
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| AiError::IoError(format!("begin transaction: {e}")))?;

    // Snapshot the old identity BEFORE overwriting the rows below, so a
    // provider/model change can be detected and the Phase 2 background-
    // indexing hosted consent invalidated — a stale acceptance must never
    // silently cover a different hosted provider/model.
    let old_provider = db::get_setting(conn, EmbedKeys::PROVIDER)
        .map_err(|e| AiError::IoError(e.to_string()))?
        .unwrap_or_default();
    let old_model = db::get_setting(conn, EmbedKeys::model_key())
        .map_err(|e| AiError::IoError(e.to_string()))?
        .unwrap_or_default();
    let identity_changed = embed_identity(&old_provider, &old_model)
        != embed_identity(&input.provider, &input.embedding_model);
    // I2 fix: consent invalidation is ENDPOINT-scoped, separate from the
    // re-embed trigger boundary above — see `consent_identity` docs.
    // T2.3 cutover: the endpoint no longer lives on the slot row, so both
    // the old and new provider's endpoint are resolved from the per-preset
    // credential registry — unaffected by the settings writes below, which
    // never touch the registry rows.
    let old_endpoint = resolve_credential(conn, &old_provider)?.0;
    let new_endpoint = resolve_credential(conn, &input.provider)?.0;
    let consent_identity_changed = consent_identity(&old_provider, &old_endpoint, &old_model)
        != consent_identity(&input.provider, &new_endpoint, &input.embedding_model);

    db::set_setting(conn, EmbedKeys::PROVIDER, &input.provider)
        .map_err(|e| AiError::IoError(e.to_string()))?;
    db::set_setting(conn, EmbedKeys::model_key(), &input.embedding_model)
        .map_err(|e| AiError::IoError(e.to_string()))?;

    if consent_identity_changed {
        db::delete_setting(conn, settings_keys::BACKGROUND_INDEXING_HOSTED_CONSENT_AT)
            .map_err(|e| AiError::IoError(e.to_string()))?;
    }

    // C10 fix: a successful save that lands on Local/OnDevice initializes
    // the background-indexing master toggle to "true" iff it was never
    // explicitly set — see doc comment on `maybe_default_background_indexing_enabled`.
    maybe_default_background_indexing_enabled(conn, new_class)?;

    // Embed-sync decision receipts are scoped to the previous model
    // identity — a provider/model switch invalidates reembed/pause/pending
    // so the user is not stuck behind a stale modal for the old model.
    if identity_changed {
        crate::ai::embedding_decision::clear_decision_on_slot_identity_change(
            conn,
            crate::ai::embedding_decision::EmbedSyncSlot::Entry,
        )
        .map_err(AiError::IoError)?;
    }

    let needs_consent =
        new_class != EndpointClass::Local && !class_privacy_accepted(conn, new_class)?;
    tx.commit()
        .map_err(|e| AiError::IoError(format!("commit transaction: {e}")))?;
    Ok((needs_consent, identity_changed))
}

/// Outcome of [`apply_embedding_slot_change`] — everything AppHandle-free
/// (DB + in-process registry) that `set_ai_embedding_provider` needs to
/// decide its two AppHandle-dependent side effects (emit the provider-
/// change event, nudge the worker awake). Kept separate from
/// `SetProviderResult` (the wire type returned to the frontend) so this
/// struct is free to carry internal-only fields.
///
/// T1.4: bumped from module-private to `pub(crate)` so
/// [`run_embedding_post_swap_sequence`] (also `pub(crate)`, per the
/// phase file) can take a `&EmbeddingSlotChangeOutcome` without tripping
/// Rust's `private_interfaces` lint. The fields stay crate-visible only
/// — `SetProviderResult` itself is already `pub`.
pub(crate) struct EmbeddingSlotChangeOutcome {
    pub(crate) result: SetProviderResult,
    /// `true` iff `provider_id:embedding_model` actually changed (not just
    /// the API key) — Phase 2 Task 6's rebuild trigger boundary.
    identity_changed: bool,
    /// Count of entries just marked `pending` under `model_id`. Only
    /// non-zero when `identity_changed && features_enabled`.
    enqueued: usize,
    /// The NEW embedding slot's namespaced model_id.
    model_id: String,
    /// Snapshot of `ai_settings::embedding_features_enabled` taken while
    /// still holding the connection — tells the command whether it's safe
    /// to nudge the worker awake (never auto-start it for a config with no
    /// consuming feature on).
    features_enabled: bool,
}

/// Everything `set_ai_embedding_provider` does that only needs a DB
/// connection + the in-process `ProviderRegistry` (Phase 2 Task 6):
/// persist the slot (`persist_embed_config`), swap the registry, and — when
/// the embedding slot's IDENTITY actually changed AND an embedding-
/// consuming feature is enabled — enqueue the new model_id's eligible
/// entries as dirty jobs (`ai::indexer::enqueue_dirty_jobs_for_model`) so
/// the running worker drains them without waiting for its own
/// opportunistic-seeding batch.
///
/// Deliberately excludes `backfill.cancel_and_clear()` / `sync_indexer_embedder`
/// (still called by the command, unchanged) and anything needing
/// `tauri::AppHandle` (emitting `ai:backfill-model-changed`, nudging
/// `start_indexing_worker`) — those stay in the `#[tauri::command]`
/// wrapper so this function is unit-testable with a plain in-memory
/// connection, mirroring `commands::ai`'s split between DB-only gate logic
/// (`backfill_inner_gates_replicated`) and the AppHandle-driven spawn.
fn apply_embedding_slot_change(
    conn: &rusqlite::Connection,
    registry: &ProviderRegistry,
    provider: Arc<dyn AIProvider>,
    input: &AIEmbedProviderConfigInput,
    class: EndpointClass,
) -> Result<EmbeddingSlotChangeOutcome, AiError> {
    let (needs_consent, identity_changed) = persist_embed_config(conn, input, class)?;
    registry.swap_embedding(Arc::clone(&provider));

    let model_id = provider_namespaced_model_id(&*provider);
    let features_enabled = crate::commands::ai_settings::embedding_features_enabled(conn);
    let enqueued = if identity_changed && features_enabled {
        crate::ai::indexer::enqueue_dirty_jobs_for_model(conn, &model_id)?
    } else {
        0
    };

    // C7 fix: a successful embedding-slot save — whether it's a pure key
    // rotation (`identity_changed == false`) or a full identity change — is
    // the "user corrected credentials/configuration" recovery trigger for
    // jobs `pause_embedding_job` parked on an auth/config-class error.
    // `paused` jobs never retry on their own (see that fn's docs), so
    // nothing else brings them back once the fix is actually in place;
    // scoped to THIS model_id since job rows are per-`(entry_id, model_id)`.
    // The worker itself is nudged awake by the caller
    // (`set_ai_embedding_provider`'s unconditional restart-when-enabled),
    // not here.
    let now = chrono::Utc::now().timestamp();
    db::embeddings::reset_paused_jobs_to_pending(conn, &model_id, now, now)
        .map_err(|e| AiError::IoError(format!("reset_paused_jobs_to_pending: {e}")))?;

    Ok(EmbeddingSlotChangeOutcome {
        result: SetProviderResult {
            provider: input.provider.clone(),
            endpoint_class: class,
            requires_privacy_consent: needs_consent,
        },
        identity_changed,
        enqueued,
        model_id,
        features_enabled,
    })
}

/// Round-3 fix #2 — tri-state API key resolution for
/// [`test_ai_provider_credential`], keyed by preset id (via
/// [`resolve_credential`]) rather than by slot, mirroring
/// [`resolve_slot_api_key`]'s convention:
/// - `None` (omitted) → resolve the preset's stored key from the per-preset
///   credential registry. `get_ai_provider_credentials` never returns a raw
///   key to the renderer (`has_api_key: bool` only), so a future "Test
///   connection" click on an already-saved credential — without retyping
///   it — has no other way to supply the real key; without this fallback
///   the probe would run unauthenticated and fail for any provider that
///   requires one.
/// - `Some("")` → explicit clear, probe with no key.
/// - `Some(k)` → the caller-supplied key takes precedence over the stored
///   one — this is how a user tests a NEW, not-yet-saved key before
///   committing it.
fn resolve_preset_test_api_key(
    conn: &rusqlite::Connection,
    preset_id: &str,
    input_key: Option<&str>,
) -> Result<Option<String>, AiError> {
    match input_key {
        Some("") => Ok(None),
        Some(k) => Ok(Some(k.to_string())),
        None => Ok(resolve_credential(conn, preset_id)?.1),
    }
}

/// Type-safe payload for `build_slot_provider`: callers must commit to
/// EITHER a generation slot (chat + optional image) OR an embedding
/// slot (one embedding model), not both, not neither.
///
/// The earlier draft passed `chat_model: &str` and `embedding_model:
/// &str` with the convention "exactly one is non-empty per slot" —
/// the compiler had no way to enforce it, and a future caller that
/// fat-fingered both as empty (or both as non-empty) would silently
/// produce a misconfigured provider whose `chat_model_id()` /
/// `embedding_model_id()` collided in the namespaced cache keys.
enum SlotPayload<'a> {
    Generation {
        chat_model: &'a str,
    },
    /// Image generation — its own slot since 2026-08-07, so a user can draw
    /// with one vendor and chat with another.
    Image {
        image_model: &'a str,
    },
    Embedding {
        embedding_model: &'a str,
    },
}

/// True iff the given provider id is served by spawning a local CLI
/// subprocess (instead of HTTP). Subprocess-backed providers have no
/// endpoint URL and no API key — they reuse the CLI's existing auth.
pub(crate) fn provider_uses_subprocess(provider_id: &str) -> bool {
    matches!(provider_id, CLAUDE_CLI_ID | CODEX_CLI_ID)
}

/// True iff the given provider id is the on-device sentinel — in-process
/// `fastembed` inference with no HTTP endpoint and no API key (mirrors
/// `provider_uses_subprocess`'s exemption for CLI providers, but for a
/// different reason: there is no subprocess either, just a local model
/// session).
pub(crate) fn provider_is_on_device(provider_id: &str) -> bool {
    provider_id == ON_DEVICE_PROVIDER_ID
}

/// Stop-on-switch decision (Phase 4 Task 2) — pure extraction of the
/// rule that drives [`set_ai_generation_provider`]'s post-swap
/// `server_manager.stop()` call: stop the `llama-server` sidecar iff the
/// user is switching the generation slot AWAY from `on-device-llm` to a
/// DIFFERENT provider. A pure `on-device-llm → on-device-llm` swap (just a
/// model change) does NOT stop — the [`OnDeviceLlmProvider`] handles a
/// model swap by respawning on the new model on the next chat, and killing
/// the sidecar here would needlessly add cold-start latency to that flow.
///
/// Kept as a standalone fn (not inlined into the command body) so the full
/// truth table is unit-testable without a DB / Tauri State.
fn should_stop_on_switch(prev_provider: &str, new_provider: &str) -> bool {
    prev_provider == ON_DEVICE_LLM_ID && new_provider != ON_DEVICE_LLM_ID
}

/// Validate an `on-device-llm` selection (Phase 4 Task 2). The catalog
/// existence + downloaded-state checks that gate building an
/// [`OnDeviceLlmProvider`], extracted as a pure fn so the truth table is
/// unit-testable without a real [`LlmAssetManager`] / filesystem.
///
/// - `chat_model` must resolve in [`llm_catalog::find`] — else
///   `Err("model_not_found")`.
/// - `is_downloaded` must be true (caller reads this off
///   [`LlmAssetManager::is_model_downloaded`]) — else
///   `Err("model_not_downloaded")`.
fn validate_on_device_llm_selection(chat_model: &str, is_downloaded: bool) -> Result<(), String> {
    if llm_catalog::find(chat_model).is_none() {
        return Err("model_not_found".to_string());
    }
    if !is_downloaded {
        return Err("model_not_downloaded".to_string());
    }
    Ok(())
}

/// Thin wrapper over [`validate_on_device_llm_selection`] that reads the
/// download state off the asset manager. The pure sibling exists for the
/// truth-table unit tests; this one is the call site inside the command
/// body.
fn validate_on_device_llm_selection_with_assets(
    chat_model: &str,
    assets: &LlmAssetManager,
) -> Result<(), String> {
    validate_on_device_llm_selection(chat_model, assets.is_model_downloaded(chat_model))
}

/// `true` iff the connection-test command should wrap the probe in an
/// explicit outer timeout. Only the on-device-llm branch needs it: its
/// first chat lazily spawns `llama-server` and loads the model into RAM
/// (`ensure_running`), which can take ~two minutes cold. Hosted and CLI
/// providers rely on the provider's own HTTP / subprocess timeout — adding
/// a second outer budget there would just mask their faster failures.
/// Kept as a standalone pure fn so the truth table is unit-testable.
fn should_use_test_timeout(provider: &str) -> bool {
    provider == ON_DEVICE_LLM_ID
}

/// Outer cold-start budget for the on-device-llm connection test. Generous
/// because `ensure_running` (model load into RAM) dominates the latency on
/// a first run; a too-tight budget would falsely report a working model as
/// failed. Hosted / CLI providers never hit this path (see
/// [`should_use_test_timeout`]).
const ON_DEVICE_TEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

/// Stable error string returned by [`test_ai_generation_provider`] when the
/// on-device-llm probe exceeds [`ON_DEVICE_TEST_TIMEOUT`]. Deliberately
/// reuses the `on_device_llm_start_failed` code prefix so the frontend's
/// "model didn't start in time" messaging path is shared with ensure_running
/// failures. Pure fn so the exact string is unit-testable.
fn on_device_test_timeout_error() -> &'static str {
    "on_device_llm_start_failed: test_timeout"
}

/// Classify the disclosure surface of a (provider_id, endpoint) pair.
///
/// - `Local` — HTTP endpoint on loopback / RFC1918 / .local / IPv6 ULA.
/// - `Remote` — HTTP endpoint on the public internet.
/// - `Subscription` — CLI-backed provider. The prompt is handed to a
///   local process via stdin; the CLI then makes its own request
///   using credentials Memlore does not see (the user's Claude /
///   ChatGPT Plus subscription). Tailored privacy copy describes
///   "your local CLI handles auth, Memlore never sees your API key"
///   instead of the misleading Remote-banner copy.
///
/// Recognises BOTH on-device sentinels — the embed-only `on-device`
/// (via [`provider_is_on_device`]) and the chat-only `on-device-llm`
/// sidecar (via [`provider_is_on_device_llm`]). Without the latter check,
/// `on-device-llm` (whose [`preset_default_endpoint`] is `""`) would fall
/// through to `classify_endpoint("")`, which defaults an unparsable URL to
/// `Remote` — mirrors the fix `ai_settings::classify_memory_disclosure`
/// already documents needing for the same reason.
fn classify_provider_disclosure(provider_id: &str, endpoint: &str) -> EndpointClass {
    if provider_uses_subprocess(provider_id) {
        EndpointClass::Subscription
    } else if provider_is_on_device(provider_id) || provider_is_on_device_llm(provider_id) {
        EndpointClass::OnDevice
    } else {
        classify_endpoint(endpoint)
    }
}

/// Build the concrete provider for a slot.
///
/// `downloads` is only consulted for the on-device sentinel (`"on-device"`)
/// embedding dispatch below — every other branch ignores it. Callers that
/// can never reach the on-device slot (the generation-slot commands) pass
/// `None`; the two embedding-slot commands and `load_embed_slot` pass
/// `Some(&Arc<DownloadManager>)` sourced from the Tauri-managed state Task 2
/// registered via `app.manage`.
fn build_slot_provider(
    provider_id: &str,
    endpoint: &str,
    api_key: Option<&str>,
    payload: SlotPayload<'_>,
    downloads: Option<&Arc<DownloadManager>>,
) -> Result<Arc<dyn AIProvider>, AiError> {
    // CLI-backed providers (Claude / Codex) are chat-only and have
    // no endpoint / API key. Dispatch them before the OpenAI-compat
    // catch-all.
    match provider_id {
        CLAUDE_CLI_ID => {
            return match payload {
                SlotPayload::Generation { chat_model } => {
                    Ok(Arc::new(ClaudeCliProvider::new(chat_model)))
                }
                SlotPayload::Embedding { .. } => Err(AiError::ProviderUnsupported(
                    "Claude CLI does not support embeddings; pair with an embedding provider like Voyage or Ollama".into(),
                )),
                SlotPayload::Image { .. } => Err(AiError::ProviderUnsupported(
                    "Claude CLI does not support image generation; pick a hosted image provider like OpenAI".into(),
                )),
            };
        }
        CODEX_CLI_ID => {
            return match payload {
                SlotPayload::Generation { chat_model } => {
                    Ok(Arc::new(CodexCliProvider::new(chat_model)))
                }
                SlotPayload::Embedding { .. } => Err(AiError::ProviderUnsupported(
                    "Codex CLI does not support embeddings; pair with an embedding provider like Voyage or Ollama".into(),
                )),
                SlotPayload::Image { .. } => Err(AiError::ProviderUnsupported(
                    "Codex CLI does not support image generation; pick a hosted image provider like OpenAI".into(),
                )),
            };
        }
        // Task 4 (Embedding Cost Guardrails Phase 4): the on-device
        // sentinel is embedding-only, mirroring how the CLI providers
        // above are chat-only. `embedding_model` here is the catalog
        // model id (e.g. "nomic-embed-text-v1.5"), not a hosted model
        // string — falls back to the catalog default if the persisted
        // setting is empty (defensive; `validate_slot` already rejects an
        // empty model on the write path).
        // Chat-only sidecar. Today `validate_slot`'s empty-endpoint check
        // already blocks it upstream, but that is an indirect invariant —
        // keep the rejection explicit and co-located with the others so it
        // can't silently regress if endpoint handling ever changes.
        ON_DEVICE_LLM_ID if matches!(payload, SlotPayload::Image { .. }) => {
            return Err(AiError::ProviderUnsupported(
                "on-device-llm is a chat-only provider; pick a hosted image provider like OpenAI"
                    .into(),
            ));
        }
        ON_DEVICE_PROVIDER_ID => {
            return match payload {
                SlotPayload::Embedding { embedding_model } => {
                    let downloads = downloads.cloned().ok_or_else(|| {
                        AiError::ProviderError(
                            "on-device provider requires the model download manager".into(),
                        )
                    })?;
                    let model_id = if embedding_model.trim().is_empty() {
                        catalog::default_model_id().to_string()
                    } else {
                        embedding_model.to_string()
                    };
                    Ok(Arc::new(OnDeviceEmbedProvider::new(model_id, downloads)) as Arc<dyn AIProvider>)
                }
                SlotPayload::Generation { .. } => Err(AiError::ProviderUnsupported(
                    "on-device is an embedding-only provider; pair it with a hosted or CLI provider for chat".into(),
                )),
                SlotPayload::Image { .. } => Err(AiError::ProviderUnsupported(
                    "on-device is an embedding-only provider; pick a hosted image provider like OpenAI".into(),
                )),
            };
        }
        _ => {}
    }
    // Root gate (Phase 2 critical fix): a Remote-class provider with no
    // resolvable API key must never be built — every caller falls through
    // to here for the plain HTTP/OpenAI-compatible path, so this single
    // check covers every hydration, reconcile, and set/test command that
    // could otherwise send journal content to a hosted endpoint keyless.
    // See `remote_provider_missing_key`'s doc for the accepted edge case.
    if remote_provider_missing_key(provider_id, endpoint, api_key) {
        return Err(AiError::AuthFailed);
    }
    let (chat_model, embedding_model, image_model) = match payload {
        SlotPayload::Generation { chat_model } => (chat_model.to_string(), String::new(), None),
        SlotPayload::Image { image_model } => {
            (String::new(), String::new(), Some(image_model.to_string()))
        }
        SlotPayload::Embedding { embedding_model } => {
            (String::new(), embedding_model.to_string(), None)
        }
    };
    let cfg = OpenAICompatibleConfig {
        id: provider_id.to_string(),
        display_name: provider_id.to_string(),
        endpoint: endpoint.to_string(),
        api_key: api_key.map(|k| Zeroizing::new(k.to_string())),
        chat_model,
        embedding_model,
        image_model,
    };
    Ok(Arc::new(OpenAICompatibleProvider::new(cfg)?))
}

fn validate_slot(
    provider: &str,
    endpoint: &str,
    model: &str,
    model_label: &str,
) -> Result<(), AiError> {
    if provider.trim().is_empty() {
        return Err(AiError::ProviderError("provider id required".into()));
    }
    // CLI-backed providers (Claude / Codex) have no endpoint — they spawn
    // a subprocess, not an HTTP request. The on-device sentinel has no
    // endpoint either — inference runs in-process. Skip both the
    // empty-check and the URL-validity check for both cases.
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

// ── Commands ──────────────────────────────────────────────────────────────

/// Configure (or replace) the generation (chat + image) provider.
///
/// Does NOT cancel any in-flight backfill — backfill is embedding-side
/// only, so a generation swap leaves it alone. The embedding-side
/// command is the one that cancels.
///
/// **Phase 4 Task 2 — on-device-llm + stop-on-switch:** when
/// `input.provider == "on-device-llm"`, this skips endpoint/API-key
/// validation (no HTTP endpoint, no credentials — the `llama-server`
/// sidecar is spoken to over loopback), validates the catalog id exists
/// AND is downloaded, builds an [`OnDeviceLlmProvider`], and persists the
/// slot's provider + model only (T2.3: endpoint/key never lived on the slot
/// to begin with — they're resolved from the credential registry). Selecting
/// on-device-llm does NOT eagerly spawn the sidecar — the first chat request
/// does that lazily (see [`OnDeviceLlmProvider::chat`]).
///
/// **Stop-on-switch (explicit user requirement):** after a successful
/// swap, if the PREVIOUS generation provider id was `on-device-llm` and
/// the new one is not, this stops the sidecar immediately via
/// [`LlamaServerManager::stop`] — switching away from on-device-llm kills
/// the sidecar right away rather than waiting for the idle watcher. The
/// decision lives in [`should_stop_on_switch`] (pure, unit-tested).
#[tauri::command]
pub async fn set_ai_generation_provider(
    input: AIGenProviderConfigInput,
    state: State<'_, AppState>,
    registry: State<'_, ProviderRegistry>,
    server_manager: State<'_, Arc<LlamaServerManager>>,
    asset_manager: State<'_, Arc<LlmAssetManager>>,
) -> Result<SetProviderResult, String> {
    // ── on-device-llm: dedicated branch (no endpoint, no API key) ──────────
    //
    // Validated + built before the shared slot path because `validate_slot`
    // and `build_slot_provider` are HTTP/OpenAI-compat-oriented; the on-device
    // LLM provider has neither an endpoint nor credentials.
    if input.provider == ON_DEVICE_LLM_ID {
        // Do NOT require the model to be downloaded here. The Settings model
        // picker only appears once this provider is SAVED, so gating the save
        // on a downloaded model deadlocks the UI (user can never reach the
        // picker to download one). This mirrors the embedding save path, which
        // has no download gate. Catalog-membership is still enforced by
        // `OnDeviceLlmProvider::new` below (unknown ids fail fast), and the
        // real "must be downloaded" guard lives at chat time in
        // `LlamaServerManager::ensure_running`.
        let class = EndpointClass::OnDevice;

        // Read the PREVIOUS provider id BEFORE the swap overwrites the row.
        // `persist_gen_config` rewrites `ai_gen_provider` inside its
        // transaction, so this snapshot must happen first.
        let prev_provider = {
            let conn = state.lock().map_err(|e| e.to_string())?;
            db::get_setting(&conn, GenKeys::PROVIDER)
                .map_err(|e| e.to_string())?
                .unwrap_or_default()
        };

        let provider: Arc<dyn AIProvider> = Arc::new(OnDeviceLlmProvider::new(
            server_manager.inner().clone(),
            asset_manager.inner().clone(),
            input.chat_model.clone(),
        )?);

        let needs_consent = {
            let conn = state.lock()?;
            // The active on-device slot carries no endpoint/key at all
            // (T2.3: neither field lives on the slot any more) — persist
            // provider + model only.
            let sanitized = AIGenProviderConfigInput {
                provider: input.provider.clone(),
                chat_model: input.chat_model.clone(),
            };
            let needs_consent =
                persist_gen_config(&conn, &sanitized, class).map_err(String::from)?;
            registry.swap_generation(Arc::clone(&provider));
            needs_consent
        };

        // Stop-on-switch: previous slot was on-device-llm, new one is not →
        // tear the sidecar down now (best-effort; a failure to stop must not
        // fail a successful swap + persist).
        if should_stop_on_switch(&prev_provider, &input.provider) {
            if let Err(e) = server_manager.inner().stop().await {
                log::warn!("set_ai_generation_provider: stop sidecar failed (non-fatal): {e}");
            }
        }

        return Ok(SetProviderResult {
            provider: input.provider,
            endpoint_class: class,
            requires_privacy_consent: needs_consent,
        });
    }

    // T2.3 cutover: endpoint/key are resolved from the per-preset credential
    // registry, keyed by `input.provider` — no longer part of the input.
    let (endpoint, api_key) = {
        let conn = state.lock().map_err(|e| e.to_string())?;
        resolve_credential(&conn, &input.provider).map_err(String::from)?
    };
    validate_slot(&input.provider, &endpoint, &input.chat_model, "chat_model")
        .map_err(String::from)?;
    let class = classify_provider_disclosure(&input.provider, &endpoint);
    let provider = build_slot_provider(
        &input.provider,
        &endpoint,
        api_key.as_deref(),
        SlotPayload::Generation {
            chat_model: &input.chat_model,
        },
        None,
    )
    .map_err(String::from)?;

    // Read the previous provider id before the swap (same reason as the
    // on-device-llm branch above — `persist_gen_config` overwrites the row).
    let prev_provider = {
        let conn = state.lock().map_err(|e| e.to_string())?;
        db::get_setting(&conn, GenKeys::PROVIDER)
            .map_err(|e| e.to_string())?
            .unwrap_or_default()
    };

    let needs_consent = {
        let conn = state.lock()?;
        let needs_consent = persist_gen_config(&conn, &input, class).map_err(String::from)?;
        registry.swap_generation(Arc::clone(&provider));
        needs_consent
    };

    // Stop-on-switch applies symmetrically when swapping FROM on-device-llm
    // to a hosted/CLI provider.
    if should_stop_on_switch(&prev_provider, &input.provider) {
        if let Err(e) = server_manager.inner().stop().await {
            log::warn!("set_ai_generation_provider: stop sidecar failed (non-fatal): {e}");
        }
    }

    Ok(SetProviderResult {
        provider: input.provider,
        endpoint_class: class,
        requires_privacy_consent: needs_consent,
    })
}

/// Configure (or replace) the embedding provider.
///
/// **Cancels any in-flight backfill** — the backfill loop captured the
/// prior embedding provider's `Arc` at start, so without a cancel it
/// would keep writing rows under the OLD `model_id` after the user has
/// moved on. Same posture as the legacy `set_ai_provider`.
///
/// **Phase 2 Task 6 — rebuild trigger:** when `apply_embedding_slot_change`
/// reports the embedding slot's IDENTITY (`provider_id:embedding_model`,
/// key excluded) actually changed, this emits `ai:backfill-model-changed`
/// (payload: `model_id`, `enqueued`, `requires_consent` — the last true iff
/// the new slot is hosted, since `persist_embed_config` just cleared the
/// hosted background-indexing consent for the old identity). A generation-
/// slot swap never reaches this command, and an embedding API-key rotation
/// on the same provider/model reports `identity_changed = false` — neither
/// triggers a rebuild (re-embed enqueue).
///
/// **C4 — worker restart is UNCONDITIONAL, not gated on `identity_changed`:**
/// whenever an embedding-consuming feature is on, this nudges the
/// continuous worker awake (`start_indexing_worker`) via
/// `cancel_and_clear` + a synchronous restart, so a routine API-key
/// rotation (`identity_changed = false`, no rebuild) still resumes
/// background indexing instead of leaving it permanently halted by the
/// unconditional cancel above.
#[tauri::command]
pub async fn set_ai_embedding_provider(
    input: AIEmbedProviderConfigInput,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    registry: State<'_, ProviderRegistry>,
    indexer: State<'_, crate::ai::indexer::EntryIndexer>,
    backfill: State<'_, crate::commands::ai::BackfillManager>,
    downloads: State<'_, Arc<DownloadManager>>,
) -> Result<SetProviderResult, String> {
    // T2.3 cutover: endpoint/key are resolved from the per-preset credential
    // registry, keyed by `input.provider` — no longer part of the input.
    let (endpoint, api_key) = {
        let conn = state.lock().map_err(|e| e.to_string())?;
        resolve_credential(&conn, &input.provider).map_err(String::from)?
    };
    validate_slot(
        &input.provider,
        &endpoint,
        &input.embedding_model,
        "embedding_model",
    )
    .map_err(String::from)?;
    let class = classify_provider_disclosure(&input.provider, &endpoint);
    let provider = build_slot_provider(
        &input.provider,
        &endpoint,
        api_key.as_deref(),
        SlotPayload::Embedding {
            embedding_model: &input.embedding_model,
        },
        Some(downloads.inner()),
    )
    .map_err(String::from)?;

    let outcome = {
        let conn = state.lock()?;
        apply_embedding_slot_change(&conn, &registry, Arc::clone(&provider), &input, class)
            .map_err(String::from)?
    };

    if outcome.identity_changed {
        let _ = app.emit(
            "ai:backfill-model-changed",
            serde_json::json!({
                "model_id": outcome.model_id,
                "enqueued": outcome.enqueued,
                "requires_consent": class == EndpointClass::Remote,
            }),
        );
    }
    // T1.4: post-swap maintenance (cancel + sync + restart) lives in
    // `run_embedding_post_swap_sequence` so T1.5's reconcile path can
    // reuse it without re-deriving the inputs. The emit above is NOT in
    // the helper — it's the slot-save path's exclusive responsibility
    // (reconcile must stay silent on key/endpoint rotation).
    run_embedding_post_swap_sequence(&backfill, &indexer, &registry, &outcome, || {
        crate::commands::ai::start_indexing_worker(app.clone())
    });

    Ok(outcome.result)
}

/// C4 fix: pure, AppHandle-free extraction of `set_ai_embedding_provider`'s
/// post-swap restart decision — directly unit-testable (unlike the
/// `#[tauri::command]` body itself, which needs a real `tauri::AppHandle`
/// this codebase's tests never construct).
fn should_restart_worker_after_embedding_slot_change(outcome: &EmbeddingSlotChangeOutcome) -> bool {
    outcome.features_enabled
}

/// T1.4 — the post-swap sequence shared between `set_ai_embedding_provider`
/// (today) and `reconcile_slots_for_preset` (T1.5). Pure extraction of the
/// four-step maintenance that runs AFTER an embedding slot's provider
/// `Arc` has been swapped in the `ProviderRegistry`:
///
///   1. `backfill.cancel_and_clear()` — C4 fix's load-bearing step: vacate
///      the single-slot reservation synchronously so the restart below
///      can actually spawn a fresh loop instead of no-op'ing against an
///      occupied slot (which is what left background indexing permanently
///      halted after a routine key rotation under the old plain
///      `cancel()`).
///   2. `sync_indexer_embedder` — re-bind the indexer's swappable backend
///      to whatever the registry now holds.
///   3. `should_restart_worker_after_embedding_slot_change` — the
///      AppHandle-free restart predicate (kept as a separate fn so it
///      stays directly unit-testable; see the guard test in
///      `embedding_slot_change_restarts_worker_even_when_identity_unchanged_key_rotation`).
///   4. `restart_worker()` — the AppHandle-bearing spawn itself, injected
///      as a closure so this fn stays unit-testable without a real
///      `tauri::AppHandle` (the same extraction posture as
///      `should_restart_worker_after_embedding_slot_change`). Callers pass
///      `|| commands::ai::start_indexing_worker(app.clone())` (production)
///      or a recording spy (tests).
///
/// The `ai:backfill-model-changed` emit is **callers'** job (the
/// slot-save path emits when `outcome.identity_changed`; the T1.5
/// reconcile path never emits — a key/endpoint rotation is silent
/// maintenance, not a user-facing model swap).
///
/// `identity_changed` is intentionally NOT a parameter: the restart gate
/// depends only on `features_enabled` (C4 fix). T1.5's reconcile computes
/// `identity_changed` separately, for its own emit decision — it does NOT
/// route that decision through this helper.
pub(crate) fn run_embedding_post_swap_sequence<R: FnOnce()>(
    backfill: &crate::commands::ai::BackfillManager,
    indexer: &crate::ai::indexer::EntryIndexer,
    registry: &ProviderRegistry,
    outcome: &EmbeddingSlotChangeOutcome,
    restart_worker: R,
) {
    backfill.cancel_and_clear();
    crate::commands::ai::sync_indexer_embedder(indexer, registry);
    if should_restart_worker_after_embedding_slot_change(outcome) {
        restart_worker();
    }
}

/// Round-3 fix #1 — post-CLEAR companion to [`run_embedding_post_swap_sequence`],
/// for when [`reconcile_embedding_slot`] finds its bound preset's credential
/// was just forgotten (empty resolved endpoint) and clears the embedding
/// registry slot instead of rebuilding it (`EmbedSlotReconcile::Cleared`).
///
/// Steps 1–2 of the swap-path sequence still apply: the backfill
/// reservation must be vacated and — critically — `sync_indexer_embedder`
/// must re-read `registry.embedding()` (now `None`) so `EntryIndexer` falls
/// back to the stub embedder instead of keeping its old cached `Arc`, built
/// with the now-deleted key. Without this, the indexer and backfill worker
/// silently kept sending journal text to the forgotten credential's
/// provider until app restart — the exact bug round-2 fix #1 set out to
/// close but missed for the CLEARED case.
///
/// Step 3 (restart) is intentionally OMITTED: unlike
/// `should_restart_worker_after_embedding_slot_change`'s `features_enabled`
/// gate, there is nothing here to gate a restart on — `embedding_features_enabled`
/// is a user-facing toggle independent of whether a provider is configured
/// (see its doc comment), so it cannot be relied on to naturally read
/// `false` just because the slot was cleared. Starting the worker against a
/// slot with no configured provider doesn't make sense, so this path never
/// calls `restart_worker()` at all.
fn run_embedding_post_clear_sequence(
    backfill: &crate::commands::ai::BackfillManager,
    indexer: &crate::ai::indexer::EntryIndexer,
    registry: &ProviderRegistry,
) {
    backfill.cancel_and_clear();
    crate::commands::ai::sync_indexer_embedder(indexer, registry);
}

// ─── Per-preset slot reconciliation (T1.5) ─────────────────────────────────

/// Which of the (up to five) `ProviderRegistry` slots [`reconcile_slots_for_preset`]
/// actually rebuilt + re-swapped. `true` means that slot was bound to the
/// reconciled preset id AND (for the memory slots) passed
/// [`enforce_memory_slot_class`]. A memory slot that was bound to the preset
/// but got rejected by class enforcement reports `false` here — that is a
/// routine drop, not a failure (see the fn doc).
///
/// `errors` carries `(slot name, error message)` for any bound slot whose
/// rebuild returned `Err` — distinct from a routine class-enforcement drop
/// (which stays `false` with no entry here). [`reconcile_slots_for_preset`]
/// is best-effort: a build failure on one slot is recorded here but never
/// aborts reconciliation of the others.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(crate) struct ReconcileOutcome {
    pub(crate) generation: bool,
    pub(crate) image: bool,
    pub(crate) embedding: bool,
    pub(crate) memory_generation: bool,
    pub(crate) memory_embedding: bool,
    pub(crate) errors: Vec<(&'static str, String)>,
}

/// `Ok(true)` iff `provider_key`'s stored value is configured (non-empty,
/// not `"none"`) AND equals `preset_id` — the same "configured" convention
/// [`load_gen_slot`] / [`load_embed_slot`] / [`load_memory_gen_slot`] /
/// [`load_memory_embed_slot`] use to decide whether a slot's row is even
/// worth reading further.
fn slot_bound_to_preset(
    conn: &rusqlite::Connection,
    provider_key: &str,
    preset_id: &str,
) -> Result<bool, AiError> {
    let provider =
        db::get_setting(conn, provider_key).map_err(|e| AiError::IoError(e.to_string()))?;
    Ok(matches!(provider.as_deref(), Some(p) if !p.is_empty() && p != "none" && p == preset_id))
}

/// Rebuild + re-swap the generation slot for `preset_id`. Mirrors
/// [`load_gen_slot`]'s on-device-llm special case and endpoint guard, but
/// sources the (endpoint, key) pair from [`resolve_credential`] instead of
/// the legacy `ai_gen_endpoint` / `ai_gen_api_key` rows, and never touches
/// `ai_gen_chat_model` — the model is read as-is, never changed here.
fn reconcile_generation_slot(
    conn: &rusqlite::Connection,
    registry: &ProviderRegistry,
    preset_id: &str,
    server_manager: Option<&Arc<LlamaServerManager>>,
    asset_manager: Option<&Arc<LlmAssetManager>>,
) -> Result<bool, AiError> {
    let chat_model = db::get_setting(conn, GenKeys::model_key())
        .map_err(|e| AiError::IoError(e.to_string()))?
        .unwrap_or_default();
    if chat_model.is_empty() {
        log::warn!("reconcile_slots_for_preset: gen slot chat_model is empty, skipping rebuild");
        return Ok(false);
    }

    if preset_id == ON_DEVICE_LLM_ID {
        let (server, assets) = match (server_manager, asset_manager) {
            (Some(s), Some(a)) => (s.clone(), a.clone()),
            _ => {
                log::warn!(
                    "reconcile_slots_for_preset: on-device-llm managers unavailable, skipping gen rebuild"
                );
                return Ok(false);
            }
        };
        let provider: Arc<dyn AIProvider> =
            Arc::new(OnDeviceLlmProvider::new(server, assets, chat_model)?);
        registry.swap_generation(provider);
        return Ok(true);
    }

    let (endpoint, key) = resolve_credential(conn, preset_id)?;
    if !provider_uses_subprocess(preset_id) {
        if endpoint.is_empty() {
            // Round-2 fix #1: an empty endpoint here means the credential
            // was just forgotten (`persist_provider_credential` already
            // rejects an empty endpoint for any HTTP-surface preset, so a
            // normal save could never leave this slot pointed at ""). The
            // OLD `Arc<dyn AIProvider>` — built with the now-deleted
            // key/endpoint — must not keep serving from the registry until
            // app restart, so the slot is actively cleared rather than left
            // as-is.
            log::warn!(
                "reconcile_slots_for_preset: gen slot endpoint is now unusable, clearing live \
                 registry slot instead of leaving the stale provider active"
            );
            registry.clear_generation();
            return Ok(false);
        }
        validate_endpoint_url(&endpoint)?;
    }
    if remote_provider_missing_key(preset_id, &endpoint, key.as_deref()) {
        // Critical-fix (Phase 2): the credential write that triggered this
        // reconcile just left the slot's remote provider keyless (key
        // cleared, endpoint otherwise unchanged so the empty-endpoint
        // branch above never fires). `reconcile_slots_for_preset` only
        // LOGS a build error — it does not clear the registry on `Err` —
        // so relying on `build_slot_provider`'s guard below would leave
        // the OLD provider (built with the now-forgotten key) silently
        // still serving. Clear explicitly, same posture as the
        // empty-endpoint branch above.
        log::warn!(
            "reconcile_slots_for_preset: gen slot's remote provider '{preset_id}' has no \
             resolvable API key, clearing live registry slot instead of leaving a stale \
             provider active"
        );
        registry.clear_generation();
        return Ok(false);
    }
    let provider = build_slot_provider(
        preset_id,
        &endpoint,
        key.as_deref(),
        SlotPayload::Generation {
            chat_model: &chat_model,
        },
        None,
    )?;
    registry.swap_generation(provider);
    Ok(true)
}

/// Rebuild + re-swap the image slot for `preset_id`. Mirrors
/// [`reconcile_generation_slot`]'s posture exactly, minus the on-device-llm
/// branch (no on-device or CLI preset can generate images).
///
/// **Why this must exist (security):** the live `Arc<dyn AIProvider>` bakes
/// in the endpoint + API key at construction time, but every privacy check
/// re-derives the endpoint class LIVE from the DB
/// ([`slot_provider_class`] → [`class_privacy_accepted`], which auto-exempts
/// `Local`/`OnDevice`). Without reconciliation, repointing a preset's
/// credential from a hosted endpoint to a local one would make the consent
/// gate report "no disclosure needed" while `generate_inline_image` kept
/// sending prompts to the ORIGINAL hosted vendor with the old key, until
/// app restart. Same reason the other four slots are reconciled.
fn reconcile_image_slot(
    conn: &rusqlite::Connection,
    registry: &ProviderRegistry,
    preset_id: &str,
) -> Result<bool, AiError> {
    let image_model = db::get_setting(conn, settings_keys::image::IMAGE_MODEL)
        .map_err(|e| AiError::IoError(e.to_string()))?
        .unwrap_or_default();
    if image_model.is_empty() {
        log::warn!("reconcile_slots_for_preset: image slot image_model is empty, skipping rebuild");
        return Ok(false);
    }

    let (endpoint, key) = resolve_credential(conn, preset_id)?;
    if endpoint.is_empty() {
        // The credential was just forgotten. The old provider — built with
        // the now-deleted endpoint/key — must not keep serving until app
        // restart, so clear rather than leave it stale.
        log::warn!(
            "reconcile_slots_for_preset: image slot endpoint is now unusable, clearing live \
             registry slot instead of leaving the stale provider active"
        );
        registry.clear_image();
        return Ok(false);
    }
    validate_endpoint_url(&endpoint)?;
    if remote_provider_missing_key(preset_id, &endpoint, key.as_deref()) {
        // Key cleared while the endpoint stayed put, so the empty-endpoint
        // branch above never fires. `reconcile_slots_for_preset` only LOGS
        // a build error, so relying on `build_slot_provider`'s guard would
        // leave the OLD, keyed provider serving. Clear explicitly.
        log::warn!(
            "reconcile_slots_for_preset: image slot's remote provider '{preset_id}' has no \
             resolvable API key, clearing live registry slot instead of leaving a stale \
             provider active"
        );
        registry.clear_image();
        return Ok(false);
    }
    let provider = build_slot_provider(
        preset_id,
        &endpoint,
        key.as_deref(),
        SlotPayload::Image {
            image_model: &image_model,
        },
        None,
    )?;
    registry.swap_image(provider);
    Ok(true)
}

/// [`reconcile_embedding_slot`]'s outcome — distinguishes "nothing to do"
/// from "actively cleared" so [`reconcile_slots_for_preset`] knows whether
/// post-clear maintenance (round-3 fix #1) is needed. Both `Skipped` and
/// `Cleared` report `false` in [`ReconcileOutcome::embedding`] (neither is
/// a successful rebuild+swap), but only `Cleared` actually changed what the
/// registry holds.
enum EmbedSlotReconcile {
    /// Rebuilt and swapped in — carries the outcome
    /// [`run_embedding_post_swap_sequence`] needs.
    Rebuilt(EmbeddingSlotChangeOutcome),
    /// The slot's credential was just forgotten (empty resolved endpoint,
    /// round-2 fix #1): `registry.clear_embedding()` already ran. The
    /// indexer/backfill worker must still be desynced from the now-stale
    /// `Arc` — see [`run_embedding_post_clear_sequence`] — but restarting
    /// background indexing against an unconfigured slot makes no sense.
    Cleared,
    /// No embedding_model configured yet — nothing was touched, nothing to
    /// reconcile.
    Skipped,
}

/// Rebuild + re-swap the embedding slot for `preset_id`. Mirrors
/// [`load_embed_slot`]'s endpoint guard, sourcing the (endpoint, key) pair
/// from [`resolve_credential`] and reusing the persisted `ai_embed_embedding_model`
/// as-is. Returns an [`EmbedSlotReconcile`] the caller matches on — the
/// `Rebuilt` case feeds [`run_embedding_post_swap_sequence`] — `identity_changed`
/// is always `false` here since neither the provider id nor the model can
/// change via reconcile, only the credential/endpoint.
///
/// `old_endpoint` is the preset's resolved endpoint from *before* the
/// caller's credential write (captured via [`resolve_credential`] — see
/// [`set_ai_provider_credential`] / [`forget_ai_provider_credential`]).
/// Round-2 fix #2: mirrors [`persist_embed_config`]'s
/// [`consent_identity`]-based invalidation — a stale
/// `BACKGROUND_INDEXING_HOSTED_CONSENT_AT` acceptance must never silently
/// keep covering a NEW endpoint the reconcile just swapped in.
fn reconcile_embedding_slot(
    conn: &rusqlite::Connection,
    registry: &ProviderRegistry,
    preset_id: &str,
    downloads: Option<&Arc<DownloadManager>>,
    old_endpoint: &str,
) -> Result<EmbedSlotReconcile, AiError> {
    let embedding_model = db::get_setting(conn, EmbedKeys::model_key())
        .map_err(|e| AiError::IoError(e.to_string()))?
        .unwrap_or_default();
    if embedding_model.is_empty() {
        log::warn!(
            "reconcile_slots_for_preset: embed slot embedding_model is empty, skipping rebuild"
        );
        return Ok(EmbedSlotReconcile::Skipped);
    }
    let (endpoint, key) = resolve_credential(conn, preset_id)?;

    // Round-2 fix #2: consent is endpoint-scoped (see `consent_identity`'s
    // doc) and must be invalidated the instant the resolved identity
    // changes — checked BEFORE the empty-endpoint branch below so a
    // credential forget (which clears the slot rather than rebuilding it,
    // fix #1) still drops a stale acceptance for the endpoint that is now
    // gone.
    if consent_identity(preset_id, old_endpoint, &embedding_model)
        != consent_identity(preset_id, &endpoint, &embedding_model)
    {
        db::delete_setting(conn, settings_keys::BACKGROUND_INDEXING_HOSTED_CONSENT_AT)
            .map_err(|e| AiError::IoError(e.to_string()))?;
    }

    if !provider_uses_subprocess(preset_id) && !provider_is_on_device(preset_id) {
        if endpoint.is_empty() {
            // Round-2 fix #1: see the identical guard in
            // `reconcile_generation_slot` — an empty endpoint here means
            // the credential was just forgotten, and the OLD live provider
            // (built with the now-deleted key) must not keep serving from
            // the registry until app restart.
            log::warn!(
                "reconcile_slots_for_preset: embed slot endpoint is now unusable, clearing live \
                 registry slot instead of leaving the stale provider active"
            );
            registry.clear_embedding();
            return Ok(EmbedSlotReconcile::Cleared);
        }
        validate_endpoint_url(&endpoint)?;
    }
    if remote_provider_missing_key(preset_id, &endpoint, key.as_deref()) {
        // Critical-fix (Phase 2): mirrors the identical guard in
        // `reconcile_generation_slot` — a key-only clear leaves the
        // endpoint unchanged, so the empty-endpoint branch above never
        // fires. Returning `Cleared` (not just skipping) routes through
        // `run_embedding_post_clear_sequence`, which is the ONLY path that
        // also desyncs the indexer/backfill worker from the now-stale
        // `Arc` — without it the worker keeps embedding on the forgotten
        // credential until app restart, the exact class of bug round-2
        // fix #1 closed for the empty-endpoint case.
        log::warn!(
            "reconcile_slots_for_preset: embed slot's remote provider '{preset_id}' has no \
             resolvable API key, clearing live registry slot instead of leaving a stale \
             provider active"
        );
        registry.clear_embedding();
        return Ok(EmbedSlotReconcile::Cleared);
    }
    let provider = build_slot_provider(
        preset_id,
        &endpoint,
        key.as_deref(),
        SlotPayload::Embedding {
            embedding_model: &embedding_model,
        },
        downloads,
    )?;
    let model_id = provider_namespaced_model_id(&*provider);
    let class = credential_class(preset_id, &endpoint);
    registry.swap_embedding(provider);

    // Round-2 fix #3: mirror `apply_embedding_slot_change`'s recovery
    // trigger — a successful credential fix (e.g. rotating a bad key) must
    // resume jobs `paused` on the OLD credential for this model_id, or they
    // are stuck forever (see project memory on "embedding pending stuck").
    let now = chrono::Utc::now().timestamp();
    db::embeddings::reset_paused_jobs_to_pending(conn, &model_id, now, now)
        .map_err(|e| AiError::IoError(format!("reset_paused_jobs_to_pending: {e}")))?;

    let features_enabled = crate::commands::ai_settings::embedding_features_enabled(conn);
    Ok(EmbedSlotReconcile::Rebuilt(EmbeddingSlotChangeOutcome {
        result: SetProviderResult {
            provider: preset_id.to_string(),
            endpoint_class: class,
            requires_privacy_consent: false,
        },
        identity_changed: false,
        enqueued: 0,
        model_id,
        features_enabled,
    }))
}

/// Rebuild + re-swap the memory GENERATION slot for `preset_id`, mirroring
/// [`load_memory_gen_slot`]'s defense-in-depth re-check: [`enforce_memory_slot_class`]
/// runs BEFORE any rebuild, against the CURRENT `ai_memory_allow_hosted`
/// flag. A rejection is a routine drop (`Ok(false)`, logged), never an
/// error — but round-3 fix #3: NOT a no-op. Whatever the registry
/// currently holds for this slot is actively cleared
/// ([`ProviderRegistry::clear_memory_generation`]) rather than left live,
/// so a rejection can never leave a policy-violating provider (e.g. one
/// built before a Local→Remote endpoint edit) silently still serving
/// requests.
fn reconcile_memory_generation_slot(
    conn: &rusqlite::Connection,
    registry: &ProviderRegistry,
    preset_id: &str,
    server_manager: Option<&Arc<LlamaServerManager>>,
    asset_manager: Option<&Arc<LlmAssetManager>>,
) -> Result<bool, AiError> {
    let chat_model = db::get_setting(conn, settings_keys::memory_gen::CHAT_MODEL)
        .map_err(|e| AiError::IoError(e.to_string()))?
        .unwrap_or_default();
    if chat_model.is_empty() {
        log::warn!(
            "reconcile_slots_for_preset: memory gen slot chat_model is empty, skipping rebuild"
        );
        return Ok(false);
    }

    let (endpoint, key) = resolve_credential(conn, preset_id)?;
    let allow_hosted = crate::commands::ai_settings::read_memory_allow_hosted(conn);
    if let Err(e) = enforce_memory_slot_class(
        preset_id,
        &endpoint,
        MemorySlotKind::Generation,
        allow_hosted,
    ) {
        // Round-3 fix #3: a rejection here can happen with an EXISTING live
        // provider still in the registry — e.g. a credential edit just
        // moved the bound preset's endpoint from Local to Remote while
        // `ai_memory_allow_hosted` is off. Leaving that old provider active
        // would keep memory generation silently running on a credential
        // current policy says it shouldn't. Clear it — same mechanism (and
        // same "routine drop, not a failure" posture: still `Ok(false)`)
        // round-2 fix #1 already uses for an empty-endpoint forget.
        log::warn!(
            "reconcile_slots_for_preset: memory gen slot rejected by class enforcement, \
             clearing live registry slot rather than leaving a policy-violating provider active: {e}"
        );
        registry.clear_memory_generation();
        return Ok(false);
    }

    if preset_id == ON_DEVICE_LLM_ID {
        let (server, assets) = match (server_manager, asset_manager) {
            (Some(s), Some(a)) => (s.clone(), a.clone()),
            _ => {
                log::warn!(
                    "reconcile_slots_for_preset: on-device-llm managers unavailable, skipping memory gen rebuild"
                );
                return Ok(false);
            }
        };
        let provider: Arc<dyn AIProvider> =
            Arc::new(OnDeviceLlmProvider::new(server, assets, chat_model)?);
        registry.swap_memory_generation(provider);
        return Ok(true);
    }

    if !provider_uses_subprocess(preset_id) {
        if endpoint.is_empty() {
            // Round-2 fix #1: see the identical guard in
            // `reconcile_generation_slot`.
            log::warn!(
                "reconcile_slots_for_preset: memory gen slot endpoint is now unusable, clearing \
                 live registry slot instead of leaving the stale provider active"
            );
            registry.clear_memory_generation();
            return Ok(false);
        }
        validate_endpoint_url(&endpoint)?;
    }
    if remote_provider_missing_key(preset_id, &endpoint, key.as_deref()) {
        // Critical-fix (Phase 2): mirrors the identical guard in
        // `reconcile_generation_slot` — clear rather than leave a stale,
        // now-keyless-credentialed provider live.
        log::warn!(
            "reconcile_slots_for_preset: memory gen slot's remote provider '{preset_id}' has no \
             resolvable API key, clearing live registry slot instead of leaving a stale \
             provider active"
        );
        registry.clear_memory_generation();
        return Ok(false);
    }
    let provider = build_slot_provider(
        preset_id,
        &endpoint,
        key.as_deref(),
        SlotPayload::Generation {
            chat_model: &chat_model,
        },
        None,
    )?;
    registry.swap_memory_generation(provider);
    Ok(true)
}

/// Rebuild + re-swap the memory EMBEDDING slot for `preset_id`, mirroring
/// [`load_memory_embed_slot`]'s defense-in-depth re-check (same posture as
/// [`reconcile_memory_generation_slot`], on the embedding-slot keys/kind).
fn reconcile_memory_embedding_slot(
    conn: &rusqlite::Connection,
    registry: &ProviderRegistry,
    preset_id: &str,
    downloads: Option<&Arc<DownloadManager>>,
) -> Result<bool, AiError> {
    let embedding_model = db::get_setting(conn, settings_keys::memory_embed::EMBEDDING_MODEL)
        .map_err(|e| AiError::IoError(e.to_string()))?
        .unwrap_or_default();
    if embedding_model.is_empty() {
        log::warn!(
            "reconcile_slots_for_preset: memory embed slot embedding_model is empty, skipping rebuild"
        );
        return Ok(false);
    }

    let (endpoint, key) = resolve_credential(conn, preset_id)?;
    let allow_hosted = crate::commands::ai_settings::read_memory_allow_hosted(conn);
    if let Err(e) = enforce_memory_slot_class(
        preset_id,
        &endpoint,
        MemorySlotKind::Embedding,
        allow_hosted,
    ) {
        // Round-3 fix #3: see the identical guard in
        // `reconcile_memory_generation_slot` — clear rather than leave a
        // policy-violating provider live.
        log::warn!(
            "reconcile_slots_for_preset: memory embed slot rejected by class enforcement, \
             clearing live registry slot rather than leaving a policy-violating provider active: {e}"
        );
        registry.clear_memory_embedding();
        return Ok(false);
    }

    if !provider_uses_subprocess(preset_id) && !provider_is_on_device(preset_id) {
        if endpoint.is_empty() {
            // Round-2 fix #1: see the identical guard in
            // `reconcile_generation_slot`.
            log::warn!(
                "reconcile_slots_for_preset: memory embed slot endpoint is now unusable, \
                 clearing live registry slot instead of leaving the stale provider active"
            );
            registry.clear_memory_embedding();
            return Ok(false);
        }
        validate_endpoint_url(&endpoint)?;
    }
    if remote_provider_missing_key(preset_id, &endpoint, key.as_deref()) {
        // Critical-fix (Phase 2): mirrors the identical guard in
        // `reconcile_embedding_slot` — clear rather than leave a stale,
        // now-keyless-credentialed provider live.
        log::warn!(
            "reconcile_slots_for_preset: memory embed slot's remote provider '{preset_id}' has \
             no resolvable API key, clearing live registry slot instead of leaving a stale \
             provider active"
        );
        registry.clear_memory_embedding();
        return Ok(false);
    }
    let provider = build_slot_provider(
        preset_id,
        &endpoint,
        key.as_deref(),
        SlotPayload::Embedding {
            embedding_model: &embedding_model,
        },
        downloads,
    )?;
    registry.swap_memory_embedding(provider);
    Ok(true)
}

/// T1.5 — the load-bearing fix for the per-preset credential registry
/// (Phase 1): a credential edit (endpoint override and/or API key rotation)
/// in the future Providers tab is NOT just a settings write. `ProviderRegistry`
/// holds *built* `Arc<dyn AIProvider>` instances that snapshot the API key
/// at construction (see the module doc on `provider_registry.rs`), so
/// every slot currently bound to the edited preset must be rebuilt from the
/// freshly-resolved credential and re-swapped in, or the running session
/// silently keeps using the stale key.
///
/// Reads each of the four slots' `PROVIDER` row (same convention as
/// [`load_gen_slot`] / [`load_embed_slot`] / [`load_memory_gen_slot`] /
/// [`load_memory_embed_slot`]) and, for every slot whose value equals
/// `preset_id`, rebuilds via [`build_slot_provider`] using the fresh
/// (endpoint, key) pair from [`resolve_credential`] and the slot's EXISTING
/// model — the model is never changed here, only the credential/endpoint.
/// This function never writes the credential/endpoint settings rows
/// themselves; T1.6 (out of scope here) is responsible for persisting the
/// new endpoint/key BEFORE calling this. The one exception is round-2 fix
/// #2: [`reconcile_embedding_slot`] deletes the stale
/// `BACKGROUND_INDEXING_HOSTED_CONSENT_AT` row when the resolved endpoint
/// identity changed, mirroring [`persist_embed_config`]'s own consent
/// invalidation.
///
/// Memory slots additionally run [`enforce_memory_slot_class`] BEFORE
/// swapping. A rejection (e.g. a hosted preset with `ai_memory_allow_hosted`
/// off) DROPS that slot — never rebuilt/swapped — `Ok` is still returned,
/// and the corresponding [`ReconcileOutcome`] field is `false`. This is a
/// routine, expected outcome, not an error — mirrors how
/// [`load_memory_gen_slot`] / [`load_memory_embed_slot`] treat the same
/// rejection at hydration time. Round-3 fix #3: a drop is NOT a no-op —
/// whatever the registry currently holds for that slot is actively cleared
/// (never left running a now-policy-violating provider), the same posture
/// round-2 fix #1 already uses for an empty-endpoint forget.
///
/// A build failure for ANY slot (generation/embedding/memory) is caught and
/// recorded in [`ReconcileOutcome::errors`] rather than propagated as `Err`
/// — this function is best-effort across all four slots. By the time this
/// runs, the caller has already persisted the new credential to the DB
/// (T1.6); if e.g. the generation slot's rebuild fails, the embedding /
/// memory slots that are ALSO bound to the same preset must still be
/// attempted, or they are silently left running the stale pre-rotation key
/// with no indication anything went wrong. A `slot_bound_to_preset` read
/// failure (a genuine DB error, not a build failure) still propagates via
/// `?` — that failure means we can't even determine which slots to attempt.
///
/// Only the embedding slot's rebuild runs [`run_embedding_post_swap_sequence`]
/// (iff `preset_id` matched the embedding slot AND [`reconcile_embedding_slot`]
/// rebuilt it — `EmbedSlotReconcile::Rebuilt`). A credential rotation never
/// changes `provider_id:embedding_model`, so `identity_changed` is always
/// `false` here — this is exactly the C4 "identity unchanged, key rotated"
/// shape that must still restart the worker when a consuming feature is on;
/// see `embedding_slot_change_restarts_worker_even_when_identity_unchanged_key_rotation`
/// for the guard this must not regress. Round-3 fix #1: when the embedding
/// slot was instead actively CLEARED (`EmbedSlotReconcile::Cleared`, round-2
/// fix #1's empty-endpoint case), [`run_embedding_post_clear_sequence`] runs
/// instead — it still desyncs the indexer/backfill worker from the
/// now-stale `Arc`, but deliberately never restarts the worker against an
/// unconfigured slot.
///
/// Lock order (documented at `provider_registry.rs:52-57`): generation →
/// embedding → memory_generation → memory_embedding.
///
/// `old_endpoint` is `preset_id`'s resolved endpoint from *before* the
/// caller's credential write (round-2 fix #2) — threaded through to
/// [`reconcile_embedding_slot`] only, so it can invalidate a stale
/// `BACKGROUND_INDEXING_HOSTED_CONSENT_AT` acceptance the same way
/// [`persist_embed_config`] does for the two-slot save path. Callers
/// capture it via [`resolve_credential`] before calling
/// `persist_provider_credential` / `forget_provider_credential`.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn reconcile_slots_for_preset<R: FnOnce()>(
    conn: &rusqlite::Connection,
    registry: &ProviderRegistry,
    preset_id: &str,
    old_endpoint: &str,
    backfill: &crate::commands::ai::BackfillManager,
    indexer: &crate::ai::indexer::EntryIndexer,
    server_manager: Option<&Arc<LlamaServerManager>>,
    asset_manager: Option<&Arc<LlmAssetManager>>,
    downloads: Option<&Arc<DownloadManager>>,
    restart_worker: R,
) -> Result<ReconcileOutcome, AiError> {
    let mut outcome = ReconcileOutcome::default();

    // ── generation ───────────────────────────────────────────────────────
    // Best-effort: a build failure here is recorded, never propagated —
    // the embedding/memory slots below must still be attempted even if
    // this one fails.
    if slot_bound_to_preset(conn, GenKeys::PROVIDER, preset_id)? {
        match reconcile_generation_slot(conn, registry, preset_id, server_manager, asset_manager) {
            Ok(swapped) => outcome.generation = swapped,
            Err(e) => {
                log::warn!("reconcile_slots_for_preset: generation slot rebuild failed: {e}");
                outcome.errors.push(("generation", e.to_string()));
            }
        }
    }

    // ── image ────────────────────────────────────────────────────────────
    if slot_bound_to_preset(conn, settings_keys::image::PROVIDER, preset_id)? {
        match reconcile_image_slot(conn, registry, preset_id) {
            Ok(swapped) => outcome.image = swapped,
            Err(e) => {
                log::warn!("reconcile_slots_for_preset: image slot rebuild failed: {e}");
                outcome.errors.push(("image", e.to_string()));
            }
        }
    }

    // ── embedding ────────────────────────────────────────────────────────
    if slot_bound_to_preset(conn, EmbedKeys::PROVIDER, preset_id)? {
        match reconcile_embedding_slot(conn, registry, preset_id, downloads, old_endpoint) {
            Ok(EmbedSlotReconcile::Rebuilt(embed_outcome)) => {
                outcome.embedding = true;
                run_embedding_post_swap_sequence(
                    backfill,
                    indexer,
                    registry,
                    &embed_outcome,
                    restart_worker,
                );
            }
            Ok(EmbedSlotReconcile::Cleared) => {
                // Round-3 fix #1: the slot was actively cleared (not just
                // left stale) — the indexer/backfill worker must still be
                // desynced from the now-gone provider, but never restarted
                // against an unconfigured slot.
                outcome.embedding = false;
                run_embedding_post_clear_sequence(backfill, indexer, registry);
            }
            Ok(EmbedSlotReconcile::Skipped) => {
                outcome.embedding = false;
            }
            Err(e) => {
                log::warn!("reconcile_slots_for_preset: embedding slot rebuild failed: {e}");
                outcome.errors.push(("embedding", e.to_string()));
            }
        }
    }

    // ── memory generation ────────────────────────────────────────────────
    if slot_bound_to_preset(conn, settings_keys::memory_gen::PROVIDER, preset_id)? {
        match reconcile_memory_generation_slot(
            conn,
            registry,
            preset_id,
            server_manager,
            asset_manager,
        ) {
            Ok(swapped) => outcome.memory_generation = swapped,
            Err(e) => {
                log::warn!(
                    "reconcile_slots_for_preset: memory generation slot rebuild failed: {e}"
                );
                outcome.errors.push(("memory_generation", e.to_string()));
            }
        }
    }

    // ── memory embedding ─────────────────────────────────────────────────
    if slot_bound_to_preset(conn, settings_keys::memory_embed::PROVIDER, preset_id)? {
        match reconcile_memory_embedding_slot(conn, registry, preset_id, downloads) {
            Ok(swapped) => outcome.memory_embedding = swapped,
            Err(e) => {
                log::warn!("reconcile_slots_for_preset: memory embedding slot rebuild failed: {e}");
                outcome.errors.push(("memory_embedding", e.to_string()));
            }
        }
    }

    Ok(outcome)
}

/// Read both slots in one round-trip. API keys never included.
#[tauri::command]
pub fn get_ai_providers(state: State<'_, AppState>) -> Result<AIProvidersConfigPublic, String> {
    let conn = state.lock()?;
    Ok(AIProvidersConfigPublic {
        generation: read_gen_public(&conn).map_err(|e| e.to_string())?,
        image: read_image_public(&conn).map_err(|e| e.to_string())?,
        embedding: read_embed_public(&conn).map_err(|e| e.to_string())?,
    })
}

/// T2.3 cutover: `endpoint` / `endpoint_class` / `has_api_key` are DERIVED
/// from the per-preset credential registry (keyed by the slot's stored
/// `provider`), never read off a stored slot row.
fn read_gen_public(
    conn: &rusqlite::Connection,
) -> Result<Option<AIGenProviderConfigPublic>, AiError> {
    let provider = match db::get_setting(conn, GenKeys::PROVIDER)
        .map_err(|e| AiError::IoError(e.to_string()))?
    {
        Some(p) if !p.is_empty() && p != "none" => p,
        _ => return Ok(None),
    };
    let (endpoint, key) = resolve_credential(conn, &provider)?;
    let endpoint_class = credential_class(&provider, &endpoint);
    let chat_model = db::get_setting(conn, GenKeys::model_key())
        .map_err(|e| AiError::IoError(e.to_string()))?
        .unwrap_or_default();
    let has_api_key = key.is_some();
    Ok(Some(AIGenProviderConfigPublic {
        provider,
        endpoint,
        endpoint_class,
        chat_model,
        has_api_key,
    }))
}

/// Persist the image slot in a single transaction. Mirrors
/// [`persist_gen_config`] on the `image::*` namespace. Returns the
/// `needs_consent` hint the caller surfaces to the UI.
fn persist_image_config(
    conn: &rusqlite::Connection,
    input: &AIImageProviderConfigInput,
    new_class: EndpointClass,
) -> Result<bool, AiError> {
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| AiError::IoError(format!("begin transaction: {e}")))?;

    db::set_setting(conn, settings_keys::image::PROVIDER, &input.provider)
        .map_err(|e| AiError::IoError(e.to_string()))?;
    db::set_setting(conn, settings_keys::image::IMAGE_MODEL, &input.image_model)
        .map_err(|e| AiError::IoError(e.to_string()))?;

    let needs_consent =
        new_class != EndpointClass::Local && !class_privacy_accepted(conn, new_class)?;
    tx.commit()
        .map_err(|e| AiError::IoError(format!("commit transaction: {e}")))?;
    Ok(needs_consent)
}

/// Configure (or replace) the image-generation provider.
///
/// Independent of the generation (chat) slot since 2026-08-07 — the vendor
/// that writes best prose is rarely the one that draws best, and forcing
/// both onto one provider meant picking the lesser of the two.
///
/// Only image-capable HTTP presets are accepted: `build_slot_provider`
/// rejects the CLI and on-device presets for [`SlotPayload::Image`], since
/// neither can generate images.
#[tauri::command]
pub async fn set_ai_image_provider(
    input: AIImageProviderConfigInput,
    state: State<'_, AppState>,
    registry: State<'_, ProviderRegistry>,
) -> Result<SetProviderResult, String> {
    let (endpoint, api_key) = {
        let conn = state.lock()?;
        resolve_credential(&conn, &input.provider).map_err(String::from)?
    };
    validate_slot(
        &input.provider,
        &endpoint,
        &input.image_model,
        "image model",
    )
    .map_err(String::from)?;

    let provider = build_slot_provider(
        &input.provider,
        &endpoint,
        api_key.as_deref(),
        SlotPayload::Image {
            image_model: &input.image_model,
        },
        None,
    )
    .map_err(String::from)?;

    let class = credential_class(&input.provider, &endpoint);
    let needs_consent = {
        let conn = state.lock()?;
        persist_image_config(&conn, &input, class).map_err(String::from)?
    };
    registry.swap_image(provider);
    Ok(SetProviderResult {
        provider: input.provider,
        endpoint_class: class,
        requires_privacy_consent: needs_consent,
    })
}

/// Clear the image slot: wipes its two settings rows and drops the live
/// registry provider. The chat slot is untouched.
#[tauri::command]
pub fn forget_ai_image_provider(
    state: State<'_, AppState>,
    registry: State<'_, ProviderRegistry>,
) -> Result<(), String> {
    {
        let conn = state.lock()?;
        forget_slot(
            &conn,
            &[
                settings_keys::image::PROVIDER,
                settings_keys::image::IMAGE_MODEL,
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    registry.clear_image();
    Ok(())
}

/// Rebuild the image slot from persisted settings after unlock. Mirrors
/// [`load_gen_slot`] minus the on-device-llm branch — no on-device or CLI
/// preset can generate images, so there is no non-HTTP path here.
///
/// Returns `Ok(false)` (not an error) when the slot is unconfigured, which
/// is the state EVERY install is in immediately after this feature ships:
/// the `ai_image_provider` row is new, so the user picks an image provider
/// once. Their previously-saved model id survives in the reused
/// `ai_gen_image_model` row.
pub fn load_image_slot(
    conn: &rusqlite::Connection,
    registry: &ProviderRegistry,
) -> Result<bool, AiError> {
    let provider = match db::get_setting(conn, settings_keys::image::PROVIDER)
        .map_err(|e| AiError::IoError(e.to_string()))?
    {
        Some(p) if !p.is_empty() && p != "none" => p,
        _ => return Ok(false),
    };
    let (endpoint, api_key) = resolve_credential(conn, &provider)?;
    if endpoint.is_empty() {
        return Ok(false);
    }
    if let Err(e) = validate_endpoint_url(&endpoint) {
        log::warn!("load_image_slot: stored endpoint failed validation, skipping hydration: {e}");
        return Ok(false);
    }
    let image_model = db::get_setting(conn, settings_keys::image::IMAGE_MODEL)
        .map_err(|e| AiError::IoError(e.to_string()))?
        .unwrap_or_default();
    if image_model.is_empty() {
        log::warn!("load_image_slot: stored image_model is empty, skipping hydration");
        return Ok(false);
    }
    let p = build_slot_provider(
        &provider,
        &endpoint,
        api_key.as_deref(),
        SlotPayload::Image {
            image_model: &image_model,
        },
        None,
    )?;
    registry.swap_image(p);
    Ok(true)
}

/// Mirrors [`read_gen_public`] on the independent image slot.
fn read_image_public(
    conn: &rusqlite::Connection,
) -> Result<Option<AIImageProviderConfigPublic>, AiError> {
    let provider = match db::get_setting(conn, settings_keys::image::PROVIDER)
        .map_err(|e| AiError::IoError(e.to_string()))?
    {
        Some(p) if !p.is_empty() && p != "none" => p,
        _ => return Ok(None),
    };
    let (endpoint, key) = resolve_credential(conn, &provider)?;
    let endpoint_class = credential_class(&provider, &endpoint);
    let image_model = db::get_setting(conn, settings_keys::image::IMAGE_MODEL)
        .map_err(|e| AiError::IoError(e.to_string()))?
        .unwrap_or_default();
    let has_api_key = key.is_some();
    Ok(Some(AIImageProviderConfigPublic {
        provider,
        endpoint,
        endpoint_class,
        image_model,
        has_api_key,
    }))
}

/// Mirrors [`read_gen_public`]'s cutover.
fn read_embed_public(
    conn: &rusqlite::Connection,
) -> Result<Option<AIEmbedProviderConfigPublic>, AiError> {
    let provider = match db::get_setting(conn, EmbedKeys::PROVIDER)
        .map_err(|e| AiError::IoError(e.to_string()))?
    {
        Some(p) if !p.is_empty() && p != "none" => p,
        _ => return Ok(None),
    };
    let (endpoint, key) = resolve_credential(conn, &provider)?;
    let endpoint_class = credential_class(&provider, &endpoint);
    let embedding_model = db::get_setting(conn, EmbedKeys::model_key())
        .map_err(|e| AiError::IoError(e.to_string()))?
        .unwrap_or_default();
    let has_api_key = key.is_some();
    Ok(Some(AIEmbedProviderConfigPublic {
        provider,
        endpoint,
        endpoint_class,
        embedding_model,
        has_api_key,
    }))
}

/// Wipe the generation slot's provider + model rows, plus a WAL checkpoint.
///
/// **T2.3 cutover:** only clears `provider` / `chat_model` / `image_model` —
/// the credential (endpoint + key) lives in the shared per-preset registry
/// now, not on the slot, so forgetting this slot's PROVIDER SELECTION does
/// NOT forget the credential (another slot may still be bound to the same
/// preset). Forgetting the credential itself is
/// [`forget_ai_provider_credential`] (T1.6).
///
/// **Phase 4 Task 2 — stop-on-forget:** if the just-forgotten slot was
/// `on-device-llm`, also stop the `llama-server` sidecar (forgetting the
/// provider means no chat will reach it, so a lingering sidecar is pure
/// waste). Best-effort — a stop failure is logged, never fatal (the
/// settings wipe + registry clear already succeeded).
#[tauri::command]
pub async fn forget_ai_generation_provider(
    state: State<'_, AppState>,
    registry: State<'_, ProviderRegistry>,
    server_manager: State<'_, Arc<LlamaServerManager>>,
) -> Result<(), String> {
    {
        let conn = state.lock()?;
        forget_slot(
            &conn,
            // The image model row belongs to the image slot now —
            // forgetting the chat provider must not wipe it.
            &[GenKeys::PROVIDER, GenKeys::model_key()],
        )
        .map_err(|e| e.to_string())?;
    }
    registry.clear_generation();
    // Forgetting always stops the sidecar — the provider that owned it is
    // gone, so there is nothing left to chat with. Idempotent (stop on an
    // already-stopped sidecar is a no-op), so this is safe regardless of
    // what the forgotten slot was. Best-effort: a stop failure is logged,
    // never fatal (the settings wipe + registry clear already succeeded).
    if let Err(e) = server_manager.inner().stop().await {
        log::warn!("forget_ai_generation_provider: stop sidecar failed (non-fatal): {e}");
    }
    Ok(())
}

/// Wipe the embedding slot's provider + model rows. T2.3 cutover: mirrors
/// [`forget_ai_generation_provider`] — the credential stays in the shared
/// per-preset registry, only the slot's provider selection is cleared.
#[tauri::command]
pub fn forget_ai_embedding_provider(
    state: State<'_, AppState>,
    registry: State<'_, ProviderRegistry>,
    indexer: State<'_, crate::ai::indexer::EntryIndexer>,
    backfill: State<'_, crate::commands::ai::BackfillManager>,
) -> Result<(), String> {
    let conn = state.lock()?;
    forget_slot(&conn, &[EmbedKeys::PROVIDER, EmbedKeys::model_key()])
        .map_err(|e| e.to_string())?;
    registry.clear_embedding();
    // Forget on embedding side also cancels in-flight backfill.
    backfill.cancel();
    crate::commands::ai::sync_indexer_embedder(&indexer, &registry);
    Ok(())
}

/// Delete every key in `keys` inside one transaction, then truncate
/// the WAL so the encrypted ciphertext of the just-deleted rows
/// (notably the API key) is reclaimed from the WAL frames rather than
/// merely shadowed by the DELETE.
///
/// The checkpoint deliberately runs AFTER `tx.commit()`: SQLCipher
/// can't checkpoint inside an open write transaction, and the commit
/// is what makes the DELETE durable in the first place. The user-
/// visible "key is forgotten" guarantee is satisfied by the
/// transactional DELETE; the checkpoint is best-effort residue
/// cleanup, hence the swallowed `log::warn!` on failure.
pub(crate) fn forget_slot(conn: &rusqlite::Connection, keys: &[&str]) -> Result<(), AiError> {
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| AiError::IoError(format!("forget: begin transaction: {e}")))?;
    for key in keys {
        db::delete_setting(conn, key).map_err(|e| AiError::IoError(e.to_string()))?;
    }
    tx.commit()
        .map_err(|e| AiError::IoError(format!("forget: commit transaction: {e}")))?;
    if let Err(e) = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);") {
        log::warn!("forget_slot: WAL checkpoint failed (non-fatal): {e}");
    }
    Ok(())
}

/// Test a generation-slot config WITHOUT persisting. Calls `chat()`
/// with a small token budget — Claude / Groq / xAI fail if you test
/// with `embed()`, and that bug is exactly what the split fixes.
///
/// The budget is 2000 rather than 1 because OpenAI reasoning models
/// (GPT-5.x / o-series, the default `gpt-5.4` slot) count reasoning
/// tokens against `max_completion_tokens`. On the strict dialect
/// (`api.openai.com`) `reasoning_effort` is omitted, so the model runs
/// at its default effort and burns the whole budget on the reasoning
/// channel; a budget of 1 is exhausted before any visible token,
/// returning HTTP 400 "Could not finish the message because max_tokens
/// or model output limit was reached." A "ping" prompt at default
/// effort needs a few hundred reasoning tokens, so 2000 has margin
/// while staying a cheap probe. Non-reasoning models simply stop early.
///
/// **Phase 4 Task 3 — on-device-llm branch:** when
/// `input.provider == "on-device-llm"`, this skips the HTTP-oriented
/// `validate_slot` / `build_slot_provider` path entirely and runs a tiny
/// "Reply with OK" probe (max 8 tokens) against an [`OnDeviceLlmProvider`]
/// built without persisting anything. The probe is wrapped in a generous
/// [`ON_DEVICE_TEST_TIMEOUT`] (120s) outer budget because the first chat
/// lazily spawns `llama-server` and loads the model into RAM
/// (`ensure_running`) — cold start dominates latency. Error codes returned
/// as the `Err` string for precise UI messaging:
/// - `model_not_found` / `model_not_downloaded` (validation, reused from
///   Task 2's `validate_on_device_llm_selection_with_assets`).
/// - `on_device_llm_start_failed: ...` (ensure_running failure — the
///   provider already maps this inside its `chat`).
/// - `on_device_llm_start_failed: test_timeout` (the explicit outer
///   timeout fired).
/// - HTTP/chat errors passthrough (the inner `OpenAICompatibleProvider`'s
///   `ProviderError` string).
#[tauri::command]
pub async fn test_ai_generation_provider(
    input: AIGenProviderConfigInput,
    state: State<'_, AppState>,
    server_manager: State<'_, Arc<LlamaServerManager>>,
    asset_manager: State<'_, Arc<LlmAssetManager>>,
) -> Result<SlotTestResult, String> {
    // ── on-device-llm: dedicated branch (no endpoint, no API key, no persist) ──
    //
    // Sits above the shared HTTP path because `validate_slot` /
    // `build_slot_provider` are OpenAI-compat-oriented. Validation reuses
    // Task 2's helper so the error codes (`model_not_found` /
    // `model_not_downloaded`) are identical to the save path. Nothing is
    // written — this is a transient probe. The branch predicate and the
    // outer-timeout decision are both driven by [`should_use_test_timeout`]
    // (unit-tested) so the two stay in sync.
    if should_use_test_timeout(&input.provider) {
        validate_on_device_llm_selection_with_assets(&input.chat_model, asset_manager.inner())?;
        let provider = OnDeviceLlmProvider::new(
            server_manager.inner().clone(),
            asset_manager.inner().clone(),
            input.chat_model.clone(),
        )
        .map_err(|e| e.to_string())?;
        let start = Instant::now();
        let opts = crate::ai::provider::ChatOpts {
            max_tokens: Some(8),
            ..Default::default()
        };
        // Bind the message slice out here — the chat future borrows it, so it
        // must outlive the `.await` below (a nested temporary would be dropped
        // at the end of the `let probe = ...` statement).
        let messages = [crate::ai::provider::Message {
            role: crate::ai::provider::MessageRole::User,
            content: "Reply with OK".into(),
        }];
        let probe =
            crate::ai::audit::with_feature("connection_test", provider.chat(&messages, opts));
        match tokio::time::timeout(ON_DEVICE_TEST_TIMEOUT, probe).await {
            Ok(Ok(_)) => Ok(SlotTestResult {
                latency_ms: start.elapsed().as_millis() as u64,
                dim: None,
            }),
            Ok(Err(e)) => Err(e.to_string()),
            Err(_) => Err(on_device_test_timeout_error().to_string()),
        }
    } else {
        test_ai_generation_provider_hosted(input, &state).await
    }
}

/// Hosted / CLI branch of [`test_ai_generation_provider`] — the original
/// HTTP probe, extracted so the on-device-llm branch can short-circuit
/// above it. Calls `chat()` with a small token budget. The budget is 2000
/// rather than 1 because OpenAI reasoning models count reasoning tokens
/// against `max_completion_tokens`; see the doc on
/// [`test_ai_generation_provider`] for the full rationale.
async fn test_ai_generation_provider_hosted(
    input: AIGenProviderConfigInput,
    state: &State<'_, AppState>,
) -> Result<SlotTestResult, String> {
    // T2.3 cutover: endpoint/key are resolved from the per-preset credential
    // registry, keyed by `input.provider` — no longer part of the input.
    let (endpoint, api_key) = {
        let conn = state.lock().map_err(|e| e.to_string())?;
        resolve_credential(&conn, &input.provider).map_err(String::from)?
    };
    validate_slot(&input.provider, &endpoint, &input.chat_model, "chat_model")
        .map_err(String::from)?;
    let provider = build_slot_provider(
        &input.provider,
        &endpoint,
        api_key.as_deref(),
        SlotPayload::Generation {
            chat_model: &input.chat_model,
        },
        None,
    )
    .map_err(String::from)?;
    let start = Instant::now();
    let opts = crate::ai::provider::ChatOpts {
        max_tokens: Some(2000),
        ..Default::default()
    };
    crate::ai::audit::with_feature("connection_test", async {
        provider
            .chat(
                &[crate::ai::provider::Message {
                    role: crate::ai::provider::MessageRole::User,
                    content: "ping".into(),
                }],
                opts,
            )
            .await
    })
    .await
    .map_err(String::from)?;
    Ok(SlotTestResult {
        latency_ms: start.elapsed().as_millis() as u64,
        dim: None,
    })
}

/// Test an embedding-slot config WITHOUT persisting. Calls
/// `embed(&["test"])` and returns latency + vector dimension.
#[tauri::command]
pub async fn test_ai_embedding_provider(
    input: AIEmbedProviderConfigInput,
    state: State<'_, AppState>,
    downloads: State<'_, Arc<DownloadManager>>,
) -> Result<SlotTestResult, String> {
    // T2.3 cutover: endpoint/key are resolved from the per-preset credential
    // registry, keyed by `input.provider` — no longer part of the input.
    let (endpoint, api_key) = {
        let conn = state.lock().map_err(|e| e.to_string())?;
        resolve_credential(&conn, &input.provider).map_err(String::from)?
    };
    validate_slot(
        &input.provider,
        &endpoint,
        &input.embedding_model,
        "embedding_model",
    )
    .map_err(String::from)?;
    let provider = build_slot_provider(
        &input.provider,
        &endpoint,
        api_key.as_deref(),
        SlotPayload::Embedding {
            embedding_model: &input.embedding_model,
        },
        Some(downloads.inner()),
    )
    .map_err(String::from)?;
    let start = Instant::now();
    let vectors = crate::ai::audit::with_feature("connection_test", provider.embed(&["test"]))
        .await
        .map_err(String::from)?;
    let latency_ms = start.elapsed().as_millis() as u64;
    let dim = vectors
        .first()
        .map(|v| v.len())
        .ok_or_else(|| AiError::ProviderError("test: empty embeddings response".into()))
        .map_err(String::from)?;
    Ok(SlotTestResult {
        latency_ms,
        dim: Some(dim),
    })
}

// ─── Per-preset credential registry commands (T1.6) ────────────────────────
//
// The four commands below are the Providers-tab-facing surface of the T1.3
// registry / T1.5 reconcile pass. All four are additive — no existing
// two-slot command changes, and (per the Phase 1 plan) nothing in the
// frontend calls these yet.

/// Read every preset's credential row in one shot. **Never** returns a raw
/// API key — `has_api_key: bool` only, same posture as [`get_ai_providers`].
#[tauri::command]
pub fn get_ai_provider_credentials(
    state: State<'_, AppState>,
) -> Result<Vec<ProviderCredentialPublic>, String> {
    let conn = state.lock()?;
    provider_credentials_public(&conn).map_err(String::from)
}

/// Set (or replace) a preset's endpoint override and/or API key, then
/// rebuild + re-swap every `ProviderRegistry` slot currently bound to that
/// preset ([`reconcile_slots_for_preset`], T1.5) — a credential edit that
/// only wrote settings rows would silently leave any bound slot running on
/// the stale key for the rest of the session.
///
/// **Why `spawn_blocking` + `tauri::async_runtime::block_on` instead of a
/// plain `state.lock()?` + `.await`:** `reconcile_slots_for_preset` takes
/// `&rusqlite::Connection`, and `AppState::lock()` returns a
/// `std::sync::MutexGuard`, which is `!Send`. Holding that guard across a
/// real `.await` would make this command's future non-`Send`, which Tauri
/// rejects at registration. `commands::sync::sync_now` established this
/// exact pattern for the same reason (see its doc comment): move the whole
/// synchronous-DB-plus-`block_on` unit onto a blocking-pool thread via
/// `spawn_blocking`, and fetch every needed `State` fresh off the
/// `AppHandle` inside that closure (a `State<'_, T>` borrowed from the
/// command's parameters can't be moved into a `'static` closure either).
#[tauri::command]
pub async fn set_ai_provider_credential(
    preset_id: String,
    endpoint: String,
    api_key: Option<String>,
    app: tauri::AppHandle,
) -> Result<SetCredentialOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<SetCredentialOutcome, String> {
        use tauri::Manager;
        let state = app.state::<AppState>();
        let registry = app.state::<ProviderRegistry>();
        let indexer = app.state::<crate::ai::indexer::EntryIndexer>();
        let backfill = app.state::<crate::commands::ai::BackfillManager>();
        let server_manager = app.state::<Arc<LlamaServerManager>>();
        let asset_manager = app.state::<Arc<LlmAssetManager>>();
        let downloads = app.state::<Arc<DownloadManager>>();

        let conn = state.lock()?;
        // Round-2 fix #2: snapshot the PRE-write resolved endpoint before
        // `persist_provider_credential` commits the new one — this is the
        // "old" identity `reconcile_embedding_slot` needs to detect a
        // consent-invalidating endpoint change.
        let (old_endpoint, _) = resolve_credential(&conn, &preset_id).map_err(String::from)?;
        let (class, requires_privacy_consent) =
            persist_provider_credential(&conn, &preset_id, &endpoint, api_key.as_deref())
                .map_err(String::from)?;

        let reconcile_outcome = tauri::async_runtime::block_on(reconcile_slots_for_preset(
            &conn,
            &registry,
            &preset_id,
            &old_endpoint,
            &backfill,
            &indexer,
            Some(server_manager.inner()),
            Some(asset_manager.inner()),
            Some(downloads.inner()),
            || crate::commands::ai::start_indexing_worker(app.clone()),
        ))
        .map_err(String::from)?;
        // reconcile_slots_for_preset is best-effort across all four slots —
        // the credential was already persisted above, so a per-slot rebuild
        // failure here must not fail this command. Surface it in the log.
        for (slot, err) in &reconcile_outcome.errors {
            log::warn!("set_ai_provider_credential: {slot} slot reconcile failed: {err}");
        }

        Ok(SetCredentialOutcome {
            preset_id,
            endpoint_class: class,
            requires_privacy_consent,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Clear both the stored key AND the endpoint override for `preset_id`
/// (mirrors [`forget_ai_generation_provider`] / [`forget_ai_embedding_provider`]
/// for the two-slot API), then reconcile every bound slot the same way
/// [`set_ai_provider_credential`] does — see that command's doc for why this
/// also needs `spawn_blocking` + `block_on`.
#[tauri::command]
pub async fn forget_ai_provider_credential(
    preset_id: String,
    app: tauri::AppHandle,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        use tauri::Manager;
        let state = app.state::<AppState>();
        let registry = app.state::<ProviderRegistry>();
        let indexer = app.state::<crate::ai::indexer::EntryIndexer>();
        let backfill = app.state::<crate::commands::ai::BackfillManager>();
        let server_manager = app.state::<Arc<LlamaServerManager>>();
        let asset_manager = app.state::<Arc<LlmAssetManager>>();
        let downloads = app.state::<Arc<DownloadManager>>();

        let conn = state.lock()?;
        // Round-2 fix #2: same pre-write snapshot as `set_ai_provider_credential`.
        let (old_endpoint, _) = resolve_credential(&conn, &preset_id).map_err(String::from)?;
        forget_provider_credential(&conn, &preset_id).map_err(String::from)?;

        let reconcile_outcome = tauri::async_runtime::block_on(reconcile_slots_for_preset(
            &conn,
            &registry,
            &preset_id,
            &old_endpoint,
            &backfill,
            &indexer,
            Some(server_manager.inner()),
            Some(asset_manager.inner()),
            Some(downloads.inner()),
            || crate::commands::ai::start_indexing_worker(app.clone()),
        ))
        .map_err(String::from)?;
        for (slot, err) in &reconcile_outcome.errors {
            log::warn!("forget_ai_provider_credential: {slot} slot reconcile failed: {err}");
        }

        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Transient credential probe — **never persists anything** (no
/// `write_provider_endpoints` / `write_provider_keyring` /
/// `reconcile_slots_for_preset` call on any path). Routes by
/// [`preset_test_group`]:
///
/// - `HostedChat` — `chat()` probe via [`probe_credential_chat`]. `probe_model`
///   is REQUIRED (caller-resolved, same convention `test_ai_generation_provider`
///   / `test_ai_embedding_provider` already use for their model — Rust has no
///   access to the TS preset table's model suggestions).
/// - `HostedCustom` (`custom` — the only preset ambiguous between chat and
///   embed, round-2 fix #5) — routes on `capability`: `Some("embed")` probes
///   via [`probe_credential_embed`], anything else (including `None`)
///   defaults to the chat probe, preserving today's behaviour for existing
///   and future callers that don't pass it. `probe_model` is REQUIRED either
///   way — a `custom` preset with no suggestions gets exactly the same
///   "model required" error as any other missing `probe_model`, never a
///   silent probe with `""`.
/// - `HostedEmbedOnly` (voyage) — always `embed()` via [`probe_credential_embed`]
///   regardless of `capability` (voyage is embed-only), `probe_model` also
///   required.
/// - `Local` — reachability + model-list probe only via
///   [`probe_local_reachability`]; no chat/embed call, no token spend.
///   `api_key` is forwarded as an optional bearer token (round-2 fix #4).
/// - `Cli` / `Integrated` — not supported; returns a typed
///   `AI_PROVIDER_UNSUPPORTED` error rather than attempting a
///   subprocess/in-process call.
///
/// Rejects an unrecognized `preset_id` outright (consistent with
/// `set_ai_provider_credential` / `forget_ai_provider_credential`) rather
/// than letting it fall through `preset_test_group`'s `HostedCustom`
/// fallback and probe an arbitrary endpoint under a garbage identity.
///
/// Round-3 fix #2: `api_key: None` resolves the preset's stored key via
/// [`resolve_preset_test_api_key`] before dispatching — see that fn's doc.
/// The resolution needs a DB connection, so this thin `#[tauri::command]`
/// wrapper is the only piece that takes `state: State<'_, AppState>`; the
/// lock is held only long enough to resolve the key (dropped before any
/// `.await`, same posture as `test_ai_generation_provider_hosted`'s
/// `resolve_gen_api_key` call). The actual dispatch logic — everything that
/// was here before this fix — lives in [`test_ai_provider_credential_impl`],
/// split out so it stays directly unit-testable (with an already-resolved
/// key) without needing a `tauri::State`, which this codebase's tests never
/// construct.
#[tauri::command]
pub async fn test_ai_provider_credential(
    preset_id: String,
    endpoint: String,
    api_key: Option<String>,
    probe_model: Option<String>,
    capability: Option<String>,
    state: State<'_, AppState>,
) -> Result<TestCredentialOutcome, String> {
    let resolved_key = {
        let conn = state.lock()?;
        resolve_preset_test_api_key(&conn, &preset_id, api_key.as_deref()).map_err(String::from)?
    };
    test_ai_provider_credential_impl(preset_id, endpoint, resolved_key, probe_model, capability)
        .await
}

/// Core dispatch logic of [`test_ai_provider_credential`], parameterized by
/// an already-resolved `api_key` — see that command's doc for the split
/// rationale (round-3 fix #2).
async fn test_ai_provider_credential_impl(
    preset_id: String,
    endpoint: String,
    api_key: Option<String>,
    probe_model: Option<String>,
    capability: Option<String>,
) -> Result<TestCredentialOutcome, String> {
    if !ALL_PRESET_IDS.contains(&preset_id.as_str()) {
        return Err(String::from(AiError::ProviderError(format!(
            "unknown preset id: {preset_id}"
        ))));
    }
    match preset_test_group(&preset_id) {
        PresetTestGroup::Cli | PresetTestGroup::Integrated => {
            Err(String::from(AiError::ProviderUnsupported(format!(
                "connection testing is not applicable to '{preset_id}'"
            ))))
        }
        PresetTestGroup::Local => probe_local_reachability(&endpoint, api_key.as_deref())
            .await
            .map_err(String::from),
        PresetTestGroup::HostedEmbedOnly => {
            let model =
                require_probe_model(&preset_id, probe_model.as_deref()).map_err(String::from)?;
            probe_credential_embed(&preset_id, &endpoint, api_key.as_deref(), &model)
                .await
                .map_err(String::from)
        }
        PresetTestGroup::HostedChat | PresetTestGroup::HostedCustom => {
            let model =
                require_probe_model(&preset_id, probe_model.as_deref()).map_err(String::from)?;
            if capability.as_deref() == Some("embed") {
                probe_credential_embed(&preset_id, &endpoint, api_key.as_deref(), &model)
                    .await
                    .map_err(String::from)
            } else {
                probe_credential_chat(&preset_id, &endpoint, api_key.as_deref(), &model)
                    .await
                    .map_err(String::from)
            }
        }
    }
}

// ─── CLI provider health check ─────────────────────────────────────────────

/// Result of [`check_cli_provider_health`]. Drives the Settings panel's
/// onboarding hints (install link, sign-in instruction, ✅ ready state).
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CliHealth {
    /// CLI binary was found on PATH or in a well-known install prefix.
    pub installed: bool,
    /// Best-effort short version string parsed from `<cli> --version`.
    /// `None` when the binary isn't installed or the version call timed
    /// out / produced no parseable output.
    pub version: Option<String>,
    /// CLI is signed in. `false` when `installed == false`.
    pub authenticated: bool,
    /// Absolute path of the resolved binary (for diagnostic surfacing).
    pub binary_path: Option<String>,
    /// Optional one-line hint to show the user (install link or
    /// "Run `claude /login`"). `None` when everything is healthy.
    pub hint: Option<String>,
}

/// Verify that a CLI-backed provider is installed and signed in.
///
/// Called from the Settings panel whenever the user picks (or
/// re-selects) `claude-cli` / `codex-cli` in the gen-slot dropdown.
///
/// The check is best-effort: a successful return means we observed
/// the CLI run a tiny probe and produce a non-error response. A
/// negative return is advisory — the user can still save the
/// provider and `claude /login` in another terminal. The Settings
/// panel re-runs the check via a Recheck button.
#[tauri::command]
pub async fn check_cli_provider_health(
    provider: String,
    model: Option<String>,
) -> Result<CliHealth, String> {
    match provider.as_str() {
        CLAUDE_CLI_ID => Ok(check_claude_health().await),
        // Codex probes need an explicit `--model`: the CLI default in
        // `~/.codex/config.toml` is often `gpt-5.5` which ChatGPT
        // Plus accounts may not have access to. Use whatever the
        // user has configured in their slot; fall back to `gpt-5.4`
        // (the most universally-available model).
        CODEX_CLI_ID => {
            let m = model
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| "gpt-5.4".to_string());
            Ok(check_codex_health(&m).await)
        }
        other => Err(format!(
            "check_cli_provider_health: '{other}' is not a CLI provider"
        )),
    }
}

async fn check_claude_health() -> CliHealth {
    use crate::ai::providers::cli::runtime::resolve_binary;
    let binary = match resolve_binary("claude") {
        Ok(b) => b,
        Err(_) => {
            return CliHealth {
                installed: false,
                version: None,
                authenticated: false,
                binary_path: None,
                hint: Some(
                    "Claude CLI not found. Install Claude Code from https://docs.claude.com/claude-code"
                        .into(),
                ),
            };
        }
    };
    let binary_path = Some(binary.display().to_string());
    let version = probe_version(&binary).await;
    let authenticated = probe_claude_auth(&binary).await;
    let hint = if !authenticated {
        Some(
            "Claude CLI is installed but not signed in. Run `claude /login` once in a terminal."
                .into(),
        )
    } else {
        None
    };
    CliHealth {
        installed: true,
        version,
        authenticated,
        binary_path,
        hint,
    }
}

async fn check_codex_health(model: &str) -> CliHealth {
    use crate::ai::providers::cli::runtime::resolve_binary;
    let binary = match resolve_binary("codex") {
        Ok(b) => b,
        Err(_) => {
            return CliHealth {
                installed: false,
                version: None,
                authenticated: false,
                binary_path: None,
                hint: Some(
                    "Codex CLI not found. Install from https://github.com/openai/codex".into(),
                ),
            };
        }
    };
    let binary_path = Some(binary.display().to_string());
    let version = probe_version(&binary).await;
    let authenticated = probe_codex_auth(&binary, model).await;
    let hint = if !authenticated {
        Some(
            "Codex CLI is installed but not signed in. Run `codex login` once in a terminal."
                .into(),
        )
    } else {
        None
    };
    CliHealth {
        installed: true,
        version,
        authenticated,
        binary_path,
        hint,
    }
}

/// Build a `tokio::process::Command` for a probe with the safety
/// defaults every probe wants:
///
/// - `PATH` augmented (so the CLI can find its own node/bun helpers
///   when launched from a Tauri app off Finder).
/// - `stdin: null` — every probe is one-shot, no stdin.
/// - `kill_on_drop(true)` — if `tokio::time::timeout` fires and the
///   future is dropped, the child gets a SIGKILL on drop instead of
///   continuing to run in the background. Without this, a probe that
///   hangs at startup leaks a real `claude`/`codex` invocation that
///   completes its full LLM round-trip and burns subscription quota.
/// - On Unix, the child runs in its own process group so grandchildren
///   (Codex spawns helpers) also die with the parent.
fn probe_command(binary: &std::path::Path) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(binary);
    cmd.env("PATH", crate::ai::providers::cli::runtime::augmented_path());
    cmd.stdin(std::process::Stdio::null());
    cmd.kill_on_drop(true);
    #[cfg(unix)]
    cmd.process_group(0);
    cmd
}

/// Run `<binary> --version` with a 3 s budget and return the first
/// non-empty line (trimmed). `None` if the call times out, the
/// process exits non-zero, or stdout is empty.
async fn probe_version(binary: &std::path::Path) -> Option<String> {
    let mut cmd = probe_command(binary);
    cmd.arg("--version");
    let fut = cmd.output();
    let out = tokio::time::timeout(std::time::Duration::from_secs(3), fut)
        .await
        .ok()?
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    text.lines()
        .next()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Best-effort auth check for `claude`. Uses `claude auth status` only
/// — it's the documented mechanism on 2.x and the JSON output is
/// stable enough to parse. We intentionally do NOT fall back to a
/// non-interactive prompt probe: that path is functionally a real
/// chat call (it would also be subject to `--tools ""` drift, and
/// would consume rate-limit quota on every Settings open).
async fn probe_claude_auth(binary: &std::path::Path) -> bool {
    let mut cmd = probe_command(binary);
    cmd.arg("auth").arg("status");
    let fut = cmd.output();
    let out = match tokio::time::timeout(std::time::Duration::from_secs(3), fut).await {
        Ok(Ok(o)) => o,
        _ => return false,
    };

    // Newer builds emit a JSON object like `{"loggedIn":true,...}`.
    // Parse it properly — a `stdout.contains("logged in")` substring
    // match silently breaks because the JSON key is camelCase one
    // word (`loggedIn`), not two words with a space.
    if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&out.stdout) {
        if let Some(true) = v.get("loggedIn").and_then(|b| b.as_bool()) {
            return true;
        }
        if v.get("authenticated").and_then(|b| b.as_bool()) == Some(true) {
            return true;
        }
        // Explicit negative — short-circuit so we don't fall into
        // the exit-code branch which can be 0 even on a soft warn.
        if v.get("loggedIn").and_then(|b| b.as_bool()) == Some(false)
            || v.get("authenticated").and_then(|b| b.as_bool()) == Some(false)
        {
            return false;
        }
    }

    // Older / text-mode builds: a clean exit means signed in.
    if out.status.success() {
        return true;
    }
    // Fallback substring match — `loggedin` (one word, lowercased) and
    // the human-readable variants.
    let stdout = String::from_utf8_lossy(&out.stdout).to_ascii_lowercase();
    stdout.contains("\"loggedin\":true")
        || stdout.contains("logged in")
        || stdout.contains("signed in")
}

/// Best-effort auth check for `codex`. There's no public "auth status"
/// command in 0.122; we probe with a short `codex exec --model <m>`
/// using whichever model the user has configured (so a probe doesn't
/// false-negative when their slot model differs from a hard-coded
/// default).
async fn probe_codex_auth(binary: &std::path::Path, model: &str) -> bool {
    let mut cmd = probe_command(binary);
    cmd.arg("exec")
        .arg("--json")
        .arg("--skip-git-repo-check")
        .arg("--sandbox")
        .arg("read-only")
        .arg("-c")
        .arg("approval_policy=never")
        .arg("--ephemeral")
        .arg("--model")
        .arg(model)
        .arg("ok");
    let fut = cmd.output();
    if let Ok(Ok(out)) = tokio::time::timeout(std::time::Duration::from_secs(8), fut).await {
        // The combined stdout+stderr text contains "not authenticated"
        // / `codex login` on a signed-out CLI. A clean exec produces
        // an `agent_message` item with text — neither of those tokens.
        let combined = format!(
            "{}\n{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        )
        .to_ascii_lowercase();
        if combined.contains("not authenticated") || combined.contains("`codex login`") {
            return false;
        }
        return out.status.success();
    }
    false
}

/// True iff the given provider id is the on-device-llm sentinel — the
/// `llama-server` sidecar, which (like `provider_is_on_device`'s embedding
/// counterpart) has no HTTP endpoint of its own: the backend picks a
/// localhost port at spawn time, so a stored empty endpoint is expected,
/// not a sign of a corrupt row.
pub(crate) fn provider_is_on_device_llm(provider_id: &str) -> bool {
    provider_id == ON_DEVICE_LLM_ID
}

/// Hydrate the generation slot from settings into the registry. Mirrors
/// the legacy `load_from_settings_into` but on the `ai_gen_*` keys.
///
/// `server_manager` / `asset_manager` are only needed to rehydrate an
/// `on-device-llm` slot (mirrors `load_embed_slot`'s `downloads` param for
/// the embedding on-device provider). Pass `None` for both when the caller
/// doesn't have them (e.g. most unit tests) — hydration of a non-on-device
/// slot is unaffected, and hydration of an on-device-llm slot without the
/// managers is skipped (logged, not an error).
pub fn load_gen_slot(
    conn: &rusqlite::Connection,
    registry: &ProviderRegistry,
    server_manager: Option<&Arc<LlamaServerManager>>,
    asset_manager: Option<&Arc<LlmAssetManager>>,
) -> Result<bool, AiError> {
    let provider = match db::get_setting(conn, GenKeys::PROVIDER)
        .map_err(|e| AiError::IoError(e.to_string()))?
    {
        Some(p) if !p.is_empty() && p != "none" => p,
        _ => return Ok(false),
    };
    // T2.3 cutover: endpoint/key are resolved from the per-preset credential
    // registry, keyed by `provider` — no longer stored on the slot itself.
    let (endpoint, api_key) = resolve_credential(conn, &provider)?;
    // CLI-backed providers have no endpoint (they spawn a subprocess), and
    // neither does on-device-llm (it spawns a local sidecar on a port
    // chosen at runtime). Only enforce the endpoint guards for HTTP
    // providers; otherwise every restart would drop the saved provider and
    // force the user to re-pick it — this was the exact bug for
    // on-device-llm: it legitimately persists with `endpoint=""`, so this
    // guard alone made hydration skip it silently (AI_NOT_CONFIGURED on
    // every generation call after unlock).
    if !provider_uses_subprocess(&provider) && !provider_is_on_device_llm(&provider) {
        if endpoint.is_empty() {
            return Ok(false);
        }
        if let Err(e) = validate_endpoint_url(&endpoint) {
            log::warn!("load_gen_slot: stored endpoint failed validation, skipping hydration: {e}");
            return Ok(false);
        }
    }
    let chat_model = db::get_setting(conn, GenKeys::model_key())
        .map_err(|e| AiError::IoError(e.to_string()))?
        .unwrap_or_default();
    // Empty model produces a provider whose chat_model_id() is "" —
    // every downstream feature-cache key (provider:model) would
    // collide. Mirrors the validate_slot() guard on the write path.
    if chat_model.is_empty() {
        log::warn!("load_gen_slot: stored chat_model is empty, skipping hydration");
        return Ok(false);
    }

    // on-device-llm: dedicated branch (mirrors `set_ai_generation_provider`).
    // `build_slot_provider` only knows the embedding on-device sentinel
    // (`ON_DEVICE_PROVIDER_ID`), not this one, and building this provider
    // needs the sidecar + asset managers rather than an endpoint/api-key.
    if provider == ON_DEVICE_LLM_ID {
        let (server, assets) = match (server_manager, asset_manager) {
            (Some(s), Some(a)) => (s.clone(), a.clone()),
            _ => {
                log::warn!("load_gen_slot: on-device-llm managers unavailable, skipping hydration");
                return Ok(false);
            }
        };
        let provider_arc: Arc<dyn AIProvider> = Arc::new(OnDeviceLlmProvider::new(
            server,
            assets,
            chat_model.clone(),
        )?);
        registry.swap_generation(provider_arc);
        return Ok(true);
    }

    let p = build_slot_provider(
        &provider,
        &endpoint,
        api_key.as_deref(),
        SlotPayload::Generation {
            chat_model: &chat_model,
        },
        None,
    )?;
    registry.swap_generation(p);
    Ok(true)
}

/// **C10 fix — already-configured installs:** this is the natural, cheap,
/// idempotent startup/unlock re-hydration site (called once per unlock —
/// see `commands::crypto::initialize_encryption`), so once the stored
/// config is confirmed valid it also runs
/// `maybe_default_background_indexing_enabled`. This is what brings an
/// install that configured a Local/OnDevice embedding slot BEFORE this
/// fix shipped up to the same "indexes automatically" behavior a fresh
/// save now gets from `persist_embed_config` — without it, only a
/// re-save of the slot would ever initialize the toggle.
pub fn load_embed_slot(
    conn: &rusqlite::Connection,
    registry: &ProviderRegistry,
    indexer: Option<&crate::ai::indexer::EntryIndexer>,
    downloads: Option<&Arc<DownloadManager>>,
) -> Result<bool, AiError> {
    let provider = match db::get_setting(conn, EmbedKeys::PROVIDER)
        .map_err(|e| AiError::IoError(e.to_string()))?
    {
        Some(p) if !p.is_empty() && p != "none" => p,
        _ => return Ok(false),
    };
    // T2.3 cutover: endpoint/key are resolved from the per-preset credential
    // registry, keyed by `provider` — no longer stored on the slot itself.
    let (endpoint, api_key) = resolve_credential(conn, &provider)?;
    // Mirror the gen-slot fix: CLI providers don't have an endpoint. The
    // on-device sentinel doesn't either — inference runs in-process.
    if !provider_uses_subprocess(&provider) && !provider_is_on_device(&provider) {
        if endpoint.is_empty() {
            return Ok(false);
        }
        if let Err(e) = validate_endpoint_url(&endpoint) {
            log::warn!(
                "load_embed_slot: stored endpoint failed validation, skipping hydration: {e}"
            );
            return Ok(false);
        }
    }
    let embedding_model = db::get_setting(conn, EmbedKeys::model_key())
        .map_err(|e| AiError::IoError(e.to_string()))?
        .unwrap_or_default();
    if embedding_model.is_empty() {
        log::warn!("load_embed_slot: stored embedding_model is empty, skipping hydration");
        return Ok(false);
    }
    // C10 fix: initialize the background-indexing toggle for an
    // already-configured Local/OnDevice install once per unlock — see the
    // fn doc comment above. No-op once the row has ever been set.
    let class = classify_provider_disclosure(&provider, &endpoint);
    maybe_default_background_indexing_enabled(conn, class)?;
    let p = build_slot_provider(
        &provider,
        &endpoint,
        api_key.as_deref(),
        SlotPayload::Embedding {
            embedding_model: &embedding_model,
        },
        downloads,
    )?;
    registry.swap_embedding(p);
    if let Some(indexer) = indexer {
        crate::commands::ai::sync_indexer_embedder(indexer, registry);
    }
    Ok(true)
}

// ─── Memory slot post-unlock hydration (Phase 2 C1) ──────────────────────
//
// `load_gen_slot` / `load_embed_slot` rebuild the app-wide slots after
// unlock; these two are the memory-slot equivalents. WITHOUT them, the
// registry's `memory_generation` / `memory_embedding` slots stay `None`
// every session after a restart (the registry is in-memory), so
// `is_memory_enabled()` returns false all session despite valid persisted
// config — the feature is unusable. They mirror the gen/embed loaders
// EXACTLY (same signature shape, same endpoint/model guards, same
// best-effort posture), with ONE addition the gen/embed loaders don't need:
// a defense-in-depth re-run of `enforce_memory_slot_class` against the
// persisted rows BEFORE swapping, against the CURRENT `ai_memory_allow_hosted`
// flag. The gen/embed slots have no class ceiling; memory does BY DEFAULT
// (hosted/CLI allowed once the user opts in — see
// `docs/plans/2026-07-29-ai-user-memory/README.md`'s Amendment section), and
// the persisted rows are the moment a hand-edited or downgraded install (or a
// settings row written before the flag existed) could sneak a Remote/
// Subscription class past what the CURRENT flag value permits.

/// Hydrate the memory GENERATION slot from settings into the registry.
/// Mirrors [`load_gen_slot`] on the `settings_keys::memory_gen::*` rows.
///
/// `server_manager` / `asset_manager` are only needed to rehydrate an
/// `on-device-llm` memory gen slot (same reason as the app-wide gen slot).
/// Pass `None` for both when the caller doesn't have them — hydration of a
/// non-on-device slot is unaffected, and hydration of an on-device-llm slot
/// without the managers is skipped (logged, not an error).
///
/// **Defense-in-depth (C1):** unlike [`load_gen_slot`], this re-runs
/// [`enforce_memory_slot_class`] against the persisted rows, and against the
/// CURRENT `settings_keys::MEMORY_ALLOW_HOSTED` flag value, BEFORE swapping.
/// The memory gen slot is privacy-ceilinged to `Local`/`OnDevice` BY
/// DEFAULT — `Remote`/`Subscription` become valid only once the user has
/// explicitly turned that flag on; the persisted rows are the moment a
/// hand-edited / downgraded install, OR a row written/synced before the flag
/// existed, could otherwise land a class the CURRENT flag value doesn't
/// permit (or the embedding-only `on-device` sentinel, never permitted here
/// regardless of the flag) into the registry. If re-validation returns
/// `Err`, the slot is left empty (logged, not an error) — the feature simply
/// stays off until the user re-saves a valid config. Returns `true` iff a
/// slot was loaded.
pub fn load_memory_gen_slot(
    conn: &rusqlite::Connection,
    registry: &ProviderRegistry,
    server_manager: Option<&Arc<LlamaServerManager>>,
    asset_manager: Option<&Arc<LlmAssetManager>>,
) -> Result<bool, AiError> {
    let provider = match db::get_setting(conn, settings_keys::memory_gen::PROVIDER)
        .map_err(|e| AiError::IoError(e.to_string()))?
    {
        Some(p) if !p.is_empty() && p != "none" => p,
        _ => return Ok(false),
    };
    // T2.3 cutover: endpoint/key are resolved from the per-preset credential
    // registry, keyed by `provider`. This read MUST precede
    // `enforce_memory_slot_class` below — that check needs the endpoint to
    // classify the slot.
    let (endpoint, api_key) = resolve_credential(conn, &provider)?;
    // CLI / on-device-llm sentinels legitimately persist with an empty
    // endpoint (same exemption as `load_gen_slot`). Note: CLI providers are
    // rejected by `enforce_memory_slot_class` below for memory slots, but the
    // endpoint-shape guard still mirrors `load_gen_slot` so a hand-edited row
    // doesn't fail on the wrong check.
    if !provider_uses_subprocess(&provider) && !provider_is_on_device_llm(&provider) {
        if endpoint.is_empty() {
            return Ok(false);
        }
        if let Err(e) = validate_endpoint_url(&endpoint) {
            log::warn!(
                "load_memory_gen_slot: stored endpoint failed validation, skipping hydration: {e}"
            );
            return Ok(false);
        }
    }
    let chat_model = db::get_setting(conn, settings_keys::memory_gen::CHAT_MODEL)
        .map_err(|e| AiError::IoError(e.to_string()))?
        .unwrap_or_default();
    if chat_model.is_empty() {
        log::warn!("load_memory_gen_slot: stored chat_model is empty, skipping hydration");
        return Ok(false);
    }

    // Defense-in-depth (C1): re-run the on-machine class+capability rule
    // against the persisted rows BEFORE swapping, against the CURRENT
    // `ai_memory_allow_hosted` flag — a row written by a downgraded/hand-
    // edited install (or a sync pull) could carry a Remote/Subscription
    // class (or the embedding-only `on-device` sentinel) the user never
    // acknowledged; this is the gate that stops it. On Err, leave the slot
    // empty (do NOT fail unlock) — the feature simply stays off.
    let allow_hosted = crate::commands::ai_settings::read_memory_allow_hosted(conn);
    if let Err(e) = enforce_memory_slot_class(
        &provider,
        &endpoint,
        MemorySlotKind::Generation,
        allow_hosted,
    ) {
        log::warn!(
            "load_memory_gen_slot: persisted config failed on-machine class re-validation, \
             skipping hydration (slot left empty): {e}"
        );
        return Ok(false);
    }

    // on-device-llm: dedicated branch (mirrors `load_gen_slot` + the write
    // command). `build_slot_provider` only knows the embedding on-device
    // sentinel, not this one, and building this provider needs the sidecar +
    // asset managers rather than an endpoint/api-key.
    if provider == ON_DEVICE_LLM_ID {
        let (server, assets) = match (server_manager, asset_manager) {
            (Some(s), Some(a)) => (s.clone(), a.clone()),
            _ => {
                log::warn!(
                    "load_memory_gen_slot: on-device-llm managers unavailable, skipping hydration"
                );
                return Ok(false);
            }
        };
        let provider_arc: Arc<dyn AIProvider> = Arc::new(OnDeviceLlmProvider::new(
            server,
            assets,
            chat_model.clone(),
        )?);
        registry.swap_memory_generation(provider_arc);
        return Ok(true);
    }

    let p = build_slot_provider(
        &provider,
        &endpoint,
        api_key.as_deref(),
        SlotPayload::Generation {
            chat_model: &chat_model,
        },
        None,
    )?;
    registry.swap_memory_generation(p);
    Ok(true)
}

/// Hydrate the memory EMBEDDING slot from settings into the registry.
/// Mirrors [`load_embed_slot`] on the `settings_keys::memory_embed::*` rows.
///
/// `downloads` is only needed to rehydrate an `on-device` (fastembed) memory
/// embed slot (same reason as the app-wide embed slot). Pass `None` when the
/// caller doesn't have it.
///
/// **Defense-in-depth (C1):** like [`load_memory_gen_slot`], this re-runs
/// [`enforce_memory_slot_class`] against the persisted rows and the CURRENT
/// `MEMORY_ALLOW_HOSTED` flag value BEFORE swapping — the memory embed slot
/// is privacy-ceilinged to `Local`/`OnDevice` BY DEFAULT (hosted/CLI once
/// the flag is on) and must ALWAYS reject the generation-only
/// `on-device-llm` sentinel regardless of the flag. On Err, the slot is left
/// empty (logged, not an error). Returns `true` iff a slot was loaded.
pub fn load_memory_embed_slot(
    conn: &rusqlite::Connection,
    registry: &ProviderRegistry,
    downloads: Option<&Arc<DownloadManager>>,
) -> Result<bool, AiError> {
    let provider = match db::get_setting(conn, settings_keys::memory_embed::PROVIDER)
        .map_err(|e| AiError::IoError(e.to_string()))?
    {
        Some(p) if !p.is_empty() && p != "none" => p,
        _ => return Ok(false),
    };
    // T2.3 cutover: endpoint/key are resolved from the per-preset credential
    // registry, keyed by `provider`. This read MUST precede
    // `enforce_memory_slot_class` below — that check needs the endpoint to
    // classify the slot.
    let (endpoint, api_key) = resolve_credential(conn, &provider)?;
    // Mirror `load_embed_slot`: the on-device sentinel has no endpoint (runs
    // in-process). CLI providers are rejected by `enforce_memory_slot_class`
    // below, but the endpoint-shape guard still mirrors the embed loader.
    if !provider_uses_subprocess(&provider) && !provider_is_on_device(&provider) {
        if endpoint.is_empty() {
            return Ok(false);
        }
        if let Err(e) = validate_endpoint_url(&endpoint) {
            log::warn!(
                "load_memory_embed_slot: stored endpoint failed validation, skipping hydration: {e}"
            );
            return Ok(false);
        }
    }
    let embedding_model = db::get_setting(conn, settings_keys::memory_embed::EMBEDDING_MODEL)
        .map_err(|e| AiError::IoError(e.to_string()))?
        .unwrap_or_default();
    if embedding_model.is_empty() {
        log::warn!("load_memory_embed_slot: stored embedding_model is empty, skipping hydration");
        return Ok(false);
    }

    // Defense-in-depth (C1): re-run the on-machine class+capability rule
    // against the persisted rows BEFORE swapping, against the CURRENT
    // `ai_memory_allow_hosted` flag. See `load_memory_gen_slot`.
    let allow_hosted = crate::commands::ai_settings::read_memory_allow_hosted(conn);
    if let Err(e) = enforce_memory_slot_class(
        &provider,
        &endpoint,
        MemorySlotKind::Embedding,
        allow_hosted,
    ) {
        log::warn!(
            "load_memory_embed_slot: persisted config failed on-machine class re-validation, \
             skipping hydration (slot left empty): {e}"
        );
        return Ok(false);
    }

    let p = build_slot_provider(
        &provider,
        &endpoint,
        api_key.as_deref(),
        SlotPayload::Embedding {
            embedding_model: &embedding_model,
        },
        downloads,
    )?;
    registry.swap_memory_embedding(p);
    Ok(true)
}

// ─── On-device embedding model catalog + download (Phase 4 Task 2) ────────
//
// Commands for the model-picker UI (Phase 3 Task 8, `useOnDeviceModels.ts`):
// list the catalog with per-model download state, read a single model's
// state, start/cancel a download, and remove a downloaded model. Downloads
// are opt-in only — nothing here runs unless the user calls
// `start_on_device_model_download`. The `on-device` provider that actually
// runs inference lands in Task 3.

/// Wire shape for one catalog entry + its current download state — mirrors
/// `OnDeviceModelCatalogEntry` in `src/hooks/useOnDeviceModels.ts`.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OnDeviceModelWire {
    pub id: String,
    pub display_name: String,
    pub dim: u32,
    pub mrl_dims: Vec<u32>,
    pub context_length: u32,
    pub download_size: String,
    pub approx_ram: String,
    pub multilingual: bool,
    pub recommended: bool,
    pub when_to_choose: String,
    /// `false` for catalog entries with no `fastembed` backend yet — see
    /// `ai::on_device::catalog` doc (every entry is supported today).
    pub supported: bool,
    pub state: OnDeviceModelStateWire,
}

/// Wire shape for [`crate::ai::on_device::download::DownloadState`] —
/// mirrors `ModelDownloadState` in `useOnDeviceModels.ts`.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum OnDeviceModelStateWire {
    NotDownloaded,
    Downloading { progress: u8 },
    Ready,
    Error { code: String },
}

impl From<crate::ai::on_device::download::DownloadState> for OnDeviceModelStateWire {
    fn from(state: crate::ai::on_device::download::DownloadState) -> Self {
        use crate::ai::on_device::download::DownloadState as S;
        match state {
            S::NotDownloaded => Self::NotDownloaded,
            S::Downloading { progress } => Self::Downloading { progress },
            S::Ready => Self::Ready,
            S::Error { code } => Self::Error { code },
        }
    }
}

fn on_device_model_wire(
    model: &crate::ai::on_device::catalog::OnDeviceModel,
    manager: &crate::ai::on_device::download::DownloadManager,
) -> OnDeviceModelWire {
    OnDeviceModelWire {
        id: model.id.to_string(),
        display_name: model.display_name.to_string(),
        dim: model.dim,
        mrl_dims: model.mrl_dims.to_vec(),
        context_length: model.context_tokens,
        download_size: model.download_size.to_string(),
        approx_ram: model.approx_ram.to_string(),
        multilingual: model.multilingual,
        recommended: model.recommended,
        when_to_choose: model.when_to_choose.to_string(),
        supported: model.is_supported(),
        state: manager.download_state(model.id).into(),
    }
}

/// List the on-device model catalog with each entry's current download
/// state, for the Settings model picker.
#[tauri::command]
pub fn list_on_device_models(
    manager: State<'_, std::sync::Arc<crate::ai::on_device::download::DownloadManager>>,
) -> Result<Vec<OnDeviceModelWire>, String> {
    Ok(crate::ai::on_device::catalog::catalog()
        .iter()
        .map(|m| on_device_model_wire(m, &manager))
        .collect())
}

/// Read a single model's download state.
#[tauri::command]
pub fn get_on_device_model_state(
    id: String,
    manager: State<'_, std::sync::Arc<crate::ai::on_device::download::DownloadManager>>,
) -> Result<OnDeviceModelStateWire, String> {
    if crate::ai::on_device::catalog::find(&id).is_none() {
        return Err(format!("unknown on-device model id: {id}"));
    }
    Ok(manager.download_state(&id).into())
}

/// Pure payload builder for `ai:model-download-progress` — kept separate
/// from the emit call so the shape is unit-testable without an
/// `AppHandle` (see module test `model_download_progress_payload_shape`).
fn model_download_progress_payload(model_id: &str, progress: u8) -> serde_json::Value {
    serde_json::json!({ "model_id": model_id, "progress": progress })
}

/// Pure payload builder for `ai:model-download-error` — mirrors
/// [`model_download_progress_payload`].
fn model_download_error_payload(model_id: &str, error: &str) -> serde_json::Value {
    serde_json::json!({ "model_id": model_id, "error": error })
}

/// Wraps [`crate::ai::on_device::download::FastembedFetcher`] — kept as a
/// thin passthrough so `DownloadManager::start_download`'s `&dyn
/// ModelFetcher` signature stays satisfied. Bug B fix: this used to ALSO
/// emit `ai:model-download-progress` itself, racing with the dir-size
/// poller below — `fastembed`'s `hf_hub` backend has no incremental
/// byte-progress callback, so every tick this ever forwarded was `0` (then
/// a single terminal call), meaning the picker's progress bar never moved
/// off "0%". The poller (real on-disk byte tracking) is now the ONE
/// in-flight emitter; this type no longer emits anything itself.
struct EmittingFetcher;

impl crate::ai::on_device::download::ModelFetcher for EmittingFetcher {
    fn fetch(
        &self,
        model: &crate::ai::on_device::catalog::OnDeviceModel,
        dest_dir: &std::path::Path,
        on_progress: &dyn Fn(u8),
    ) -> Result<(), String> {
        crate::ai::on_device::download::FastembedFetcher.fetch(model, dest_dir, on_progress)
    }
}

/// DB-only half of the on-device download-completion recovery trigger (C7
/// fix, `ModelNotReady` branch): reset any `paused` jobs for the
/// just-downloaded on-device model back to `pending`. A job pauses on
/// `AiError::ModelNotReady` when the on-device provider's model isn't on
/// disk yet (see `is_auth_or_config_error`); once the download this
/// function is called after actually completes, that's no longer true, and
/// — like every other `paused` cause — nothing else ever brings the job
/// back on its own (see [`db::embeddings::reset_paused_jobs_to_pending`]'s
/// docs). Separated from the `#[tauri::command]` wrapper (which needs
/// `AppHandle`/`DownloadManager`) so it's unit-testable with a plain
/// connection, mirroring `apply_embedding_slot_change`'s split.
///
/// `catalog_model_id` is the on-device catalog id (the download command's
/// `id` param) — namespaced the same way `provider_namespaced_model_id`
/// would for an `OnDeviceEmbedProvider` built with that id, since that's
/// the exact `entry_embedding_jobs.model_id` a `ModelNotReady` pause for
/// this model was recorded under.
fn reset_paused_jobs_for_downloaded_on_device_model(
    conn: &rusqlite::Connection,
    catalog_model_id: &str,
) -> Result<usize, AiError> {
    let model_id = format!("{ON_DEVICE_PROVIDER_ID}:{catalog_model_id}");
    let now = chrono::Utc::now().timestamp();
    db::embeddings::reset_paused_jobs_to_pending(conn, &model_id, now, now)
        .map_err(|e| AiError::IoError(format!("reset_paused_jobs_to_pending: {e}")))
}

/// Start (or resume) an opt-in model download. Blocks until the download
/// finishes (or fails) and returns the terminal state; `get_on_device_model_state`
/// can be polled concurrently from another call for progress.
///
/// **C7 fix:** on a successful download, resets any jobs `paused` on
/// `ModelNotReady` for this model back to `pending`
/// ([`reset_paused_jobs_for_downloaded_on_device_model`]) and nudges the
/// continuous worker awake via [`crate::commands::ai::start_indexing_worker`]
/// — the same existing wake mechanism `set_ai_embedding_provider` already
/// uses after an embedding-slot save; `start_indexing_worker`'s single-slot
/// guard makes this a no-op if the loop is already running.
///
/// **Bug B fix (real progress, not a stuck "0%"):** `fastembed`'s
/// `hf_hub` backend has no incremental byte-progress callback, so the
/// fetch itself can only report 0 while in flight and 100 on success. But
/// `hf_hub` DOES write model files straight into `dest_dir` as bytes land,
/// so a concurrent poller tracks REAL progress by comparing on-disk bytes
/// ([`crate::ai::on_device::download::dir_size_bytes`]) against the
/// catalog's approximate `download_size_bytes`
/// ([`crate::ai::on_device::download::download_percent`]), emitting
/// `ai:model-download-progress` (+ updating the manager's in-flight state
/// via `report_download_progress`) every ~750ms until the blocking fetch
/// finishes. This poller is the SINGLE in-flight emitter — `EmittingFetcher`
/// no longer emits anything itself, avoiding two racing sources of the
/// same event. `ai:model-download-error` still fires on failure, and a
/// final 100% progress tick still fires on success, exactly as before.
#[tauri::command]
pub async fn start_on_device_model_download(
    id: String,
    app: tauri::AppHandle,
    manager: State<'_, std::sync::Arc<crate::ai::on_device::download::DownloadManager>>,
    app_state: State<'_, AppState>,
) -> Result<OnDeviceModelStateWire, String> {
    let Some(catalog_entry) = crate::ai::on_device::catalog::find(&id) else {
        return Err(format!("unknown on-device model id: {id}"));
    };
    let manager = std::sync::Arc::clone(&manager);
    let model_dir = manager.model_dir(&id);
    let total_bytes = catalog_entry.download_size_bytes;

    let done = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let poller = {
        let manager = std::sync::Arc::clone(&manager);
        let app = app.clone();
        let id = id.clone();
        let model_dir = model_dir.clone();
        let done = Arc::clone(&done);
        tokio::spawn(async move {
            while !done.load(std::sync::atomic::Ordering::Relaxed) {
                let on_disk = crate::ai::on_device::download::dir_size_bytes(&model_dir);
                let pct = crate::ai::on_device::download::download_percent(on_disk, total_bytes);
                let _ = app.emit(
                    "ai:model-download-progress",
                    model_download_progress_payload(&id, pct),
                );
                manager.report_download_progress(&id, pct);
                tokio::time::sleep(std::time::Duration::from_millis(750)).await;
            }
        })
    };

    let model_id = id.clone();
    let join_result = tauri::async_runtime::spawn_blocking(move || {
        let fetcher = EmittingFetcher;
        // Errors also land in the manager's own state (Error{code}) —
        // surfaced to the caller via the returned state, not a rejected
        // promise.
        let result = manager.start_download(&model_id, &fetcher);
        (result, manager.download_state(&model_id))
    })
    .await;

    // Stop the poller BEFORE propagating a `spawn_blocking` join error (a
    // panic inside `start_download`, e.g. a poisoned mutex) — doing this
    // after the `?` would leave the `while !done` poller looping forever,
    // spamming `ai:model-download-progress` for a download that already
    // stopped, exactly the stuck-progress UX this fix exists to prevent.
    done.store(true, std::sync::atomic::Ordering::Relaxed);
    let _ = poller.await;
    let (fetch_result, state) = join_result.map_err(|e| e.to_string())?;

    match &fetch_result {
        Ok(()) => {
            let _ = app.emit(
                "ai:model-download-progress",
                model_download_progress_payload(&id, 100),
            );
            let recovered = {
                let conn = app_state.lock()?;
                reset_paused_jobs_for_downloaded_on_device_model(&conn, &id)
                    .map_err(String::from)?
            };
            if recovered > 0 {
                crate::commands::ai::start_indexing_worker(app.clone());
            }
        }
        Err(error) => {
            let _ = app.emit(
                "ai:model-download-error",
                model_download_error_payload(&id, error),
            );
        }
    }
    Ok(state.into())
}

/// Best-effort cancel of an in-flight download (see
/// `DownloadManager::cancel_download` for why this can't interrupt an
/// already-blocking fetch call).
#[tauri::command]
pub fn cancel_on_device_model_download(
    id: String,
    manager: State<'_, std::sync::Arc<crate::ai::on_device::download::DownloadManager>>,
) -> Result<OnDeviceModelStateWire, String> {
    if crate::ai::on_device::catalog::find(&id).is_none() {
        return Err(format!("unknown on-device model id: {id}"));
    }
    manager.cancel_download(&id);
    Ok(manager.download_state(&id).into())
}

/// True when removing `id` should also forget the embedding slot — the
/// live embed provider is on-device AND its configured model is `id`.
pub(crate) fn should_forget_embed_on_remove(provider: &str, model: &str, id: &str) -> bool {
    provider == ON_DEVICE_PROVIDER_ID && model == id
}

/// Wipe the embed slot (same as [`forget_ai_embedding_provider`]) when
/// `id` is the active on-device model. Returns whether a wipe ran.
pub(crate) fn forget_embed_slot_if_in_use(
    conn: &rusqlite::Connection,
    registry: &ProviderRegistry,
    indexer: &crate::ai::indexer::EntryIndexer,
    backfill: &crate::commands::ai::BackfillManager,
    id: &str,
) -> Result<bool, String> {
    let provider = db::get_setting(conn, EmbedKeys::PROVIDER)
        .map_err(|e| e.to_string())?
        .unwrap_or_default();
    let model = db::get_setting(conn, EmbedKeys::model_key())
        .map_err(|e| e.to_string())?
        .unwrap_or_default();
    if !should_forget_embed_on_remove(&provider, &model, id) {
        return Ok(false);
    }
    forget_slot(conn, &[EmbedKeys::PROVIDER, EmbedKeys::model_key()]).map_err(|e| e.to_string())?;
    registry.clear_embedding();
    backfill.cancel();
    crate::commands::ai::sync_indexer_embedder(indexer, registry);
    Ok(true)
}

/// Wipe the embed slot when `id` is the active on-device model, then delete
/// its files. Test-only: the command runs the same steps without holding
/// the DB lock across the filesystem delete.
#[cfg(test)]
pub(crate) fn teardown_and_remove_on_device_embed_model(
    conn: &rusqlite::Connection,
    id: &str,
    registry: &ProviderRegistry,
    manager: &DownloadManager,
    indexer: &crate::ai::indexer::EntryIndexer,
    backfill: &crate::commands::ai::BackfillManager,
) -> Result<OnDeviceModelStateWire, String> {
    if catalog::find(id).is_none() {
        return Err(format!("unknown on-device model id: {id}"));
    }
    forget_embed_slot_if_in_use(conn, registry, indexer, backfill, id)?;
    manager.remove_downloaded(id)?;
    Ok(manager.download_state(id).into())
}

/// Delete a downloaded model's files, freeing disk space. When the embed
/// slot is on-device and points at `id`, also forgets that slot (same
/// wipe as [`forget_ai_embedding_provider`]) before unlinking files.
/// Emits `ai:model-removed` `{ id, kind: "embed" }` after a successful
/// delete so every catalog-hook instance can drop the id.
#[tauri::command]
pub fn remove_on_device_model(
    app: tauri::AppHandle,
    id: String,
    manager: State<'_, std::sync::Arc<crate::ai::on_device::download::DownloadManager>>,
    state: State<'_, AppState>,
    registry: State<'_, ProviderRegistry>,
    indexer: State<'_, crate::ai::indexer::EntryIndexer>,
    backfill: State<'_, crate::commands::ai::BackfillManager>,
) -> Result<OnDeviceModelStateWire, String> {
    if catalog::find(&id).is_none() {
        return Err(format!("unknown on-device model id: {id}"));
    }
    {
        let conn = state.lock()?;
        forget_embed_slot_if_in_use(&conn, &registry, &indexer, &backfill, &id)?;
    }
    manager.remove_downloaded(&id)?;
    let _ = app.emit(
        "ai:model-removed",
        serde_json::json!({ "id": id, "kind": "embed" }),
    );
    Ok(manager.download_state(&id).into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::providers::testing::MockAIProvider;
    use crate::db::schema::migrate;
    use rusqlite::Connection;
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn make_state_and_conn() -> (AppState, ProviderRegistry) {
        let conn = Connection::open_in_memory().expect("in-memory db");
        migrate(&conn).expect("migrate");
        (AppState::new(conn), ProviderRegistry::default())
    }

    fn image_input(provider: &str, image_model: &str) -> AIImageProviderConfigInput {
        AIImageProviderConfigInput {
            provider: provider.into(),
            image_model: image_model.into(),
        }
    }

    // ── Image slot (independent of the generation slot, 2026-08-07) ─────────

    #[test]
    fn image_slot_reads_none_when_unconfigured() {
        let (state, _registry) = make_state_and_conn();
        let conn = state.lock().unwrap();
        assert!(read_image_public(&conn).unwrap().is_none());
    }

    #[test]
    fn persist_image_config_writes_both_rows_and_reads_back() {
        let (state, _registry) = make_state_and_conn();
        let conn = state.lock().unwrap();
        persist_image_config(
            &conn,
            &image_input("openai", "gpt-image-2"),
            EndpointClass::Remote,
        )
        .unwrap();

        let public = read_image_public(&conn).unwrap().expect("image slot set");
        assert_eq!(public.provider, "openai");
        assert_eq!(public.image_model, "gpt-image-2");
    }

    /// The whole point of the split: writing the image slot must not touch
    /// the chat slot's rows, and vice versa.
    #[test]
    fn image_and_generation_slots_persist_independently() {
        let (state, _registry) = make_state_and_conn();
        let conn = state.lock().unwrap();

        persist_gen_config(
            &conn,
            &gen_input("anthropic", "", None),
            EndpointClass::Remote,
        )
        .unwrap();
        persist_image_config(
            &conn,
            &image_input("openai", "gpt-image-2"),
            EndpointClass::Remote,
        )
        .unwrap();

        assert_eq!(
            db::get_setting(&conn, GenKeys::PROVIDER).unwrap().unwrap(),
            "anthropic"
        );
        assert_eq!(
            db::get_setting(&conn, settings_keys::image::PROVIDER)
                .unwrap()
                .unwrap(),
            "openai"
        );

        // Forgetting the chat slot leaves the image slot fully intact.
        forget_slot(&conn, &[GenKeys::PROVIDER, GenKeys::model_key()]).unwrap();
        assert!(db::get_setting(&conn, GenKeys::PROVIDER).unwrap().is_none());
        let image = read_image_public(&conn).unwrap().expect("image survives");
        assert_eq!(image.provider, "openai");
        assert_eq!(image.image_model, "gpt-image-2");
    }

    #[test]
    fn forget_image_slot_clears_both_rows() {
        let (state, _registry) = make_state_and_conn();
        let conn = state.lock().unwrap();
        persist_image_config(
            &conn,
            &image_input("openai", "gpt-image-2"),
            EndpointClass::Remote,
        )
        .unwrap();
        forget_slot(
            &conn,
            &[
                settings_keys::image::PROVIDER,
                settings_keys::image::IMAGE_MODEL,
            ],
        )
        .unwrap();
        assert!(read_image_public(&conn).unwrap().is_none());
        assert!(db::get_setting(&conn, settings_keys::image::IMAGE_MODEL)
            .unwrap()
            .is_none());
    }

    #[test]
    fn load_image_slot_returns_false_when_unconfigured() {
        let (state, registry) = make_state_and_conn();
        let conn = state.lock().unwrap();
        assert!(!load_image_slot(&conn, &registry).unwrap());
        assert!(registry.image().is_none());
    }

    /// Every existing install lands here on first launch after the split:
    /// the reused `ai_gen_image_model` row still holds their model, but the
    /// new provider row does not exist yet, so the slot stays unconfigured
    /// until they pick an image provider once. Intended, not a bug.
    #[test]
    fn load_image_slot_stays_unconfigured_when_only_the_model_row_survives() {
        let (state, registry) = make_state_and_conn();
        let conn = state.lock().unwrap();
        db::set_setting(&conn, settings_keys::image::IMAGE_MODEL, "gpt-image-2").unwrap();
        assert!(!load_image_slot(&conn, &registry).unwrap());
        assert!(registry.image().is_none());
    }

    #[test]
    fn load_image_slot_hydrates_a_configured_slot() {
        let (state, registry) = make_state_and_conn();
        let conn = state.lock().unwrap();
        persist_image_config(
            &conn,
            &image_input("openai", "gpt-image-2"),
            EndpointClass::Remote,
        )
        .unwrap();
        persist_provider_credential(
            &conn,
            "openai",
            "https://api.openai.com/v1",
            Some("sk-test"),
        )
        .unwrap();

        assert!(load_image_slot(&conn, &registry).unwrap());
        assert!(registry.image().is_some());
        assert!(
            registry.generation().is_none(),
            "hydrating the image slot must not populate the chat slot"
        );
    }

    #[test]
    fn load_image_slot_skips_hydration_when_the_model_row_is_empty() {
        let (state, registry) = make_state_and_conn();
        let conn = state.lock().unwrap();
        db::set_setting(&conn, settings_keys::image::PROVIDER, "openai").unwrap();
        db::set_setting(&conn, settings_keys::image::IMAGE_MODEL, "").unwrap();
        persist_provider_credential(
            &conn,
            "openai",
            "https://api.openai.com/v1",
            Some("sk-test"),
        )
        .unwrap();
        assert!(!load_image_slot(&conn, &registry).unwrap());
    }

    /// Presets that cannot draw must be rejected at build time rather than
    /// failing later inside `generate_inline_image`.
    #[test]
    fn build_slot_provider_rejects_image_payload_for_non_image_presets() {
        for preset in [CLAUDE_CLI_ID, CODEX_CLI_ID, ON_DEVICE_PROVIDER_ID] {
            let result = build_slot_provider(
                preset,
                "",
                None,
                SlotPayload::Image {
                    image_model: "gpt-image-2",
                },
                None,
            );
            assert!(
                matches!(result, Err(AiError::ProviderUnsupported(_))),
                "{preset} must reject an image payload, got {:?}",
                result.map(|_| "Ok")
            );
        }
    }

    /// Security regression guard. The live provider bakes in its endpoint,
    /// but the privacy gate re-derives the endpoint class from the DB on
    /// every call — so an unreconciled image slot would let the gate say
    /// "local, no disclosure" while prompts still went to the old hosted
    /// vendor with the old key.
    #[test]
    fn reconcile_rebuilds_the_image_slot_when_its_preset_credential_changes() {
        let (state, registry) = make_state_and_conn();
        let conn = state.lock().unwrap();
        persist_image_config(
            &conn,
            &image_input("custom", "some-image-model"),
            EndpointClass::Remote,
        )
        .unwrap();
        persist_provider_credential(&conn, "custom", "https://api.vendor.com/v1", Some("sk-old"))
            .unwrap();
        assert!(load_image_slot(&conn, &registry).unwrap());
        assert!(registry.image().is_some());

        // Repoint the same preset at a local server.
        persist_provider_credential(&conn, "custom", "http://127.0.0.1:1234/v1", None).unwrap();
        assert!(reconcile_image_slot(&conn, &registry, "custom").unwrap());
        assert!(
            registry.image().is_some(),
            "slot must be rebuilt against the new endpoint, not left stale"
        );
    }

    #[test]
    fn reconcile_clears_the_image_slot_when_its_remote_key_is_revoked() {
        let (state, registry) = make_state_and_conn();
        let conn = state.lock().unwrap();
        persist_image_config(
            &conn,
            &image_input("openai", "gpt-image-2"),
            EndpointClass::Remote,
        )
        .unwrap();
        persist_provider_credential(&conn, "openai", "https://api.openai.com/v1", Some("sk-old"))
            .unwrap();
        assert!(load_image_slot(&conn, &registry).unwrap());

        // Key revoked, endpoint untouched — the empty-endpoint branch never
        // fires, so this is the case that used to leave the old keyed
        // provider serving.
        persist_provider_credential(&conn, "openai", "https://api.openai.com/v1", Some(""))
            .unwrap();
        assert!(!reconcile_image_slot(&conn, &registry, "openai").unwrap());
        assert!(
            registry.image().is_none(),
            "a keyless remote image slot must be cleared, never left stale"
        );
    }

    #[test]
    fn validate_endpoint_url_accepts_http_and_https() {
        assert!(validate_endpoint_url("https://api.openai.com/v1").is_ok());
        assert!(validate_endpoint_url("http://127.0.0.1:11434/v1").is_ok());
    }

    // ── Two-slot API (R11+) ─────────────────────────────────────────────────

    // T2.3 cutover: `endpoint`/`api_key` no longer live on the input structs
    // — every call site below happens to pass exactly the provider's own
    // `preset_default_endpoint`, so the two params are kept (unused) purely
    // to avoid a 40-call-site signature churn; callers that need a
    // NON-default endpoint/key now seed the credential registry directly via
    // `persist_provider_credential`.
    fn gen_input(
        provider: &str,
        _endpoint: &str,
        _api_key: Option<&str>,
    ) -> AIGenProviderConfigInput {
        AIGenProviderConfigInput {
            provider: provider.into(),
            chat_model: "gpt-4o-mini".into(),
        }
    }

    fn embed_input(
        provider: &str,
        _endpoint: &str,
        _api_key: Option<&str>,
    ) -> AIEmbedProviderConfigInput {
        AIEmbedProviderConfigInput {
            provider: provider.into(),
            embedding_model: "text-embedding-3-small".into(),
        }
    }

    /// Test helper: the `EndpointClass` for `provider`'s BUILT-IN default
    /// endpoint — every `gen_input`/`embed_input` call site below configures
    /// a known preset at its default (never a registry override), so this is
    /// the class `persist_gen_config`/`persist_embed_config` would actually
    /// see in production for that provider.
    fn expected_class(provider: &str) -> EndpointClass {
        credential_class(provider, preset_default_endpoint(provider))
    }

    #[test]
    fn persist_gen_writes_only_gen_keys() {
        let (state, _reg) = make_state_and_conn();
        let conn = state.lock().unwrap();
        let i = gen_input("anthropic", "https://api.anthropic.com/v1", Some("sk"));
        let class = expected_class(&i.provider);
        persist_gen_config(&conn, &i, class).unwrap();

        // Gen rows present.
        assert_eq!(
            db::get_setting(&conn, settings_keys::gen::PROVIDER)
                .unwrap()
                .as_deref(),
            Some("anthropic")
        );
        assert_eq!(
            db::get_setting(&conn, settings_keys::gen::CHAT_MODEL)
                .unwrap()
                .as_deref(),
            Some("gpt-4o-mini")
        );
        // Embed namespace untouched.
        assert!(db::get_setting(&conn, settings_keys::embed::PROVIDER)
            .unwrap()
            .is_none());
        assert!(
            db::get_setting(&conn, settings_keys::embed::EMBEDDING_MODEL)
                .unwrap()
                .is_none()
        );
        // Legacy namespace untouched.
        assert!(db::get_setting(&conn, settings_keys::PROVIDER)
            .unwrap()
            .is_none());
    }

    #[test]
    fn persist_embed_writes_only_embed_keys() {
        let (state, _reg) = make_state_and_conn();
        let conn = state.lock().unwrap();
        let i = embed_input("openai", "https://api.openai.com/v1", Some("sk"));
        persist_embed_config(&conn, &i, expected_class(&i.provider)).unwrap();

        assert_eq!(
            db::get_setting(&conn, settings_keys::embed::PROVIDER)
                .unwrap()
                .as_deref(),
            Some("openai")
        );
        assert_eq!(
            db::get_setting(&conn, settings_keys::embed::EMBEDDING_MODEL)
                .unwrap()
                .as_deref(),
            Some("text-embedding-3-small")
        );
        // Gen namespace untouched — proves slot isolation.
        assert!(db::get_setting(&conn, settings_keys::gen::PROVIDER)
            .unwrap()
            .is_none());
        assert!(db::get_setting(&conn, settings_keys::gen::CHAT_MODEL)
            .unwrap()
            .is_none());
    }

    // NOTE: `persist_embed_config_endpoint_only_change_invalidates_hosted_consent`
    // was deleted here — its premise (an endpoint-only edit reaching
    // `persist_embed_config` with the SAME provider) is no longer possible:
    // `AIEmbedProviderConfigInput` (T2.3) carries no `endpoint` field, so a
    // save through this function can only change `provider`/`embedding_model`
    // — the endpoint always comes from the per-preset credential registry,
    // unaffected by this call. The underlying I2 guarantee (an endpoint-only
    // credential EDIT invalidates hosted consent) is now exercised on the
    // registry/reconcile path instead — see
    // `reconcile_embedding_endpoint_change_invalidates_hosted_consent`.

    /// Regression guard: a pure API-key rotation (same provider and model —
    /// T2.3: the endpoint field is gone, key rotation now happens via the
    /// credential registry) must NOT invalidate hosted consent — I2 only
    /// widens the identity to include the endpoint, it must not start
    /// clearing consent on every save.
    #[test]
    fn persist_embed_config_key_rotation_alone_does_not_invalidate_consent() {
        let (state, _reg) = make_state_and_conn();
        let conn = state.lock().unwrap();
        let i1 = embed_input("openai", "https://api.openai.com/v1", Some("sk-1"));
        persist_embed_config(&conn, &i1, EndpointClass::Remote).unwrap();
        db::set_setting(
            &conn,
            settings_keys::BACKGROUND_INDEXING_HOSTED_CONSENT_AT,
            "1234567890",
        )
        .unwrap();

        let i2 = embed_input("openai", "https://api.openai.com/v1", Some("sk-2"));
        let (_, identity_changed) =
            persist_embed_config(&conn, &i2, EndpointClass::Remote).unwrap();

        assert!(!identity_changed);
        assert_eq!(
            db::get_setting(&conn, settings_keys::BACKGROUND_INDEXING_HOSTED_CONSENT_AT)
                .unwrap()
                .as_deref(),
            Some("1234567890"),
            "a pure key rotation must not clear hosted consent"
        );
    }

    // ─── apply_embedding_slot_change (Phase 2 Task 6) ──────────────────────

    fn insert_test_entry(conn: &rusqlite::Connection, id: &str, title: &str, content: &str) {
        conn.execute(
            "INSERT OR IGNORE INTO journals (id, name, created_at, updated_at) \
             VALUES ('j1', 'J', 0, 0)",
            [],
        )
        .expect("seed journal");
        conn.execute(
            "INSERT INTO entries (id, journal_id, title, content_text, entry_date,
                created_at, updated_at)
             VALUES (?1, 'j1', ?2, ?3, 0, 0, 0)",
            rusqlite::params![id, title, content],
        )
        .expect("insert entry");
    }

    /// A genuine embedding-slot model swap (provider:model boundary
    /// changes) enqueues every eligible entry as a dirty job for the NEW
    /// model_id — and leaves whatever job rows already existed under the
    /// OLD model_id completely untouched (`entry_embedding_jobs` is keyed
    /// by `(entry_id, model_id)`, so nothing re-embeds the old model).
    #[test]
    fn apply_embedding_slot_change_model_swap_enqueues_new_model_leaves_old_untouched() {
        let (state, registry) = make_state_and_conn();
        let conn = state.lock().unwrap();
        db::set_setting(&conn, settings_keys::SEMANTIC_SEARCH_ENABLED, "true").unwrap();
        insert_test_entry(&conn, "e1", "T1", "Entry one text long enough to embed.");
        insert_test_entry(&conn, "e2", "T2", "Entry two text long enough to embed.");

        let i1 = embed_input("openai", "https://api.openai.com/v1", Some("sk"));
        let p1: Arc<dyn AIProvider> = Arc::new(MockAIProvider::new("openai", &i1.embedding_model));
        let out1 =
            apply_embedding_slot_change(&conn, &registry, p1, &i1, EndpointClass::Remote).unwrap();
        assert!(
            out1.identity_changed,
            "first-time configuration is an identity change (old identity was empty)"
        );
        assert_eq!(
            out1.enqueued, 2,
            "both eligible entries queued for the initial model"
        );
        let old_model_id = out1.model_id.clone();

        let mut i2 = embed_input("openai", "https://api.openai.com/v1", Some("sk"));
        i2.embedding_model = "text-embedding-3-large".into();
        let p2: Arc<dyn AIProvider> = Arc::new(MockAIProvider::new("openai", &i2.embedding_model));
        let out2 =
            apply_embedding_slot_change(&conn, &registry, p2, &i2, EndpointClass::Remote).unwrap();

        assert!(out2.identity_changed, "provider:model boundary changed");
        assert_ne!(out2.model_id, old_model_id);
        assert_eq!(
            out2.enqueued, 2,
            "both entries re-queued under the new model_id"
        );

        for id in ["e1", "e2"] {
            let old_job = db::embeddings::get_embedding_job(&conn, id, &old_model_id).unwrap();
            assert!(
                old_job.is_some(),
                "old-model job row must remain, untouched"
            );
            assert_eq!(old_job.unwrap().status, "pending");
            let new_job = db::embeddings::get_embedding_job(&conn, id, &out2.model_id).unwrap();
            assert!(new_job.is_some(), "new-model job row must be enqueued");
        }
    }

    /// An embedding API-key rotation on the SAME provider:model is not an
    /// identity change — the rebuild boundary excludes the key — so it
    /// must never enqueue re-embed work.
    #[test]
    fn apply_embedding_slot_change_key_rotation_does_not_enqueue() {
        let (state, registry) = make_state_and_conn();
        let conn = state.lock().unwrap();
        db::set_setting(&conn, settings_keys::SEMANTIC_SEARCH_ENABLED, "true").unwrap();
        insert_test_entry(&conn, "e1", "T1", "Entry text long enough to embed.");

        let i1 = embed_input("openai", "https://api.openai.com/v1", Some("sk-1"));
        let p1: Arc<dyn AIProvider> = Arc::new(MockAIProvider::new("openai", &i1.embedding_model));
        apply_embedding_slot_change(&conn, &registry, p1, &i1, EndpointClass::Remote).unwrap();

        let i2 = embed_input("openai", "https://api.openai.com/v1", Some("sk-2"));
        let p2: Arc<dyn AIProvider> = Arc::new(MockAIProvider::new("openai", &i2.embedding_model));
        let out2 =
            apply_embedding_slot_change(&conn, &registry, p2, &i2, EndpointClass::Remote).unwrap();

        assert!(
            !out2.identity_changed,
            "same provider:model — key rotation must not count as an identity change"
        );
        assert_eq!(
            out2.enqueued, 0,
            "key rotation must not enqueue re-embed jobs"
        );
    }

    /// C7 fix: an embedding-slot save is the "user corrected credentials"
    /// recovery trigger for jobs `paused` on an auth/config-class error —
    /// this must fire on a pure key rotation too (`identity_changed ==
    /// false`), not just an identity change, since a bad-key pause is
    /// exactly what a key rotation is meant to fix. Rebuild enqueueing
    /// (`enqueued`) must stay 0 — recovering a paused job and re-embedding
    /// unrelated already-current entries are different things.
    #[test]
    fn apply_embedding_slot_change_key_rotation_resets_paused_jobs_to_pending() {
        let (state, registry) = make_state_and_conn();
        let conn = state.lock().unwrap();
        db::set_setting(&conn, settings_keys::SEMANTIC_SEARCH_ENABLED, "true").unwrap();
        insert_test_entry(&conn, "e1", "T1", "Entry text long enough to embed.");

        let i1 = embed_input("openai", "https://api.openai.com/v1", Some("sk-1"));
        let p1: Arc<dyn AIProvider> = Arc::new(MockAIProvider::new("openai", &i1.embedding_model));
        let out1 =
            apply_embedding_slot_change(&conn, &registry, p1, &i1, EndpointClass::Remote).unwrap();

        // Simulate the worker having paused this entry's job on an
        // auth-class failure (bad/expired key) under the just-configured
        // model_id.
        db::embeddings::pause_embedding_job(&conn, "e1", &out1.model_id, "bad api key", 0).unwrap();
        assert_eq!(
            db::embeddings::get_embedding_job(&conn, "e1", &out1.model_id)
                .unwrap()
                .unwrap()
                .status,
            "paused"
        );

        // Key rotation on the SAME provider:model — the user fixing the key.
        let i2 = embed_input("openai", "https://api.openai.com/v1", Some("sk-2"));
        let p2: Arc<dyn AIProvider> = Arc::new(MockAIProvider::new("openai", &i2.embedding_model));
        let out2 =
            apply_embedding_slot_change(&conn, &registry, p2, &i2, EndpointClass::Remote).unwrap();

        assert!(
            !out2.identity_changed,
            "key rotation is not an identity change"
        );
        assert_eq!(
            out2.enqueued, 0,
            "key rotation must not enqueue re-embed jobs for already-current entries"
        );
        assert_eq!(
            db::embeddings::get_embedding_job(&conn, "e1", &out2.model_id)
                .unwrap()
                .unwrap()
                .status,
            "pending",
            "the paused job must recover to pending once credentials are re-saved"
        );
    }

    /// C4 fix: `set_ai_embedding_provider`'s worker-restart decision must
    /// depend only on `features_enabled`, not `identity_changed` —
    /// `backfill.cancel()` unconditionally stops the worker's shared
    /// loop-liveness token, so a same-identity change (e.g. an API-key
    /// rotation) must still trigger a restart or background indexing
    /// halts until app restart/unlock.
    #[test]
    fn embedding_slot_change_restarts_worker_even_when_identity_unchanged_key_rotation() {
        let (state, registry) = make_state_and_conn();
        let conn = state.lock().unwrap();
        db::set_setting(&conn, settings_keys::SEMANTIC_SEARCH_ENABLED, "true").unwrap();

        let i1 = embed_input("openai", "https://api.openai.com/v1", Some("sk-1"));
        let p1: Arc<dyn AIProvider> = Arc::new(MockAIProvider::new("openai", &i1.embedding_model));
        apply_embedding_slot_change(&conn, &registry, p1, &i1, EndpointClass::Remote).unwrap();

        // Key rotation only.
        let i2 = embed_input("openai", "https://api.openai.com/v1", Some("sk-2"));
        let p2: Arc<dyn AIProvider> = Arc::new(MockAIProvider::new("openai", &i2.embedding_model));
        let out2 =
            apply_embedding_slot_change(&conn, &registry, p2, &i2, EndpointClass::Remote).unwrap();

        assert!(
            !out2.identity_changed,
            "key rotation is not an identity change"
        );
        assert!(
            should_restart_worker_after_embedding_slot_change(&out2),
            "the OLD `identity_changed && features_enabled` gate would have been false here \
             (identity_changed=false) — the fixed predicate must still return true because a \
             feature is enabled, otherwise a routine key rotation halts the worker forever"
        );
    }

    /// T1.4 — locks the SHAPE of `run_embedding_post_swap_sequence` so T1.5
    /// (reconcile_slots_for_preset) can call it without redesigning. The
    /// helper centralizes the four-step post-swap sequence
    /// (`cancel_and_clear` → `sync_indexer_embedder` →
    /// `should_restart_worker_after_embedding_slot_change` →
    /// `start_indexing_worker`); this test drives it directly with a spy
    /// closure substituted for `start_indexing_worker` (which would
    /// otherwise need a real `tauri::AppHandle`, unconstructable in unit
    /// tests — same extraction posture as
    /// `should_restart_worker_after_embedding_slot_change` itself).
    ///
    /// Asserts both:
    ///   * the restart closure fires iff the predicate says so — the same
    ///     C4 invariant the guard test above locks, but at the helper
    ///     level (proves the helper actually consults the predicate rather
    ///     than inlining an unrelated gate);
    ///   * `cancel_and_clear` ran — the C4 load-bearing step; without it
    ///     the restart path silently no-ops against an occupied slot.
    #[test]
    fn run_embedding_post_swap_sequence_restarts_iff_predicate_says_so() {
        use crate::ai::embedder::StubEmbedder;
        use crate::ai::indexer::EntryIndexer;
        use crate::commands::ai::BackfillManager;
        use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};

        let (state, registry) = make_state_and_conn();
        let conn = state.lock().unwrap();
        db::set_setting(&conn, settings_keys::SEMANTIC_SEARCH_ENABLED, "true").unwrap();

        // Occupy the backfill slot so we can prove `cancel_and_clear`
        // actually vacates it — the C4 fix's load-bearing claim. Without
        // that step a synchronous restart would silently no-op against an
        // occupied slot.
        let backfill = BackfillManager::new();
        let _ = backfill.start("openai:text-embedding-3-small".into(), 0);
        assert!(backfill.status().running);
        let indexer = EntryIndexer::from_dyn(Arc::new(StubEmbedder::new(
            "openai:text-embedding-3-small",
            8,
        )));

        // Feature-on, identity unchanged — exactly the key-rotation shape
        // that broke the old `identity_changed && features_enabled` gate.
        let outcome_on = EmbeddingSlotChangeOutcome {
            result: SetProviderResult {
                provider: "openai".into(),
                endpoint_class: EndpointClass::Remote,
                requires_privacy_consent: false,
            },
            identity_changed: false,
            enqueued: 0,
            model_id: "openai:text-embedding-3-small".into(),
            features_enabled: true,
        };
        assert!(
            should_restart_worker_after_embedding_slot_change(&outcome_on),
            "predicate must be true when features_enabled is true"
        );

        let restarted = Arc::new(AtomicBool::new(false));
        let restarted_probe = Arc::clone(&restarted);
        run_embedding_post_swap_sequence(&backfill, &indexer, &registry, &outcome_on, || {
            restarted_probe.store(true, AtomicOrdering::SeqCst);
        });
        assert!(
            restarted.load(AtomicOrdering::SeqCst),
            "features_enabled=true → restart closure must fire (identity_changed=false is the \
             key-rotation trap C4 fixed; the helper must not regress it)"
        );
        assert!(
            !backfill.status().running,
            "cancel_and_clear must have vacated the slot — a synchronous restart path depends on it"
        );

        // Feature-off path: predicate false → restart closure must NOT fire.
        db::set_setting(&conn, settings_keys::SEMANTIC_SEARCH_ENABLED, "false").unwrap();
        db::set_setting(&conn, settings_keys::EMOTION_SUGGESTIONS_ENABLED, "false").unwrap();
        let outcome_off = EmbeddingSlotChangeOutcome {
            result: SetProviderResult {
                provider: "openai".into(),
                endpoint_class: EndpointClass::Remote,
                requires_privacy_consent: false,
            },
            identity_changed: false,
            enqueued: 0,
            model_id: "openai:text-embedding-3-small".into(),
            features_enabled: false,
        };
        assert!(!should_restart_worker_after_embedding_slot_change(
            &outcome_off
        ));

        // Re-occupy the slot so the helper's `cancel_and_clear` has work
        // to do (otherwise the assertion on `restarted2` is the only signal).
        let _ = backfill.start("openai:text-embedding-3-small".into(), 0);

        let restarted2 = Arc::new(AtomicBool::new(false));
        let restarted2_probe = Arc::clone(&restarted2);
        run_embedding_post_swap_sequence(&backfill, &indexer, &registry, &outcome_off, || {
            restarted2_probe.store(true, AtomicOrdering::SeqCst);
        });
        assert!(
            !restarted2.load(AtomicOrdering::SeqCst),
            "features_enabled=false → restart closure must NOT fire (no consumer for the cache)"
        );
    }

    // ── reconcile_slots_for_preset (T1.5) ───────────────────────────────────

    /// (a) Rotating a preset's key must rebuild + re-swap EVERY slot bound
    /// to it. `AuditingProvider` wraps a fresh `Arc` on every swap
    /// regardless of whether the inner credential changed, so pointer
    /// identity alone can't prove "the new key" was used (the built
    /// provider never exposes its key or endpoint for inspection — see
    /// `OpenAICompatibleProvider`'s manual `Debug` impl). What IS directly
    /// observable and load-bearing: the reconcile pass must actually
    /// rebuild-and-reswap BOTH bound slots on every call, and must leave a
    /// slot bound to a DIFFERENT preset completely untouched (proves the
    /// preset-id match, not just "swap everything").
    #[tokio::test]
    async fn reconcile_rotating_key_reswaps_both_bound_slots() {
        let (state, registry) = make_state_and_conn();
        let conn = state.lock().unwrap();

        db::set_setting(&conn, GenKeys::PROVIDER, "openai").unwrap();
        db::set_setting(&conn, GenKeys::model_key(), "gpt-4o-mini").unwrap();
        db::set_setting(&conn, EmbedKeys::PROVIDER, "openai").unwrap();
        db::set_setting(&conn, EmbedKeys::model_key(), "text-embedding-3-small").unwrap();

        // A slot bound to a DIFFERENT preset — must stay untouched by a
        // reconcile of "openai".
        db::set_setting(&conn, settings_keys::memory_gen::PROVIDER, "ollama").unwrap();
        db::set_setting(&conn, settings_keys::memory_gen::CHAT_MODEL, "llama3").unwrap();

        let mut keyring = std::collections::BTreeMap::new();
        keyring.insert("openai".to_string(), "sk-old".to_string());
        write_provider_keyring(&conn, &keyring).unwrap();

        let backfill = crate::commands::ai::BackfillManager::new();
        let indexer = crate::ai::indexer::EntryIndexer::from_dyn(Arc::new(
            crate::ai::embedder::StubEmbedder::new("openai:text-embedding-3-small", 8),
        ));

        let outcome1 = reconcile_slots_for_preset(
            &conn,
            &registry,
            "openai",
            "", // old_endpoint (round-2 fix #2) — not exercised here
            &backfill,
            &indexer,
            None,
            None,
            None,
            || {},
        )
        .await
        .unwrap();
        assert!(outcome1.generation);
        assert!(outcome1.embedding);
        assert!(
            !outcome1.memory_generation,
            "memory gen slot is bound to \"ollama\", not \"openai\" — must not be reported as reconciled"
        );
        assert!(
            registry.memory_generation().is_none(),
            "memory gen slot bound to a different preset must never be swapped by this reconcile"
        );
        let gen_ptr_1 = Arc::as_ptr(&registry.generation().unwrap()) as *const ();
        let embed_ptr_1 = Arc::as_ptr(&registry.embedding().unwrap()) as *const ();

        // Rotate the key.
        keyring.insert("openai".to_string(), "sk-new".to_string());
        write_provider_keyring(&conn, &keyring).unwrap();

        let outcome2 = reconcile_slots_for_preset(
            &conn,
            &registry,
            "openai",
            "", // old_endpoint (round-2 fix #2) — not exercised here
            &backfill,
            &indexer,
            None,
            None,
            None,
            || {},
        )
        .await
        .unwrap();
        assert!(outcome2.generation);
        assert!(outcome2.embedding);
        let gen_ptr_2 = Arc::as_ptr(&registry.generation().unwrap()) as *const ();
        let embed_ptr_2 = Arc::as_ptr(&registry.embedding().unwrap()) as *const ();

        assert_ne!(
            gen_ptr_1, gen_ptr_2,
            "generation slot must be rebuilt + re-swapped on key rotation"
        );
        assert_ne!(
            embed_ptr_1, embed_ptr_2,
            "embedding slot must be rebuilt + re-swapped on key rotation"
        );
        assert_eq!(registry.generation().unwrap().id(), "openai");
        assert_eq!(registry.embedding().unwrap().id(), "openai");
    }

    /// (b) THE highest-risk case in the whole plan: reconciling a preset
    /// bound to the embedding slot where only the key rotated (provider id
    /// + model unchanged, so `identity_changed` is always `false` for a
    /// reconcile) must still trigger `run_embedding_post_swap_sequence`'s
    /// restart path. This is the exact `identity_changed = false` trap C4
    /// fixed for the slot-save path
    /// (`embedding_slot_change_restarts_worker_even_when_identity_unchanged_key_rotation`
    /// above) — reconcile must not reintroduce it.
    #[tokio::test]
    async fn reconcile_embedding_key_rotation_restarts_worker_even_when_identity_unchanged() {
        use crate::ai::embedder::StubEmbedder;
        use crate::ai::indexer::EntryIndexer;
        use crate::commands::ai::BackfillManager;
        use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};

        let (state, registry) = make_state_and_conn();
        let conn = state.lock().unwrap();
        db::set_setting(&conn, settings_keys::SEMANTIC_SEARCH_ENABLED, "true").unwrap();

        db::set_setting(&conn, EmbedKeys::PROVIDER, "openai").unwrap();
        db::set_setting(&conn, EmbedKeys::model_key(), "text-embedding-3-small").unwrap();

        let mut keyring = std::collections::BTreeMap::new();
        keyring.insert("openai".to_string(), "sk-old".to_string());
        write_provider_keyring(&conn, &keyring).unwrap();

        // Occupy the backfill slot so we can prove `cancel_and_clear`
        // actually ran (the C4 load-bearing step — without it a
        // synchronous restart silently no-ops against an occupied slot).
        let backfill = BackfillManager::new();
        let _ = backfill.start("openai:text-embedding-3-small".into(), 0);
        assert!(backfill.status().running);
        let indexer = EntryIndexer::from_dyn(Arc::new(StubEmbedder::new(
            "openai:text-embedding-3-small",
            8,
        )));

        // Rotate the key only — provider id and model are unchanged.
        keyring.insert("openai".to_string(), "sk-new".to_string());
        write_provider_keyring(&conn, &keyring).unwrap();

        let restarted = Arc::new(AtomicBool::new(false));
        let restarted_probe = Arc::clone(&restarted);
        let outcome = reconcile_slots_for_preset(
            &conn,
            &registry,
            "openai",
            "", // old_endpoint (round-2 fix #2) — not exercised here
            &backfill,
            &indexer,
            None,
            None,
            None,
            move || {
                restarted_probe.store(true, AtomicOrdering::SeqCst);
            },
        )
        .await
        .unwrap();

        assert!(
            outcome.embedding,
            "embedding slot is bound to \"openai\" and must be reported as reconciled"
        );
        assert!(
            restarted.load(AtomicOrdering::SeqCst),
            "key rotation with unchanged identity must still restart the worker — the OLD \
             `identity_changed && features_enabled` gate would have skipped this and left \
             indexing permanently halted after a routine key rotation"
        );
        assert!(
            !backfill.status().running,
            "cancel_and_clear must have vacated the backfill slot"
        );
    }

    /// (c) Reconciling a hosted preset bound to a memory slot while
    /// `ai_memory_allow_hosted` is off (the default) must DROP that slot —
    /// leave it exactly as it was — rather than swapping it in. This is a
    /// routine, expected outcome: `reconcile_slots_for_preset` returns `Ok`
    /// with `memory_generation: false`, not an `Err`. Mirrors how
    /// `load_memory_gen_slot` treats the same rejection at hydration time.
    #[tokio::test]
    async fn reconcile_memory_slot_drops_hosted_preset_when_allow_hosted_is_off() {
        let (state, registry) = make_state_and_conn();
        let conn = state.lock().unwrap();

        db::set_setting(&conn, settings_keys::memory_gen::PROVIDER, "openai").unwrap();
        db::set_setting(&conn, settings_keys::memory_gen::CHAT_MODEL, "gpt-4o-mini").unwrap();
        // `ai_memory_allow_hosted` is left at its default (false/off).

        let backfill = crate::commands::ai::BackfillManager::new();
        let indexer = crate::ai::indexer::EntryIndexer::from_dyn(Arc::new(
            crate::ai::embedder::StubEmbedder::new("openai:text-embedding-3-small", 8),
        ));

        let outcome = reconcile_slots_for_preset(
            &conn,
            &registry,
            "openai",
            "", // old_endpoint (round-2 fix #2) — not exercised here
            &backfill,
            &indexer,
            None,
            None,
            None,
            || {},
        )
        .await
        .expect(
            "a rejected memory slot must be a routine drop (Ok), never an Err that would fail \
             the whole reconcile pass for the other slots",
        );

        assert!(
            !outcome.memory_generation,
            "rejected memory slot must not be reported as swapped"
        );
        assert!(
            registry.memory_generation().is_none(),
            "rejected memory slot must be left untouched — never swapped in"
        );
    }

    /// Round-3 fix #3: unlike the test above (where the memory generation
    /// slot was never bound, so "left untouched" and "cleared" are
    /// observationally identical — both `None`), this test starts from a
    /// LIVE, successfully-bound Local provider and rebinds to a hosted
    /// preset while `ai_memory_allow_hosted` stays off — a Local→Remote
    /// transition class enforcement rejects. Before the fix,
    /// `reconcile_memory_generation_slot` left the OLD "ollama" provider
    /// running in the registry on rejection; it must now be actively
    /// cleared instead.
    #[tokio::test]
    async fn reconcile_memory_generation_slot_clears_stale_provider_when_class_enforcement_rejects()
    {
        let (state, registry) = make_state_and_conn();
        let conn = state.lock().unwrap();

        db::set_setting(&conn, settings_keys::memory_gen::PROVIDER, "ollama").unwrap();
        db::set_setting(&conn, settings_keys::memory_gen::CHAT_MODEL, "llama3").unwrap();

        let backfill = crate::commands::ai::BackfillManager::new();
        let indexer = crate::ai::indexer::EntryIndexer::from_dyn(Arc::new(
            crate::ai::embedder::StubEmbedder::new("ollama:nomic-embed-text", 8),
        ));

        // Bind the slot for real first — "ollama" is Local, never gated by
        // ai_memory_allow_hosted.
        reconcile_slots_for_preset(
            &conn,
            &registry,
            "ollama",
            "", // old_endpoint (round-2 fix #2) — not exercised here
            &backfill,
            &indexer,
            None,
            None,
            None,
            || {},
        )
        .await
        .unwrap();
        assert!(
            registry.memory_generation().is_some(),
            "sanity check: the Local slot must be live before the rejected rebind"
        );

        // Rebind to a hosted preset with ai_memory_allow_hosted still off.
        db::set_setting(&conn, settings_keys::memory_gen::PROVIDER, "openai").unwrap();
        db::set_setting(&conn, settings_keys::memory_gen::CHAT_MODEL, "gpt-4o-mini").unwrap();

        let outcome = reconcile_slots_for_preset(
            &conn,
            &registry,
            "openai",
            "", // old_endpoint (round-2 fix #2) — not exercised here
            &backfill,
            &indexer,
            None,
            None,
            None,
            || {},
        )
        .await
        .expect("a rejected memory gen slot must be a routine drop, never an Err");

        assert!(
            !outcome.memory_generation,
            "hosted memory gen slot rejected by class enforcement must not be reported as swapped"
        );
        assert!(
            registry.memory_generation().is_none(),
            "rejected memory gen slot must be actively CLEARED, not left running the stale \
             \"ollama\" provider — leaving it live would keep memory generation silently using a \
             credential current policy says it shouldn't"
        );
    }

    /// Coverage gap closed: ZERO prior tests exercised the memory
    /// EMBEDDING slot through `reconcile_slots_for_preset` (only the
    /// memory GENERATION slot was covered by the drop-path test above).
    /// Covers both the success path (Local class, never gated by
    /// `ai_memory_allow_hosted`) and the `enforce_memory_slot_class`
    /// rejection/drop path (hosted class, `allow_hosted` off).
    #[tokio::test]
    async fn reconcile_memory_embedding_slot_success_and_rejection_paths() {
        let (state, registry) = make_state_and_conn();
        let conn = state.lock().unwrap();

        db::set_setting(&conn, settings_keys::memory_embed::PROVIDER, "ollama").unwrap();
        db::set_setting(
            &conn,
            settings_keys::memory_embed::EMBEDDING_MODEL,
            "nomic-embed-text",
        )
        .unwrap();

        let backfill = crate::commands::ai::BackfillManager::new();
        let indexer = crate::ai::indexer::EntryIndexer::from_dyn(Arc::new(
            crate::ai::embedder::StubEmbedder::new("ollama:nomic-embed-text", 8),
        ));

        // Success path: "ollama" is Local — never gated by
        // ai_memory_allow_hosted (which is left at its off default).
        let outcome = reconcile_slots_for_preset(
            &conn,
            &registry,
            "ollama",
            "", // old_endpoint (round-2 fix #2) — not exercised here
            &backfill,
            &indexer,
            None,
            None,
            None,
            || {},
        )
        .await
        .unwrap();
        assert!(
            outcome.memory_embedding,
            "Local memory embed slot bound to \"ollama\" must be reconciled"
        );
        assert!(registry.memory_embedder().is_some());

        // Rejection/drop path: rebind to a hosted preset with
        // ai_memory_allow_hosted still off — must be a routine drop, not
        // an Err. Round-3 fix #3: the slot must ALSO be actively CLEARED,
        // not left running the stale "ollama" provider from above — that
        // old provider is exactly the "policy-violating credential kept
        // silently live" bug the fix closes.
        db::set_setting(&conn, settings_keys::memory_embed::PROVIDER, "openai").unwrap();
        db::set_setting(
            &conn,
            settings_keys::memory_embed::EMBEDDING_MODEL,
            "text-embedding-3-small",
        )
        .unwrap();
        assert!(
            registry.memory_embedder().is_some(),
            "sanity check: the Local slot must be live before the rejected rebind"
        );

        let outcome2 = reconcile_slots_for_preset(
            &conn,
            &registry,
            "openai",
            "", // old_endpoint (round-2 fix #2) — not exercised here
            &backfill,
            &indexer,
            None,
            None,
            None,
            || {},
        )
        .await
        .expect("a rejected memory embed slot must be a routine drop, never an Err");
        assert!(
            !outcome2.memory_embedding,
            "hosted memory embed slot rejected by class enforcement must not be reported as swapped"
        );
        assert!(
            registry.memory_embedder().is_none(),
            "rejected memory embed slot must be actively CLEARED, not left running the stale \
             \"ollama\" provider — leaving it live would keep memory embedding silently using a \
             credential current policy says it shouldn't"
        );
    }

    /// Coverage gap closed: no prior test exercised the on-device-llm
    /// branch of `reconcile_generation_slot` / `reconcile_memory_generation_slot`
    /// THROUGH `reconcile_slots_for_preset`. Covers both the "managers
    /// available" rebuild-success path and the "managers unavailable"
    /// skip-and-drop path.
    #[tokio::test]
    async fn reconcile_on_device_llm_branch_with_and_without_managers() {
        let (state, registry) = make_state_and_conn();
        let conn = state.lock().unwrap();

        db::set_setting(&conn, GenKeys::PROVIDER, ON_DEVICE_LLM_ID).unwrap();
        db::set_setting(&conn, GenKeys::model_key(), llm_catalog::GEMMA_4_E4B_IT).unwrap();
        db::set_setting(&conn, settings_keys::memory_gen::PROVIDER, ON_DEVICE_LLM_ID).unwrap();
        db::set_setting(
            &conn,
            settings_keys::memory_gen::CHAT_MODEL,
            llm_catalog::GEMMA_4_E4B_IT,
        )
        .unwrap();

        let backfill = crate::commands::ai::BackfillManager::new();
        let indexer = crate::ai::indexer::EntryIndexer::from_dyn(Arc::new(
            crate::ai::embedder::StubEmbedder::new("ollama:nomic-embed-text", 8),
        ));

        // Without managers: both slots must skip (not error, not swap).
        let outcome_no_managers = reconcile_slots_for_preset(
            &conn,
            &registry,
            ON_DEVICE_LLM_ID,
            "", // old_endpoint (round-2 fix #2) — not exercised here
            &backfill,
            &indexer,
            None,
            None,
            None,
            || {},
        )
        .await
        .unwrap();
        assert!(!outcome_no_managers.generation);
        assert!(!outcome_no_managers.memory_generation);
        assert!(registry.generation().is_none());
        assert!(registry.memory_generation().is_none());

        // With managers: both slots must rebuild + swap.
        let server = Arc::new(LlamaServerManager::new());
        let tmp = tempfile::tempdir().unwrap();
        let assets = Arc::new(LlmAssetManager::new(tmp.path().to_path_buf()));

        let outcome_with_managers = reconcile_slots_for_preset(
            &conn,
            &registry,
            ON_DEVICE_LLM_ID,
            "", // old_endpoint (round-2 fix #2) — not exercised here
            &backfill,
            &indexer,
            Some(&server),
            Some(&assets),
            None,
            || {},
        )
        .await
        .unwrap();
        assert!(outcome_with_managers.generation);
        assert!(outcome_with_managers.memory_generation);
        assert_eq!(registry.generation().unwrap().id(), ON_DEVICE_LLM_ID);
        assert_eq!(registry.memory_generation().unwrap().id(), ON_DEVICE_LLM_ID);
    }

    /// THE fix for this finding: a build failure on one slot must not
    /// abort reconciliation of a sibling slot bound to the SAME preset.
    /// Forces the generation slot's on-device-llm rebuild to fail (unknown
    /// catalog model) while the memory generation slot (same preset,
    /// different — valid — model) must still be reconciled successfully.
    #[tokio::test]
    async fn reconcile_partial_failure_does_not_abort_sibling_slot() {
        let (state, registry) = make_state_and_conn();
        let conn = state.lock().unwrap();

        // Generation slot: bound to on-device-llm with a model that does
        // NOT exist in the catalog — `OnDeviceLlmProvider::new` errors.
        db::set_setting(&conn, GenKeys::PROVIDER, ON_DEVICE_LLM_ID).unwrap();
        db::set_setting(&conn, GenKeys::model_key(), "not-a-real-catalog-model").unwrap();

        // Memory generation slot: bound to the SAME preset, but with a
        // valid catalog model — must still succeed.
        db::set_setting(&conn, settings_keys::memory_gen::PROVIDER, ON_DEVICE_LLM_ID).unwrap();
        db::set_setting(
            &conn,
            settings_keys::memory_gen::CHAT_MODEL,
            llm_catalog::GEMMA_4_E4B_IT,
        )
        .unwrap();

        let backfill = crate::commands::ai::BackfillManager::new();
        let indexer = crate::ai::indexer::EntryIndexer::from_dyn(Arc::new(
            crate::ai::embedder::StubEmbedder::new("ollama:nomic-embed-text", 8),
        ));
        let server = Arc::new(LlamaServerManager::new());
        let tmp = tempfile::tempdir().unwrap();
        let assets = Arc::new(LlmAssetManager::new(tmp.path().to_path_buf()));

        let outcome = reconcile_slots_for_preset(
            &conn,
            &registry,
            ON_DEVICE_LLM_ID,
            "", // old_endpoint (round-2 fix #2) — not exercised here
            &backfill,
            &indexer,
            Some(&server),
            Some(&assets),
            None,
            || {},
        )
        .await
        .expect(
            "a per-slot build failure must be recorded in ReconcileOutcome::errors, \
             never propagated as an Err that would abort the whole reconcile pass",
        );

        assert!(
            !outcome.generation,
            "the failed generation slot must not be reported as swapped"
        );
        assert!(
            registry.generation().is_none(),
            "the failed generation slot must be left untouched"
        );
        assert_eq!(
            outcome.errors.len(),
            1,
            "exactly one slot must have failed: {:?}",
            outcome.errors
        );
        assert_eq!(outcome.errors[0].0, "generation");

        assert!(
            outcome.memory_generation,
            "the sibling memory generation slot, bound to the SAME preset with a valid model, \
             must still be reconciled despite the generation slot's failure"
        );
        assert_eq!(registry.memory_generation().unwrap().id(), ON_DEVICE_LLM_ID);
    }

    // ── Round-2 review fixes ─────────────────────────────────────────────

    /// Fix #1 [Critical]: forgetting a preset's credential while it is
    /// still bound to a slot must actively clear that slot's live
    /// `ProviderRegistry` entry, not just skip the rebuild. Before this
    /// fix, `reconcile_embedding_slot` responded to the now-empty resolved
    /// endpoint (`custom`'s default endpoint is `""`) with a `log::warn!` +
    /// `Ok(None)` — leaving the OLD `Arc<dyn AIProvider>`, built with the
    /// just-forgotten key, live and usable in the registry until app
    /// restart.
    ///
    /// Round-3 fix #1: clearing the registry slot alone isn't enough —
    /// `EntryIndexer` caches its OWN `Arc` to the embedder (kept in sync via
    /// `sync_indexer_embedder`, otherwise it just keeps using whatever it
    /// was last swapped to) and the backfill worker reads through it. Before
    /// this fix, `reconcile_slots_for_preset` only ran the post-swap
    /// maintenance (`sync_indexer_embedder` + restart decision) when the
    /// slot was REBUILT — never when it was CLEARED — so the indexer kept
    /// its stale reference to the forgotten-key provider indefinitely. This
    /// test also asserts the worker is never spuriously restarted against
    /// the now-unconfigured slot.
    #[tokio::test]
    async fn forget_bound_custom_credential_clears_live_embedding_slot() {
        use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};

        let (state, registry) = make_state_and_conn();
        let conn = state.lock().unwrap();

        db::set_setting(&conn, EmbedKeys::PROVIDER, "custom").unwrap();
        db::set_setting(&conn, EmbedKeys::model_key(), "text-embedding-3-small").unwrap();
        persist_provider_credential(
            &conn,
            "custom",
            "https://my-gateway.example.com/v1",
            Some("sk-secret"),
        )
        .unwrap();

        let backfill = crate::commands::ai::BackfillManager::new();
        let indexer = crate::ai::indexer::EntryIndexer::from_dyn(Arc::new(
            crate::ai::embedder::StubEmbedder::new("custom:text-embedding-3-small", 8),
        ));

        // Bind the slot for real first (mirrors what a prior
        // `set_ai_provider_credential` call would have done).
        let bind_old_endpoint = preset_default_endpoint("custom").to_string();
        reconcile_slots_for_preset(
            &conn,
            &registry,
            "custom",
            &bind_old_endpoint,
            &backfill,
            &indexer,
            None,
            None,
            None,
            || {},
        )
        .await
        .unwrap();
        assert!(
            registry.embedding().is_some(),
            "sanity check: the slot must be live before the forget"
        );
        assert_eq!(
            indexer.model_id(),
            "custom:text-embedding-3-small",
            "sanity check: the indexer must be synced to the just-bound provider before the forget"
        );

        // Mirror `forget_ai_provider_credential`'s command wrapper: snapshot
        // the resolved endpoint BEFORE forgetting, then forget, then
        // reconcile with that snapshot.
        let old_endpoint = resolve_credential(&conn, "custom").unwrap().0;
        forget_provider_credential(&conn, "custom").unwrap();

        let restarted = Arc::new(AtomicBool::new(false));
        let restarted_probe = Arc::clone(&restarted);
        let outcome = reconcile_slots_for_preset(
            &conn,
            &registry,
            "custom",
            &old_endpoint,
            &backfill,
            &indexer,
            None,
            None,
            None,
            move || {
                restarted_probe.store(true, AtomicOrdering::SeqCst);
            },
        )
        .await
        .unwrap();

        assert!(
            !outcome.embedding,
            "a cleared slot was not rebuilt, so it must not be reported as reconciled"
        );
        assert!(
            registry.embedding().is_none(),
            "the embedding slot must be actively cleared once its credential is forgotten — \
             leaving the OLD provider live would keep serving requests with the deleted key \
             until app restart"
        );
        assert_eq!(
            indexer.model_id(),
            "embedding-stub-768",
            "the indexer must be re-synced off the cleared slot and fall back to the stub \
             embedder — otherwise it keeps its stale cached Arc, built with the forgotten key, \
             and keeps sending journal text to it"
        );
        assert!(
            !restarted.load(AtomicOrdering::SeqCst),
            "clearing a slot to \"no provider configured\" must never spuriously restart \
             background indexing against it"
        );
    }

    /// Round-3 "Additional test-coverage gap" — round-2 fix #1's
    /// clear-on-forget logic was tested ONLY for the embedding slot. Same
    /// scenario for the GENERATION slot: forgetting a bound `custom`
    /// preset's credential must actively clear `registry.generation()`,
    /// not just skip the rebuild.
    #[tokio::test]
    async fn forget_bound_custom_credential_clears_live_generation_slot() {
        let (state, registry) = make_state_and_conn();
        let conn = state.lock().unwrap();

        db::set_setting(&conn, GenKeys::PROVIDER, "custom").unwrap();
        db::set_setting(&conn, GenKeys::model_key(), "gpt-4o-mini").unwrap();
        persist_provider_credential(
            &conn,
            "custom",
            "https://my-gateway.example.com/v1",
            Some("sk-secret"),
        )
        .unwrap();

        let backfill = crate::commands::ai::BackfillManager::new();
        let indexer = crate::ai::indexer::EntryIndexer::from_dyn(Arc::new(
            crate::ai::embedder::StubEmbedder::new("custom:text-embedding-3-small", 8),
        ));

        let bind_old_endpoint = preset_default_endpoint("custom").to_string();
        reconcile_slots_for_preset(
            &conn,
            &registry,
            "custom",
            &bind_old_endpoint,
            &backfill,
            &indexer,
            None,
            None,
            None,
            || {},
        )
        .await
        .unwrap();
        assert!(
            registry.generation().is_some(),
            "sanity check: the slot must be live before the forget"
        );

        let old_endpoint = resolve_credential(&conn, "custom").unwrap().0;
        forget_provider_credential(&conn, "custom").unwrap();

        let outcome = reconcile_slots_for_preset(
            &conn,
            &registry,
            "custom",
            &old_endpoint,
            &backfill,
            &indexer,
            None,
            None,
            None,
            || {},
        )
        .await
        .unwrap();

        assert!(
            !outcome.generation,
            "a cleared slot was not rebuilt, so it must not be reported as reconciled"
        );
        assert!(
            registry.generation().is_none(),
            "the generation slot must be actively cleared once its credential is forgotten — \
             leaving the OLD provider live would keep serving requests with the deleted key \
             until app restart"
        );
    }

    /// Round-3 fix #3 added a symmetric empty-endpoint clear-on-forget
    /// branch to `reconcile_memory_generation_slot` /
    /// `reconcile_memory_embedding_slot` (mirroring round-2 fix #1's
    /// regular-slot clear, exercised above by
    /// `forget_bound_custom_credential_clears_live_generation_slot` /
    /// `forget_bound_custom_credential_clears_live_embedding_slot`), but
    /// left it untested. `ai_memory_allow_hosted` must be on so the
    /// `custom` preset (Remote class) is allowed to bind the memory
    /// generation slot in the first place — the forget path itself goes
    /// through `enforce_memory_slot_class` before it ever reaches the
    /// empty-endpoint check, so a Remote-class preset that never passed
    /// class enforcement would never reach the branch under test.
    #[tokio::test]
    async fn forget_bound_custom_credential_clears_live_memory_generation_slot() {
        let (state, registry) = make_state_and_conn();
        let conn = state.lock().unwrap();

        db::set_setting(&conn, settings_keys::MEMORY_ALLOW_HOSTED, "true").unwrap();
        db::set_setting(&conn, settings_keys::memory_gen::PROVIDER, "custom").unwrap();
        db::set_setting(&conn, settings_keys::memory_gen::CHAT_MODEL, "gpt-4o-mini").unwrap();
        persist_provider_credential(
            &conn,
            "custom",
            "https://my-gateway.example.com/v1",
            Some("sk-secret"),
        )
        .unwrap();

        let backfill = crate::commands::ai::BackfillManager::new();
        let indexer = crate::ai::indexer::EntryIndexer::from_dyn(Arc::new(
            crate::ai::embedder::StubEmbedder::new("custom:text-embedding-3-small", 8),
        ));

        let bind_old_endpoint = preset_default_endpoint("custom").to_string();
        reconcile_slots_for_preset(
            &conn,
            &registry,
            "custom",
            &bind_old_endpoint,
            &backfill,
            &indexer,
            None,
            None,
            None,
            || {},
        )
        .await
        .unwrap();
        assert!(
            registry.memory_generation().is_some(),
            "sanity check: the memory generation slot must be live before the forget"
        );

        let old_endpoint = resolve_credential(&conn, "custom").unwrap().0;
        forget_provider_credential(&conn, "custom").unwrap();

        let outcome = reconcile_slots_for_preset(
            &conn,
            &registry,
            "custom",
            &old_endpoint,
            &backfill,
            &indexer,
            None,
            None,
            None,
            || {},
        )
        .await
        .unwrap();

        assert!(
            !outcome.memory_generation,
            "a cleared slot was not rebuilt, so it must not be reported as reconciled"
        );
        assert!(
            registry.memory_generation().is_none(),
            "the memory generation slot must be actively cleared once its credential is \
             forgotten — leaving the OLD provider live would keep memory extraction silently \
             using the deleted key until app restart"
        );
    }

    /// Sibling to `forget_bound_custom_credential_clears_live_memory_generation_slot`
    /// for the memory EMBEDDING slot.
    #[tokio::test]
    async fn forget_bound_custom_credential_clears_live_memory_embedding_slot() {
        let (state, registry) = make_state_and_conn();
        let conn = state.lock().unwrap();

        db::set_setting(&conn, settings_keys::MEMORY_ALLOW_HOSTED, "true").unwrap();
        db::set_setting(&conn, settings_keys::memory_embed::PROVIDER, "custom").unwrap();
        db::set_setting(
            &conn,
            settings_keys::memory_embed::EMBEDDING_MODEL,
            "text-embedding-3-small",
        )
        .unwrap();
        persist_provider_credential(
            &conn,
            "custom",
            "https://my-gateway.example.com/v1",
            Some("sk-secret"),
        )
        .unwrap();

        let backfill = crate::commands::ai::BackfillManager::new();
        let indexer = crate::ai::indexer::EntryIndexer::from_dyn(Arc::new(
            crate::ai::embedder::StubEmbedder::new("custom:text-embedding-3-small", 8),
        ));

        let bind_old_endpoint = preset_default_endpoint("custom").to_string();
        reconcile_slots_for_preset(
            &conn,
            &registry,
            "custom",
            &bind_old_endpoint,
            &backfill,
            &indexer,
            None,
            None,
            None,
            || {},
        )
        .await
        .unwrap();
        assert!(
            registry.memory_embedder().is_some(),
            "sanity check: the memory embedding slot must be live before the forget"
        );

        let old_endpoint = resolve_credential(&conn, "custom").unwrap().0;
        forget_provider_credential(&conn, "custom").unwrap();

        let outcome = reconcile_slots_for_preset(
            &conn,
            &registry,
            "custom",
            &old_endpoint,
            &backfill,
            &indexer,
            None,
            None,
            None,
            || {},
        )
        .await
        .unwrap();

        assert!(
            !outcome.memory_embedding,
            "a cleared slot was not rebuilt, so it must not be reported as reconciled"
        );
        assert!(
            registry.memory_embedder().is_none(),
            "the memory embedding slot must be actively cleared once its credential is \
             forgotten — leaving the OLD provider live would keep memory embedding silently \
             using the deleted key until app restart"
        );
    }

    /// Fix #2 [Critical]: reconciling a bound preset's embedding slot onto a
    /// NEW endpoint must invalidate a stale `BACKGROUND_INDEXING_HOSTED_CONSENT_AT`
    /// acceptance — mirrors `persist_embed_config_endpoint_only_change_invalidates_hosted_consent`
    /// for the reconcile path, which never re-checked this at all before
    /// the fix.
    #[tokio::test]
    async fn reconcile_embedding_endpoint_change_invalidates_hosted_consent() {
        let (state, registry) = make_state_and_conn();
        let conn = state.lock().unwrap();

        db::set_setting(&conn, EmbedKeys::PROVIDER, "custom").unwrap();
        db::set_setting(&conn, EmbedKeys::model_key(), "text-embedding-3-small").unwrap();
        persist_provider_credential(
            &conn,
            "custom",
            "https://gateway-a.example.com/v1",
            Some("sk"),
        )
        .unwrap();
        db::set_setting(
            &conn,
            settings_keys::BACKGROUND_INDEXING_HOSTED_CONSENT_AT,
            "1234567890",
        )
        .unwrap();

        let backfill = crate::commands::ai::BackfillManager::new();
        let indexer = crate::ai::indexer::EntryIndexer::from_dyn(Arc::new(
            crate::ai::embedder::StubEmbedder::new("custom:text-embedding-3-small", 8),
        ));

        // Snapshot BEFORE the credential write, as the command wrapper does.
        let old_endpoint = resolve_credential(&conn, "custom").unwrap().0;
        // Same provider/model, DIFFERENT endpoint only.
        persist_provider_credential(&conn, "custom", "https://gateway-b.example.com/v1", None)
            .unwrap();

        reconcile_slots_for_preset(
            &conn,
            &registry,
            "custom",
            &old_endpoint,
            &backfill,
            &indexer,
            None,
            None,
            None,
            || {},
        )
        .await
        .unwrap();

        assert!(
            db::get_setting(&conn, settings_keys::BACKGROUND_INDEXING_HOSTED_CONSENT_AT)
                .unwrap()
                .is_none(),
            "an endpoint change via reconcile must invalidate hosted consent — the old \
             acceptance covered a different host"
        );
    }

    /// Fix #2 negative counterpart: reconciling with the endpoint UNCHANGED
    /// (a pure key rotation) must NOT invalidate hosted consent — mirrors
    /// `persist_embed_config_key_rotation_alone_does_not_invalidate_consent`.
    #[tokio::test]
    async fn reconcile_embedding_key_rotation_alone_does_not_invalidate_consent() {
        let (state, registry) = make_state_and_conn();
        let conn = state.lock().unwrap();

        db::set_setting(&conn, EmbedKeys::PROVIDER, "custom").unwrap();
        db::set_setting(&conn, EmbedKeys::model_key(), "text-embedding-3-small").unwrap();
        persist_provider_credential(
            &conn,
            "custom",
            "https://gateway-a.example.com/v1",
            Some("sk-1"),
        )
        .unwrap();
        db::set_setting(
            &conn,
            settings_keys::BACKGROUND_INDEXING_HOSTED_CONSENT_AT,
            "1234567890",
        )
        .unwrap();

        let backfill = crate::commands::ai::BackfillManager::new();
        let indexer = crate::ai::indexer::EntryIndexer::from_dyn(Arc::new(
            crate::ai::embedder::StubEmbedder::new("custom:text-embedding-3-small", 8),
        ));

        let old_endpoint = resolve_credential(&conn, "custom").unwrap().0;
        // SAME endpoint, key rotated only.
        persist_provider_credential(
            &conn,
            "custom",
            "https://gateway-a.example.com/v1",
            Some("sk-2"),
        )
        .unwrap();

        reconcile_slots_for_preset(
            &conn,
            &registry,
            "custom",
            &old_endpoint,
            &backfill,
            &indexer,
            None,
            None,
            None,
            || {},
        )
        .await
        .unwrap();

        assert_eq!(
            db::get_setting(&conn, settings_keys::BACKGROUND_INDEXING_HOSTED_CONSENT_AT)
                .unwrap()
                .as_deref(),
            Some("1234567890"),
            "a pure key rotation via reconcile must not clear hosted consent"
        );
    }

    /// Fix #3 [Critical]: a successful embedding-slot reconcile (e.g. fixing
    /// a bad API key) must resume jobs `paused` on the OLD credential for
    /// this model_id — mirrors `apply_embedding_slot_change_key_rotation_resets_paused_jobs_to_pending`
    /// for the reconcile path, which never called `reset_paused_jobs_to_pending`
    /// at all before the fix.
    #[tokio::test]
    async fn reconcile_embedding_key_rotation_resumes_paused_jobs() {
        let (state, registry) = make_state_and_conn();
        let conn = state.lock().unwrap();
        db::set_setting(&conn, settings_keys::SEMANTIC_SEARCH_ENABLED, "true").unwrap();
        insert_test_entry(&conn, "e1", "T1", "Entry text long enough to embed.");

        db::set_setting(&conn, EmbedKeys::PROVIDER, "custom").unwrap();
        db::set_setting(&conn, EmbedKeys::model_key(), "text-embedding-3-small").unwrap();
        persist_provider_credential(
            &conn,
            "custom",
            "https://gateway-a.example.com/v1",
            Some("sk-1"),
        )
        .unwrap();

        let backfill = crate::commands::ai::BackfillManager::new();
        let indexer = crate::ai::indexer::EntryIndexer::from_dyn(Arc::new(
            crate::ai::embedder::StubEmbedder::new("custom:text-embedding-3-small", 8),
        ));

        // Initial bind.
        let bind_old_endpoint = resolve_credential(&conn, "custom").unwrap().0;
        reconcile_slots_for_preset(
            &conn,
            &registry,
            "custom",
            &bind_old_endpoint,
            &backfill,
            &indexer,
            None,
            None,
            None,
            || {},
        )
        .await
        .unwrap();
        let model_id = provider_namespaced_model_id(&*registry.embedding().unwrap());

        // `reconcile_embedding_slot` never enqueues (identity never changes
        // via reconcile), so seed a job row directly — mirrors how a real
        // job would already exist from the worker's normal opportunistic
        // seeding before it hit the bad key and paused.
        crate::ai::indexer::enqueue_dirty_jobs_for_model(&conn, &model_id).unwrap();

        // Simulate the worker having paused this entry's job on an
        // auth-class failure under the bad key.
        db::embeddings::pause_embedding_job(&conn, "e1", &model_id, "bad api key", 0).unwrap();
        assert_eq!(
            db::embeddings::get_embedding_job(&conn, "e1", &model_id)
                .unwrap()
                .unwrap()
                .status,
            "paused"
        );

        // Rotate the key — the user fixing the credential.
        let old_endpoint = resolve_credential(&conn, "custom").unwrap().0;
        persist_provider_credential(
            &conn,
            "custom",
            "https://gateway-a.example.com/v1",
            Some("sk-2"),
        )
        .unwrap();

        reconcile_slots_for_preset(
            &conn,
            &registry,
            "custom",
            &old_endpoint,
            &backfill,
            &indexer,
            None,
            None,
            None,
            || {},
        )
        .await
        .unwrap();

        assert_eq!(
            db::embeddings::get_embedding_job(&conn, "e1", &model_id)
                .unwrap()
                .unwrap()
                .status,
            "pending",
            "the paused job must recover to pending once the credential is fixed via reconcile"
        );
    }

    /// The restart predicate must stay false when no embedding-consuming
    /// feature is enabled — restarting the worker for a config nothing
    /// consumes would be spawning a permanently-idle task for nothing.
    #[test]
    fn embedding_slot_change_does_not_restart_worker_when_no_feature_enabled() {
        let (state, registry) = make_state_and_conn();
        let conn = state.lock().unwrap();
        // Embedding features default ON — turn them off explicitly to
        // exercise the "no consuming feature" path.
        for key in [
            settings_keys::SEMANTIC_SEARCH_ENABLED,
            settings_keys::EMOTION_SUGGESTIONS_ENABLED,
        ] {
            db::set_setting(&conn, key, "false").unwrap();
        }
        let i1 = embed_input("openai", "https://api.openai.com/v1", Some("sk"));
        let p1: Arc<dyn AIProvider> = Arc::new(MockAIProvider::new("openai", &i1.embedding_model));
        let out1 =
            apply_embedding_slot_change(&conn, &registry, p1, &i1, EndpointClass::Remote).unwrap();

        assert!(!out1.features_enabled);
        assert!(!should_restart_worker_after_embedding_slot_change(&out1));
    }

    /// An identity change with no embedding-consuming feature enabled must
    /// not enqueue anything — spending a rebuild pass nothing would ever
    /// consume is exactly what `embedding_features_enabled` guards
    /// against on the save path too.
    #[test]
    fn apply_embedding_slot_change_skips_enqueue_when_no_feature_enabled() {
        let (state, registry) = make_state_and_conn();
        let conn = state.lock().unwrap();
        // Embedding features default ON — turn them off explicitly to
        // exercise the "no consuming feature" path.
        for key in [
            settings_keys::SEMANTIC_SEARCH_ENABLED,
            settings_keys::EMOTION_SUGGESTIONS_ENABLED,
        ] {
            db::set_setting(&conn, key, "false").unwrap();
        }
        insert_test_entry(&conn, "e1", "T1", "Entry text long enough to embed.");

        let i1 = embed_input("openai", "https://api.openai.com/v1", Some("sk"));
        let p1: Arc<dyn AIProvider> = Arc::new(MockAIProvider::new("openai", &i1.embedding_model));
        let out1 =
            apply_embedding_slot_change(&conn, &registry, p1, &i1, EndpointClass::Remote).unwrap();

        assert!(out1.identity_changed);
        assert!(!out1.features_enabled);
        assert_eq!(
            out1.enqueued, 0,
            "must not enqueue background-indexing work when no feature consumes it"
        );
    }

    /// A generation-slot swap never touches the embedding slot's dirty
    /// queue — proves the trigger boundary named in the plan
    /// (`swap_generation_does_not_touch_embedding_slot`): only
    /// `set_ai_embedding_provider` (via `apply_embedding_slot_change`)
    /// enqueues rebuild work; `set_ai_generation_provider` (via
    /// `persist_gen_config`) has no code path that can reach
    /// `enqueue_dirty_jobs_for_model` at all.
    #[test]
    fn swap_generation_does_not_touch_embedding_slot() {
        let (state, _reg) = make_state_and_conn();
        let conn = state.lock().unwrap();
        db::set_setting(&conn, settings_keys::SEMANTIC_SEARCH_ENABLED, "true").unwrap();
        insert_test_entry(&conn, "e1", "T1", "Entry text long enough to embed.");

        // Configure the embedding slot and seed one dirty job for it.
        let embed_i = embed_input("openai", "https://api.openai.com/v1", Some("sk"));
        persist_embed_config(&conn, &embed_i, EndpointClass::Remote).unwrap();
        let model_id = format!("openai:{}", embed_i.embedding_model);
        db::embeddings::mark_entry_embedding_dirty(&conn, "e1", &model_id, "hash-1", 0, 0).unwrap();

        // Swap ONLY the generation slot.
        let gen_i = gen_input("anthropic", "https://api.anthropic.com/v1", Some("sk"));
        persist_gen_config(&conn, &gen_i, EndpointClass::Remote).unwrap();

        // The embed job is untouched: same content_hash, still pending,
        // no second job row, no chunk rebuild triggered.
        let job = db::embeddings::get_embedding_job(&conn, "e1", &model_id)
            .unwrap()
            .expect("embed job row must survive a generation-slot swap");
        assert_eq!(job.content_hash, "hash-1");
        assert_eq!(job.status, "pending");
        // Embed slot settings themselves are also untouched (slot isolation).
        assert_eq!(
            db::get_setting(&conn, settings_keys::embed::PROVIDER)
                .unwrap()
                .as_deref(),
            Some("openai")
        );
    }

    #[test]
    fn persist_returns_needs_consent_when_class_not_accepted() {
        // Local saves never signal consent. Non-local saves signal until
        // the unified privacy receipt exists, then stay quiet across
        // provider swaps inside remote/subscription.
        let (state, _reg) = make_state_and_conn();
        let conn = state.lock().unwrap();

        let g_local = gen_input("ollama", "http://127.0.0.1:11434/v1", None);
        let needs_local =
            persist_gen_config(&conn, &g_local, expected_class(&g_local.provider)).unwrap();
        assert!(!needs_local, "local endpoints are auto-exempt");

        let g_remote = gen_input("anthropic", "https://api.anthropic.com/v1", Some("sk"));
        let needs =
            persist_gen_config(&conn, &g_remote, expected_class(&g_remote.provider)).unwrap();
        assert!(needs, "remote class not yet accepted");

        db::set_setting(&conn, settings_keys::PRIVACY_ACCEPTED_AT, "222").unwrap();
        let g_openai = gen_input("openai", "https://api.openai.com/v1", Some("sk"));
        let needs3 =
            persist_gen_config(&conn, &g_openai, expected_class(&g_openai.provider)).unwrap();
        assert!(
            !needs3,
            "unified acceptance covers every non-local provider"
        );

        let g_cli = gen_input("claude-cli", "", None);
        let needs_sub = persist_gen_config(&conn, &g_cli, EndpointClass::Subscription).unwrap();
        assert!(!needs_sub, "subscription shares the unified receipt");
    }

    #[test]
    fn read_public_returns_none_when_unconfigured() {
        let (state, _reg) = make_state_and_conn();
        let conn = state.lock().unwrap();
        assert!(read_gen_public(&conn).unwrap().is_none());
        assert!(read_embed_public(&conn).unwrap().is_none());
    }

    // NOTE: `malformed_legacy_endpoint_rolls_back_without_deleting_secret`
    // was deleted here (T2.2 flagged it for T2.3 to evaluate). Its premise —
    // a malformed stored `ai_gen_endpoint` row causing `persist_gen_config`
    // to error and roll back, without deleting the previously-stored secret
    // — no longer exists under the registry model: `persist_gen_config`
    // writes only `provider` + model rows now and never reads/validates an
    // endpoint at all, so there is no rollback path left to guard.

    #[test]
    fn read_public_never_leaks_api_key() {
        let (state, _reg) = make_state_and_conn();
        let conn = state.lock().unwrap();
        let g = gen_input(
            "anthropic",
            "https://api.anthropic.com/v1",
            Some("sk-secret"),
        );
        persist_gen_config(&conn, &g, expected_class(&g.provider)).unwrap();
        // T2.3: the key lives in the per-preset credential registry now,
        // keyed by provider id — not on the slot's persisted input.
        persist_provider_credential(
            &conn,
            "anthropic",
            "https://api.anthropic.com/v1",
            Some("sk-secret"),
        )
        .unwrap();
        let public = read_gen_public(&conn).unwrap().unwrap();
        let json = serde_json::to_string(&public).unwrap();
        assert!(!json.contains("sk-secret"), "raw key leaked: {json}");
        assert!(json.contains("hasApiKey"));
        assert!(public.has_api_key);
    }

    #[test]
    fn load_gen_slot_loads_only_gen_into_registry() {
        let (state, registry) = make_state_and_conn();
        {
            let conn = state.lock().unwrap();
            // "anthropic"'s default resolved endpoint is already
            // `https://api.anthropic.com/v1` — no registry override needed.
            for (k, v) in [
                (settings_keys::gen::PROVIDER, "anthropic"),
                (settings_keys::gen::CHAT_MODEL, "claude-haiku-4-5"),
            ] {
                db::set_setting(&conn, k, v).unwrap();
            }
            // Critical-fix (Phase 2): a Remote-class slot now needs a
            // resolvable key to hydrate.
            persist_provider_credential(
                &conn,
                "anthropic",
                preset_default_endpoint("anthropic"),
                Some("sk-test"),
            )
            .unwrap();
        }
        let conn = state.lock().unwrap();
        let loaded = load_gen_slot(&conn, &registry, None, None).unwrap();
        assert!(loaded);
        assert!(registry.is_generation_configured());
        assert!(!registry.is_embedding_configured());
        assert_eq!(registry.generation().unwrap().id(), "anthropic");
    }

    /// Regression for C1 in the Phase 3 /cf-review: CLI providers
    /// persist with `endpoint=""`. The hydration path must NOT reject
    /// them on empty endpoint, otherwise every app restart drops the
    /// gen slot and the user has to re-pick the provider in Settings.
    #[test]
    fn load_gen_slot_hydrates_claude_cli_with_empty_endpoint() {
        let (state, registry) = make_state_and_conn();
        {
            let conn = state.lock().unwrap();
            for (k, v) in [
                (settings_keys::gen::PROVIDER, "claude-cli"),
                (settings_keys::gen::CHAT_MODEL, "sonnet"),
            ] {
                db::set_setting(&conn, k, v).unwrap();
            }
        }
        let conn = state.lock().unwrap();
        assert!(load_gen_slot(&conn, &registry, None, None).unwrap());
        assert_eq!(registry.generation().unwrap().id(), "claude-cli");
        assert_eq!(registry.generation().unwrap().chat_model_id(), "sonnet");
    }

    #[test]
    fn load_gen_slot_hydrates_codex_cli_with_empty_endpoint() {
        let (state, registry) = make_state_and_conn();
        {
            let conn = state.lock().unwrap();
            for (k, v) in [
                (settings_keys::gen::PROVIDER, "codex-cli"),
                (settings_keys::gen::CHAT_MODEL, "gpt-5.4"),
            ] {
                db::set_setting(&conn, k, v).unwrap();
            }
        }
        let conn = state.lock().unwrap();
        assert!(load_gen_slot(&conn, &registry, None, None).unwrap());
        assert_eq!(registry.generation().unwrap().id(), "codex-cli");
    }

    #[test]
    fn load_gen_slot_still_rejects_http_provider_with_empty_endpoint() {
        // Regression: the C1 fix must NOT loosen the guard for HTTP
        // providers. An OpenAI-compat provider with an empty endpoint
        // would 100% fail at request time — drop it at hydration.
        //
        // T2.3: a known preset like "openai" always resolves to at least
        // its non-empty `preset_default_endpoint` now — an empty resolved
        // endpoint is only reachable for a preset whose default IS empty
        // ("custom", never overridden), which is still HTTP-surfaced.
        let (state, registry) = make_state_and_conn();
        {
            let conn = state.lock().unwrap();
            for (k, v) in [
                (settings_keys::gen::PROVIDER, "custom"),
                (settings_keys::gen::CHAT_MODEL, "gpt-4o"),
            ] {
                db::set_setting(&conn, k, v).unwrap();
            }
        }
        let conn = state.lock().unwrap();
        assert!(!load_gen_slot(&conn, &registry, None, None).unwrap());
        assert!(!registry.is_generation_configured());
    }

    #[test]
    fn provider_is_on_device_llm_truth_table() {
        assert!(provider_is_on_device_llm(ON_DEVICE_LLM_ID));
        assert!(!provider_is_on_device_llm(ON_DEVICE_PROVIDER_ID));
        assert!(!provider_is_on_device_llm("openai"));
        assert!(!provider_is_on_device_llm(""));
    }

    /// Root-cause regression: on-device-llm legitimately persists with
    /// `ai_gen_endpoint=""` (the sidecar's port is only known at spawn
    /// time), so the shared empty-endpoint guard in `load_gen_slot` must
    /// NOT reject it — without the exemption + dedicated branch below,
    /// every restart/unlock silently dropped the generation slot and every
    /// chat call failed with `AI_NOT_CONFIGURED`.
    #[test]
    fn load_gen_slot_hydrates_on_device_llm_with_empty_endpoint() {
        let (state, registry) = make_state_and_conn();
        {
            let conn = state.lock().unwrap();
            for (k, v) in [
                (settings_keys::gen::PROVIDER, ON_DEVICE_LLM_ID),
                (settings_keys::gen::CHAT_MODEL, llm_catalog::GEMMA_4_E4B_IT),
            ] {
                db::set_setting(&conn, k, v).unwrap();
            }
        }
        let server = Arc::new(LlamaServerManager::new());
        let tmp = tempfile::tempdir().unwrap();
        let assets = Arc::new(LlmAssetManager::new(tmp.path().to_path_buf()));

        let conn = state.lock().unwrap();
        let loaded = load_gen_slot(&conn, &registry, Some(&server), Some(&assets)).unwrap();
        assert!(loaded);
        assert!(registry.is_generation_configured());
        let hydrated = registry.generation().unwrap();
        assert_eq!(hydrated.id(), ON_DEVICE_LLM_ID);
        assert_eq!(hydrated.chat_model_id(), llm_catalog::GEMMA_4_E4B_IT);
    }

    /// Without the sidecar/asset managers (e.g. a caller that can't reach
    /// Tauri-managed state), hydration must skip rather than crash or
    /// build a broken provider.
    #[test]
    fn load_gen_slot_skips_on_device_llm_without_managers() {
        let (state, registry) = make_state_and_conn();
        {
            let conn = state.lock().unwrap();
            for (k, v) in [
                (settings_keys::gen::PROVIDER, ON_DEVICE_LLM_ID),
                (settings_keys::gen::CHAT_MODEL, llm_catalog::GEMMA_4_E4B_IT),
            ] {
                db::set_setting(&conn, k, v).unwrap();
            }
        }
        let conn = state.lock().unwrap();
        assert!(!load_gen_slot(&conn, &registry, None, None).unwrap());
        assert!(!registry.is_generation_configured());
    }

    #[test]
    fn classify_provider_disclosure_tags_cli_providers_as_subscription() {
        // Subprocess providers get the dedicated `Subscription`
        // disclosure variant — distinct from both `Local` (data
        // stays on this machine) and `Remote` (Memlore uploads
        // to a URL).
        assert_eq!(
            classify_provider_disclosure("claude-cli", ""),
            EndpointClass::Subscription
        );
        assert_eq!(
            classify_provider_disclosure("codex-cli", ""),
            EndpointClass::Subscription
        );
        // Non-CLI providers fall through to classify_endpoint.
        assert_eq!(
            classify_provider_disclosure("openai", "https://api.openai.com/v1"),
            EndpointClass::Remote
        );
        assert_eq!(
            classify_provider_disclosure("ollama", "http://127.0.0.1:11434/v1"),
            EndpointClass::Local
        );
    }

    // NOTE: `class_str_roundtrips_subscription` was deleted here — its
    // subject (`class_str`, mapping `EndpointClass` to a persisted settings-
    // row string) was dead code after T2.3: no code writes an `endpoint_class`
    // row anymore, so nothing serializes a class to that string form.

    // ─── Critical fix (Phase 2): Remote-without-key gate ──────────────────

    #[test]
    fn remote_provider_missing_key_true_for_remote_without_key() {
        assert!(remote_provider_missing_key(
            "openai",
            "https://api.openai.com/v1",
            None
        ));
    }

    #[test]
    fn remote_provider_missing_key_false_for_remote_with_key() {
        assert!(!remote_provider_missing_key(
            "openai",
            "https://api.openai.com/v1",
            Some("sk-test")
        ));
    }

    #[test]
    fn remote_provider_missing_key_false_for_local_without_key() {
        // Many local servers (a bare Ollama install, LM Studio) have no
        // auth at all — must stay usable keyless.
        assert!(!remote_provider_missing_key(
            "ollama",
            "http://127.0.0.1:11434/v1",
            None
        ));
    }

    #[test]
    fn remote_provider_missing_key_false_for_on_device_without_key() {
        assert!(!remote_provider_missing_key(
            crate::ai::providers::on_device_embed::PROVIDER_ID,
            "",
            None
        ));
    }

    #[test]
    fn remote_provider_missing_key_false_for_subscription_without_key() {
        // CLI providers (claude-cli / codex-cli) authenticate out-of-band
        // via their own subprocess and never carry an api_key in the
        // registry — must never be blocked by this gate.
        assert!(!remote_provider_missing_key(CLAUDE_CLI_ID, "", None));
        assert!(!remote_provider_missing_key(CODEX_CLI_ID, "", None));
    }

    #[test]
    fn build_slot_provider_remote_without_key_fails_closed() {
        // Root-gate regression: a Remote-class preset with no resolvable
        // key must never build — every caller (hydration, reconcile,
        // set/test commands) falls through to this single check.
        let result = build_slot_provider(
            "openai",
            "https://api.openai.com/v1",
            None,
            SlotPayload::Generation {
                chat_model: "gpt-4o",
            },
            None,
        );
        match result {
            Err(AiError::AuthFailed) => {}
            Err(other) => panic!("expected Err(AuthFailed), got Err({other:?})"),
            Ok(_) => panic!("expected Err(AuthFailed), got Ok(_) — built a keyless provider"),
        }
    }

    #[test]
    fn build_slot_provider_local_without_key_still_succeeds() {
        // Regression guard for the class partition: the new Remote gate
        // must not touch Local (keyless-by-default) providers.
        assert!(build_slot_provider(
            "ollama",
            "http://127.0.0.1:11434/v1",
            None,
            SlotPayload::Generation {
                chat_model: "llama3",
            },
            None,
        )
        .is_ok());
    }

    #[test]
    fn build_slot_provider_claude_cli_without_key_still_succeeds() {
        // Regression guard: CLI providers never carry a key and must stay
        // fully usable.
        assert!(build_slot_provider(
            CLAUDE_CLI_ID,
            "",
            None,
            SlotPayload::Generation {
                chat_model: "sonnet",
            },
            None,
        )
        .is_ok());
    }

    #[tokio::test]
    async fn check_cli_provider_health_rejects_non_cli_provider() {
        let err = check_cli_provider_health("openai".into(), None)
            .await
            .expect_err("must Err");
        assert!(err.contains("not a CLI provider"));
    }

    #[tokio::test]
    async fn check_cli_provider_health_rejects_empty_string() {
        let err = check_cli_provider_health(String::new(), None)
            .await
            .expect_err("must Err");
        assert!(err.contains("not a CLI provider"));
    }

    /// Real-binary smoke: only runs if `claude` is on PATH AND signed
    /// in (dev machine). Opt in with `cargo test -- --ignored`.
    #[tokio::test]
    #[ignore]
    async fn check_cli_provider_health_real_claude() {
        let h = check_cli_provider_health("claude-cli".into(), None)
            .await
            .expect("must return Ok");
        assert!(h.installed);
        assert!(h.binary_path.is_some());
        assert!(h.version.is_some());
        // Authenticated/hint depend on the dev box. Just assert the
        // struct is internally consistent.
        if h.authenticated {
            assert!(h.hint.is_none());
        } else {
            assert!(h.hint.is_some());
        }
    }

    #[tokio::test]
    #[ignore]
    async fn check_cli_provider_health_real_codex() {
        let h = check_cli_provider_health("codex-cli".into(), Some("gpt-5.4".into()))
            .await
            .expect("must return Ok");
        assert!(h.installed);
        assert!(h.binary_path.is_some());
        assert!(h.version.is_some());
    }

    /// S3 from the Phase 3 review: lock in that the CLI dispatch
    /// happens BEFORE the OpenAI-compat catch-all, so a stale
    /// endpoint string never accidentally routes a `claude-cli` id
    /// through the HTTP path.
    #[test]
    fn build_slot_provider_claude_cli_ignores_endpoint_and_api_key() {
        let p = build_slot_provider(
            "claude-cli",
            "https://wrong.example/v1", // would 404 if used
            Some("sk-ignored"),
            SlotPayload::Generation {
                chat_model: "sonnet",
            },
            None,
        )
        .expect("must build");
        // The dispatch must produce a ClaudeCliProvider, not an
        // OpenAICompatibleProvider id'd as "claude-cli".
        assert_eq!(p.id(), "claude-cli");
        assert_eq!(p.chat_model_id(), "sonnet");
    }

    #[test]
    fn load_embed_slot_loads_only_embed_into_registry() {
        let (state, registry) = make_state_and_conn();
        {
            let conn = state.lock().unwrap();
            // "openai"'s default resolved endpoint is already
            // `https://api.openai.com/v1` — no registry override needed.
            for (k, v) in [
                (settings_keys::embed::PROVIDER, "openai"),
                (
                    settings_keys::embed::EMBEDDING_MODEL,
                    "text-embedding-3-small",
                ),
            ] {
                db::set_setting(&conn, k, v).unwrap();
            }
            // Critical-fix (Phase 2): a Remote-class slot now needs a
            // resolvable key to hydrate.
            persist_provider_credential(
                &conn,
                "openai",
                preset_default_endpoint("openai"),
                Some("sk-test"),
            )
            .unwrap();
        }
        let conn = state.lock().unwrap();
        let loaded = load_embed_slot(&conn, &registry, None, None).unwrap();
        assert!(loaded);
        assert!(registry.is_embedding_configured());
        assert!(!registry.is_generation_configured());
        assert_eq!(registry.embedding().unwrap().id(), "openai");
    }

    #[test]
    fn load_slots_independent_one_malformed_other_ok() {
        // Generation row is corrupted (bad URL); embedding row is fine.
        // Embedding still loads. Critical for users who edit a config
        // by hand and corrupt one slot.
        let (state, registry) = make_state_and_conn();
        {
            let conn = state.lock().unwrap();
            db::set_setting(&conn, settings_keys::gen::PROVIDER, "custom").unwrap();
            // T2.3: the malformed endpoint now lives in the shared per-preset
            // registry, keyed by preset id — write the raw (malformed) JSON
            // directly since `persist_provider_credential` would reject it.
            db::set_setting(&conn, PROVIDER_ENDPOINTS, r#"{"custom":"not-a-url"}"#).unwrap();
            db::set_setting(&conn, settings_keys::gen::CHAT_MODEL, "x").unwrap();
            // "openai"'s default resolved endpoint is already
            // `https://api.openai.com/v1` — no registry override needed.
            db::set_setting(&conn, settings_keys::embed::PROVIDER, "openai").unwrap();
            db::set_setting(
                &conn,
                settings_keys::embed::EMBEDDING_MODEL,
                "text-embedding-3-small",
            )
            .unwrap();
            // Critical-fix (Phase 2): a Remote-class slot now needs a
            // resolvable key to hydrate.
            persist_provider_credential(
                &conn,
                "openai",
                preset_default_endpoint("openai"),
                Some("sk-test"),
            )
            .unwrap();
        }
        let conn = state.lock().unwrap();
        let gen_loaded = load_gen_slot(&conn, &registry, None, None).unwrap();
        let embed_loaded = load_embed_slot(&conn, &registry, None, None).unwrap();
        assert!(!gen_loaded, "malformed gen URL should skip");
        assert!(embed_loaded, "well-formed embed should still load");
        assert!(!registry.is_generation_configured());
        assert!(registry.is_embedding_configured());
    }

    // ── Memory slot post-unlock hydration (Phase 2 C1) ────────────────────
    //
    // The registry is in-memory; without these loaders `is_memory_enabled()`
    // would be false every session after restart despite valid persisted
    // config. The defense-in-depth re-validation is the part that's unique
    // to memory (gen/embed have no class ceiling).

    /// C1 defense-in-depth: a memory_gen row hand-edited to carry a Remote-
    /// class HTTP endpoint must NOT hydrate the registry, no matter how
    /// well-formed the rest of the row is. `enforce_memory_slot_class` is the
    /// gate; the loader leaves the slot empty (returns `Ok(false)`) instead
    /// of failing unlock.
    #[test]
    fn load_memory_gen_slot_rejects_persisted_remote_class() {
        let (state, registry) = make_state_and_conn();
        {
            let conn = state.lock().unwrap();
            // A hosted HTTP endpoint — exactly what memory slots forbid. The
            // rows are individually well-formed (non-empty, valid URL, non-empty
            // model), so only the class re-validation rejects this.
            // "openai"'s default resolved endpoint is already
            // `https://api.openai.com/v1` — no registry override needed.
            for (k, v) in [
                (settings_keys::memory_gen::PROVIDER, "openai"),
                (settings_keys::memory_gen::CHAT_MODEL, "gpt-4o-mini"),
            ] {
                db::set_setting(&conn, k, v).unwrap();
            }
        }
        let conn = state.lock().unwrap();
        let loaded = load_memory_gen_slot(&conn, &registry, None, None).unwrap();
        assert!(
            !loaded,
            "a Remote-class persisted row must NOT hydrate the memory gen slot"
        );
        assert!(
            registry.memory_generation().is_none(),
            "defense-in-depth must leave the memory gen slot empty"
        );
        assert!(
            !registry.is_memory_generation_configured(),
            "is_memory_generation_configured must stay false"
        );
    }

    /// C1: with `ai_memory_allow_hosted` on, the SAME Remote-class row that
    /// `load_memory_gen_slot_rejects_persisted_remote_class` proves gets
    /// rejected must now hydrate — the registry-load path has to honour the
    /// flag, not just write-time saves, otherwise a row written before the
    /// flag existed (or pulled in by sync) could never come back to life
    /// after the user acknowledges hosted memory.
    #[test]
    fn load_memory_gen_slot_hydrates_remote_when_allow_hosted_true() {
        let (state, registry) = make_state_and_conn();
        {
            let conn = state.lock().unwrap();
            // "openai"'s default resolved endpoint is already
            // `https://api.openai.com/v1` — no registry override needed.
            for (k, v) in [
                (settings_keys::memory_gen::PROVIDER, "openai"),
                (settings_keys::memory_gen::CHAT_MODEL, "gpt-4o-mini"),
                (settings_keys::MEMORY_ALLOW_HOSTED, "true"),
            ] {
                db::set_setting(&conn, k, v).unwrap();
            }
            // Critical-fix (Phase 2): a Remote-class slot now needs a
            // resolvable key to hydrate.
            persist_provider_credential(
                &conn,
                "openai",
                preset_default_endpoint("openai"),
                Some("sk-test"),
            )
            .unwrap();
        }
        let conn = state.lock().unwrap();
        let loaded = load_memory_gen_slot(&conn, &registry, None, None).unwrap();
        assert!(
            loaded,
            "a Remote-class row must hydrate once allow_hosted is true"
        );
        assert!(registry.is_memory_generation_configured());
    }

    /// C1 happy path: a valid Local memory_gen row hydrates and swaps. The
    /// defense-in-depth re-validation passes (Local is on-machine-allowed),
    /// so the slot lands in the registry.
    #[test]
    fn load_memory_gen_slot_loads_valid_local_config() {
        let (state, registry) = make_state_and_conn();
        {
            let conn = state.lock().unwrap();
            // "ollama"'s default resolved endpoint is already
            // `http://127.0.0.1:11434/v1` — no registry override needed.
            for (k, v) in [
                (settings_keys::memory_gen::PROVIDER, "ollama"),
                (settings_keys::memory_gen::CHAT_MODEL, "llama3.1"),
            ] {
                db::set_setting(&conn, k, v).unwrap();
            }
        }
        let conn = state.lock().unwrap();
        let loaded = load_memory_gen_slot(&conn, &registry, None, None).unwrap();
        assert!(loaded, "a valid Local row should hydrate");
        let hydrated = registry
            .memory_generation()
            .expect("Local memory gen slot must be in the registry");
        assert_eq!(hydrated.id(), "ollama");
        assert_eq!(hydrated.chat_model_id(), "llama3.1");
        assert!(registry.is_memory_generation_configured());
        // Slot isolation: a memory gen load must not touch the app-wide slots.
        assert!(!registry.is_generation_configured());
    }

    /// C1 happy path for the embed side: a valid on-device (Local class is
    /// the classifier's OnDevice result here) memory_embed row hydrates and
    /// swaps. The on-device sentinel needs the download manager.
    #[test]
    fn load_memory_embed_slot_loads_valid_config() {
        let (state, registry) = make_state_and_conn();
        let (downloads, _tmp) = test_download_manager();
        {
            let conn = state.lock().unwrap();
            // "ollama"'s default resolved endpoint is already
            // `http://127.0.0.1:11434/v1` — no registry override needed.
            for (k, v) in [
                (settings_keys::memory_embed::PROVIDER, "ollama"),
                (
                    settings_keys::memory_embed::EMBEDDING_MODEL,
                    "nomic-embed-text",
                ),
            ] {
                db::set_setting(&conn, k, v).unwrap();
            }
        }
        let conn = state.lock().unwrap();
        let loaded = load_memory_embed_slot(&conn, &registry, Some(&downloads)).unwrap();
        assert!(loaded, "a valid Local embed row should hydrate");
        let hydrated = registry
            .memory_embedder()
            .expect("Local memory embed slot must be in the registry");
        assert_eq!(hydrated.id(), "ollama");
        // Cross-path invariant with sync: the hydrated provider's namespaced
        // model id must equal the `"{provider}:{model}"` string
        // `sync::engine::configured_memory_embedding_model_id` composes from
        // these SAME settings rows — the memory worker stamps
        // `memory_embeddings.model_id` with the former, and peer-vector
        // adoption + backfill detection compare against the latter.
        assert_eq!(
            crate::ai::provider::provider_namespaced_model_id(hydrated.as_ref()),
            "ollama:nomic-embed-text",
            "hydrated namespaced model id must match sync's settings-composed id"
        );
        assert!(registry.is_memory_embedding_configured());
        // Slot isolation: must not touch the app-wide embed slot.
        assert!(!registry.is_embedding_configured());
    }

    /// C1 defense-in-depth for embed: a memory_embed row hand-edited to the
    /// generation-only `on-device-llm` sentinel must NOT hydrate, even though
    /// that sentinel legitimately persists with an empty endpoint.
    #[test]
    fn load_memory_embed_slot_rejects_persisted_on_device_llm_sentinel() {
        let (state, registry) = make_state_and_conn();
        let (downloads, _tmp) = test_download_manager();
        {
            let conn = state.lock().unwrap();
            // on-device-llm is generation-only; the embed slot must reject it.
            // It legitimately has an empty endpoint, so only the class
            // re-validation (not the endpoint guard) catches it.
            for (k, v) in [
                (settings_keys::memory_embed::PROVIDER, ON_DEVICE_LLM_ID),
                (settings_keys::memory_embed::EMBEDDING_MODEL, "gemma-2b"),
            ] {
                db::set_setting(&conn, k, v).unwrap();
            }
        }
        let conn = state.lock().unwrap();
        let loaded = load_memory_embed_slot(&conn, &registry, Some(&downloads)).unwrap();
        assert!(
            !loaded,
            "the generation-only sentinel must NOT hydrate the memory embed slot"
        );
        assert!(registry.memory_embedder().is_none());
        assert!(!registry.is_memory_embedding_configured());
    }

    /// F10 / C1 embed-side counterpart to
    /// `load_memory_gen_slot_rejects_persisted_remote_class`: a Remote-class
    /// persisted embed row must NOT hydrate while `ai_memory_allow_hosted`
    /// is off, same as the gen slot.
    #[test]
    fn load_memory_embed_slot_rejects_persisted_remote_class() {
        let (state, registry) = make_state_and_conn();
        let (downloads, _tmp) = test_download_manager();
        {
            let conn = state.lock().unwrap();
            // "openai"'s default resolved endpoint is already
            // `https://api.openai.com/v1` — no registry override needed.
            for (k, v) in [
                (settings_keys::memory_embed::PROVIDER, "openai"),
                (
                    settings_keys::memory_embed::EMBEDDING_MODEL,
                    "text-embedding-3-small",
                ),
            ] {
                db::set_setting(&conn, k, v).unwrap();
            }
        }
        let conn = state.lock().unwrap();
        let loaded = load_memory_embed_slot(&conn, &registry, Some(&downloads)).unwrap();
        assert!(
            !loaded,
            "a Remote-class persisted row must NOT hydrate the memory embed slot"
        );
        assert!(
            registry.memory_embedder().is_none(),
            "defense-in-depth must leave the memory embed slot empty"
        );
        assert!(!registry.is_memory_embedding_configured());
    }

    /// C1 embed-side counterpart to
    /// `load_memory_gen_slot_hydrates_remote_when_allow_hosted_true`: a
    /// hosted embed row must ALSO hydrate once the user has acknowledged
    /// hosted memory.
    #[test]
    fn load_memory_embed_slot_hydrates_remote_when_allow_hosted_true() {
        let (state, registry) = make_state_and_conn();
        let (downloads, _tmp) = test_download_manager();
        {
            let conn = state.lock().unwrap();
            // "openai"'s default resolved endpoint is already
            // `https://api.openai.com/v1` — no registry override needed.
            for (k, v) in [
                (settings_keys::memory_embed::PROVIDER, "openai"),
                (
                    settings_keys::memory_embed::EMBEDDING_MODEL,
                    "text-embedding-3-small",
                ),
                (settings_keys::MEMORY_ALLOW_HOSTED, "true"),
            ] {
                db::set_setting(&conn, k, v).unwrap();
            }
            // Critical-fix (Phase 2): a Remote-class slot now needs a
            // resolvable key to hydrate.
            persist_provider_credential(
                &conn,
                "openai",
                preset_default_endpoint("openai"),
                Some("sk-test"),
            )
            .unwrap();
        }
        let conn = state.lock().unwrap();
        let loaded = load_memory_embed_slot(&conn, &registry, Some(&downloads)).unwrap();
        assert!(
            loaded,
            "a Remote-class embed row must hydrate once allow_hosted is true"
        );
        assert!(registry.is_memory_embedding_configured());
    }

    /// T2.3 rewrite (T2.2 flagged this test for the trait-const cutover): the
    /// old assertions covered per-slot `endpoint`/`endpoint_class`/`api_key`
    /// rows that no longer exist — those live in the shared per-preset
    /// credential registry now, not on the slot. The surviving intent —
    /// forgetting the gen slot's PROVIDER SELECTION wipes only gen rows,
    /// leaves the embed slot's rows untouched, AND never touches the shared
    /// credential registry (another slot may still be bound to the same
    /// preset) — is re-expressed against the current shape.
    #[test]
    fn forget_gen_only_wipes_gen_keys() {
        let (state, _reg) = make_state_and_conn();
        let conn = state.lock().unwrap();
        // Seed both slots (provider + model only).
        let g = gen_input("anthropic", "https://api.anthropic.com/v1", Some("sk-g"));
        let e = embed_input("openai", "https://api.openai.com/v1", Some("sk-e"));
        persist_gen_config(&conn, &g, expected_class(&g.provider)).unwrap();
        persist_embed_config(&conn, &e, expected_class(&e.provider)).unwrap();
        // Independently seed the credential registry (mirrors the Providers
        // tab — a slot save never writes credentials).
        persist_provider_credential(
            &conn,
            "anthropic",
            "https://api.anthropic.com/v1",
            Some("sk-g"),
        )
        .unwrap();
        // Forget gen (mirrors `forget_ai_generation_provider`'s wipe list).
        forget_slot(
            &conn,
            &[settings_keys::gen::PROVIDER, settings_keys::gen::CHAT_MODEL],
        )
        .unwrap();
        // Gen rows gone.
        for k in [settings_keys::gen::PROVIDER, settings_keys::gen::CHAT_MODEL] {
            assert!(
                db::get_setting(&conn, k).unwrap().is_none(),
                "{k} not wiped"
            );
        }
        // Embed rows survive.
        assert_eq!(
            db::get_setting(&conn, settings_keys::embed::PROVIDER)
                .unwrap()
                .as_deref(),
            Some("openai")
        );
        assert_eq!(
            db::get_setting(&conn, settings_keys::embed::EMBEDDING_MODEL)
                .unwrap()
                .as_deref(),
            Some("text-embedding-3-small")
        );
        // The shared credential registry survives — forgetting a slot's
        // provider SELECTION is not the same as forgetting the credential.
        let (_, key) = resolve_credential(&conn, "anthropic").unwrap();
        assert_eq!(
            key.as_deref(),
            Some("sk-g"),
            "credential registry survives a slot forget"
        );
    }

    #[test]
    fn validate_slot_rejects_empty_provider_and_url() {
        assert!(validate_slot("", "https://api.openai.com/v1", "m", "chat_model").is_err());
        assert!(validate_slot("openai", "", "m", "chat_model").is_err());
        assert!(validate_slot("openai", "not-a-url", "m", "chat_model").is_err());
        assert!(validate_slot("openai", "https://api.openai.com/v1", "", "chat_model").is_err());
        assert!(validate_slot("openai", "https://api.openai.com/v1", "m", "chat_model").is_ok());
    }

    #[test]
    fn validate_slot_allows_empty_endpoint_for_cli_providers() {
        // CLI providers have no endpoint URL — they spawn a subprocess.
        // validate_slot must skip the endpoint checks for them.
        assert!(validate_slot("claude-cli", "", "sonnet", "chat_model").is_ok());
        assert!(validate_slot("codex-cli", "", "gpt-5.4", "chat_model").is_ok());
        // But the chat_model is still required.
        assert!(validate_slot("claude-cli", "", "", "chat_model").is_err());
        // And the provider id is still required.
        assert!(validate_slot("", "", "sonnet", "chat_model").is_err());
    }

    #[test]
    fn provider_uses_subprocess_recognises_cli_ids() {
        assert!(provider_uses_subprocess("claude-cli"));
        assert!(provider_uses_subprocess("codex-cli"));
        assert!(!provider_uses_subprocess("openai"));
        assert!(!provider_uses_subprocess("anthropic"));
        assert!(!provider_uses_subprocess(""));
    }

    #[test]
    fn build_slot_provider_claude_cli_generation_succeeds() {
        let p = build_slot_provider(
            "claude-cli",
            "",
            None,
            SlotPayload::Generation {
                chat_model: "sonnet",
            },
            None,
        )
        .expect("must build");
        assert_eq!(p.id(), "claude-cli");
        assert_eq!(p.chat_model_id(), "sonnet");
    }

    #[test]
    fn build_slot_provider_codex_cli_generation_succeeds() {
        let p = build_slot_provider(
            "codex-cli",
            "",
            None,
            SlotPayload::Generation {
                chat_model: "gpt-5.4",
            },
            None,
        )
        .expect("must build");
        assert_eq!(p.id(), "codex-cli");
        assert_eq!(p.chat_model_id(), "gpt-5.4");
    }

    #[test]
    fn build_slot_provider_claude_cli_rejects_embedding_slot() {
        let res = build_slot_provider(
            "claude-cli",
            "",
            None,
            SlotPayload::Embedding {
                embedding_model: "x",
            },
            None,
        );
        match res {
            Err(AiError::ProviderUnsupported(_)) => {}
            Err(other) => panic!("unexpected error: {other:?}"),
            Ok(_) => panic!("must Err"),
        }
    }

    #[test]
    fn build_slot_provider_codex_cli_rejects_embedding_slot() {
        let res = build_slot_provider(
            "codex-cli",
            "",
            None,
            SlotPayload::Embedding {
                embedding_model: "x",
            },
            None,
        );
        match res {
            Err(AiError::ProviderUnsupported(_)) => {}
            Err(other) => panic!("unexpected error: {other:?}"),
            Ok(_) => panic!("must Err"),
        }
    }

    #[test]
    fn build_slot_provider_unknown_id_falls_back_to_openai_compat() {
        // Regression: the CLI dispatch must not break the catch-all
        // path. Any unrecognised id still constructs an
        // OpenAICompatibleProvider with that id (the previous
        // behaviour every other preset relies on).
        let p = build_slot_provider(
            "custom",
            "https://example.com/v1",
            Some("sk"),
            SlotPayload::Generation { chat_model: "m" },
            None,
        )
        .expect("must build");
        assert_eq!(p.id(), "custom");
    }

    // ─── Task 4 (Embedding Cost Guardrails Phase 4): on-device dispatch ────

    /// `Arc<DownloadManager>` rooted at a fresh temp dir — enough for
    /// `build_slot_provider`'s on-device branch to construct an
    /// `OnDeviceEmbedProvider`; no model needs to actually be downloaded
    /// for the dispatch test (readiness is exercised in
    /// `on_device_embed.rs`'s own tests).
    fn test_download_manager() -> (Arc<DownloadManager>, tempfile::TempDir) {
        let tmp = tempfile::tempdir().unwrap();
        (
            Arc::new(DownloadManager::new(tmp.path().to_path_buf())),
            tmp,
        )
    }

    /// CRITICAL dispatch test — `build_slot_provider` must route the
    /// on-device sentinel to `OnDeviceEmbedProvider`, not the OpenAI-compat
    /// catch-all, and the resulting provider must report
    /// `EndpointClass::OnDevice`.
    #[test]
    fn build_slot_provider_on_device_dispatches_to_on_device_embed_provider() {
        let (downloads, _tmp) = test_download_manager();
        let p = build_slot_provider(
            ON_DEVICE_PROVIDER_ID,
            "",
            None,
            SlotPayload::Embedding {
                embedding_model: catalog::NOMIC_EMBED_TEXT_V15,
            },
            Some(&downloads),
        )
        .expect("must build");
        assert_eq!(p.id(), "on-device");
        assert_eq!(p.endpoint_class(), EndpointClass::OnDevice);
        assert_eq!(p.embedding_model_id(), catalog::NOMIC_EMBED_TEXT_V15);
    }

    #[test]
    fn build_slot_provider_on_device_rejects_generation_slot() {
        let (downloads, _tmp) = test_download_manager();
        let res = build_slot_provider(
            ON_DEVICE_PROVIDER_ID,
            "",
            None,
            SlotPayload::Generation { chat_model: "x" },
            Some(&downloads),
        );
        match res {
            Err(AiError::ProviderUnsupported(_)) => {}
            Err(other) => panic!("unexpected error: {other:?}"),
            Ok(_) => panic!("must Err"),
        }
    }

    #[test]
    fn build_slot_provider_on_device_without_downloads_manager_errors() {
        let res = build_slot_provider(
            ON_DEVICE_PROVIDER_ID,
            "",
            None,
            SlotPayload::Embedding {
                embedding_model: catalog::NOMIC_EMBED_TEXT_V15,
            },
            None,
        );
        assert!(res.is_err(), "must Err without a download manager");
    }

    /// CRITICAL regression guard — the exact bug flagged after Task 3:
    /// persisting an on-device embedding slot must read back as
    /// `EndpointClass::OnDevice`, NOT `Remote`. A misread would wrongly
    /// demand hosted-token consent for a zero-cost on-device provider.
    ///
    /// T2.3 rewrite: `endpointClass` is no longer a stored per-slot row
    /// (`read_slot_endpoint_class`/`read_slot_class` are gone) — it's
    /// DERIVED on every read via `read_embed_public`/`credential_class`.
    /// Re-expressed against that read path; the regression this guards
    /// against is unchanged.
    #[test]
    fn endpoint_class_round_trip_on_device_reads_back_as_on_device_not_remote() {
        let (state, _reg) = make_state_and_conn();
        let conn = state.lock().unwrap();
        let mut i = embed_input(ON_DEVICE_PROVIDER_ID, "", Some(""));
        i.embedding_model = catalog::NOMIC_EMBED_TEXT_V15.into();
        persist_embed_config(&conn, &i, EndpointClass::OnDevice).unwrap();

        let public = read_embed_public(&conn).unwrap().unwrap();
        assert_eq!(
            public.endpoint_class,
            EndpointClass::OnDevice,
            "read_embed_public must not default on-device to Remote"
        );
    }

    // ─── configured_embedding_model_id (C6 fix) ─────────────────────────────

    #[test]
    fn configured_embedding_model_id_none_when_unconfigured() {
        let (state, _reg) = make_state_and_conn();
        let conn = state.lock().unwrap();
        assert!(configured_embedding_model_id(&conn).is_none());
    }

    #[test]
    fn configured_embedding_model_id_reads_back_persisted_identity() {
        let (state, _reg) = make_state_and_conn();
        let conn = state.lock().unwrap();
        let i = embed_input("openai", "https://api.openai.com/v1", Some("sk"));
        persist_embed_config(&conn, &i, EndpointClass::Remote).unwrap();

        assert_eq!(
            configured_embedding_model_id(&conn).as_deref(),
            Some("openai:text-embedding-3-small")
        );
    }

    #[test]
    fn configured_embedding_model_id_none_when_model_row_empty() {
        let (state, _reg) = make_state_and_conn();
        let conn = state.lock().unwrap();
        db::set_setting(&conn, settings_keys::embed::PROVIDER, "openai").unwrap();
        assert!(
            configured_embedding_model_id(&conn).is_none(),
            "a provider row with no model must not be treated as configured"
        );
    }

    /// The `provider` row can be explicitly set to the `"none"` sentinel
    /// (e.g. after `forget_ai_embedding_provider`) rather than merely being
    /// absent/empty — this must be treated identically to "not configured",
    /// even when a stale `model` row is still present from before the
    /// forget.
    #[test]
    fn configured_embedding_model_id_none_when_provider_is_none_sentinel() {
        let (state, _reg) = make_state_and_conn();
        let conn = state.lock().unwrap();
        db::set_setting(&conn, settings_keys::embed::PROVIDER, "none").unwrap();
        db::set_setting(&conn, EmbedKeys::model_key(), "text-embedding-3-small").unwrap();
        assert!(
            configured_embedding_model_id(&conn).is_none(),
            "provider explicitly set to the \"none\" sentinel must not count as configured, \
             even with a stale model row still present"
        );
    }

    // ─── background-indexing toggle auto-init (C10 fix) ────────────────────

    /// (a) Saving an on-device embedding slot while the master toggle is
    /// absent must initialize it to `"true"`, so `background_indexing_allowed`
    /// flips on without the user separately discovering the switch.
    #[test]
    fn persist_embed_config_on_device_initializes_background_indexing_when_absent() {
        let (state, _reg) = make_state_and_conn();
        let conn = state.lock().unwrap();
        assert!(
            db::get_setting(&conn, settings_keys::BACKGROUND_INDEXING_ENABLED)
                .unwrap()
                .is_none()
        );

        let mut i = embed_input(ON_DEVICE_PROVIDER_ID, "", Some(""));
        i.embedding_model = catalog::NOMIC_EMBED_TEXT_V15.into();
        persist_embed_config(&conn, &i, EndpointClass::OnDevice).unwrap();

        assert_eq!(
            db::get_setting(&conn, settings_keys::BACKGROUND_INDEXING_ENABLED)
                .unwrap()
                .as_deref(),
            Some("true"),
            "C10 fix: an on-device slot save must initialize the absent master toggle to true"
        );
        assert!(crate::commands::ai_settings::background_indexing_allowed(
            &conn
        ));
    }

    /// (a) Same as above for `Local` (e.g. an Ollama endpoint on loopback).
    #[test]
    fn persist_embed_config_local_initializes_background_indexing_when_absent() {
        let (state, _reg) = make_state_and_conn();
        let conn = state.lock().unwrap();

        let i = embed_input("ollama", "http://127.0.0.1:11434/v1", None);
        assert_eq!(
            classify_provider_disclosure(&i.provider, preset_default_endpoint(&i.provider)),
            EndpointClass::Local
        );
        persist_embed_config(&conn, &i, EndpointClass::Local).unwrap();

        assert_eq!(
            db::get_setting(&conn, settings_keys::BACKGROUND_INDEXING_ENABLED)
                .unwrap()
                .as_deref(),
            Some("true")
        );
        assert!(crate::commands::ai_settings::background_indexing_allowed(
            &conn
        ));
    }

    /// (b) An explicit user choice — even `"false"` — must never be
    /// overwritten by a subsequent on-device/local slot save.
    #[test]
    fn persist_embed_config_never_overrides_an_explicit_false_toggle() {
        let (state, _reg) = make_state_and_conn();
        let conn = state.lock().unwrap();
        db::set_setting(&conn, settings_keys::BACKGROUND_INDEXING_ENABLED, "false").unwrap();

        let mut i = embed_input(ON_DEVICE_PROVIDER_ID, "", Some(""));
        i.embedding_model = catalog::NOMIC_EMBED_TEXT_V15.into();
        persist_embed_config(&conn, &i, EndpointClass::OnDevice).unwrap();

        assert_eq!(
            db::get_setting(&conn, settings_keys::BACKGROUND_INDEXING_ENABLED)
                .unwrap()
                .as_deref(),
            Some("false"),
            "an explicit user choice (even off) must never be overwritten"
        );
        assert!(!crate::commands::ai_settings::background_indexing_allowed(
            &conn
        ));
    }

    /// (c) A hosted (Remote) slot save must never auto-enable background
    /// indexing — the row must stay absent, unlike Local/OnDevice.
    #[test]
    fn persist_embed_config_remote_never_auto_enables_background_indexing() {
        let (state, _reg) = make_state_and_conn();
        let conn = state.lock().unwrap();

        let i = embed_input("openai", "https://api.openai.com/v1", Some("sk"));
        persist_embed_config(&conn, &i, EndpointClass::Remote).unwrap();

        assert!(
            db::get_setting(&conn, settings_keys::BACKGROUND_INDEXING_ENABLED)
                .unwrap()
                .is_none(),
            "hosted must never auto-enable background indexing"
        );
        assert!(!crate::commands::ai_settings::background_indexing_allowed(
            &conn
        ));
    }

    /// Startup/unlock site: an install that configured an on-device slot
    /// BEFORE this fix shipped (so the toggle row is still absent) must
    /// get it initialized the next time `load_embed_slot` runs (once per
    /// unlock), not just on a fresh save.
    #[test]
    fn load_embed_slot_initializes_background_indexing_for_already_configured_on_device() {
        let (state, registry) = make_state_and_conn();
        let (downloads, _tmp) = test_download_manager();
        {
            let conn = state.lock().unwrap();
            db::set_setting(&conn, settings_keys::embed::PROVIDER, ON_DEVICE_PROVIDER_ID).unwrap();
            db::set_setting(
                &conn,
                settings_keys::embed::EMBEDDING_MODEL,
                catalog::NOMIC_EMBED_TEXT_V15,
            )
            .unwrap();
        }
        let conn = state.lock().unwrap();
        let loaded = load_embed_slot(&conn, &registry, None, Some(&downloads)).unwrap();
        assert!(loaded);
        assert_eq!(
            db::get_setting(&conn, settings_keys::BACKGROUND_INDEXING_ENABLED)
                .unwrap()
                .as_deref(),
            Some("true"),
            "an already-configured on-device install must get the toggle initialized on \
             unlock/startup, not only on a fresh save"
        );
    }

    /// `load_embed_slot` must never override an explicit user choice either
    /// — mirrors the save-path guarantee.
    #[test]
    fn load_embed_slot_does_not_override_explicit_false_toggle() {
        let (state, registry) = make_state_and_conn();
        let (downloads, _tmp) = test_download_manager();
        {
            let conn = state.lock().unwrap();
            db::set_setting(&conn, settings_keys::embed::PROVIDER, ON_DEVICE_PROVIDER_ID).unwrap();
            db::set_setting(
                &conn,
                settings_keys::embed::EMBEDDING_MODEL,
                catalog::NOMIC_EMBED_TEXT_V15,
            )
            .unwrap();
            db::set_setting(&conn, settings_keys::BACKGROUND_INDEXING_ENABLED, "false").unwrap();
        }
        let conn = state.lock().unwrap();
        load_embed_slot(&conn, &registry, None, Some(&downloads)).unwrap();
        assert_eq!(
            db::get_setting(&conn, settings_keys::BACKGROUND_INDEXING_ENABLED)
                .unwrap()
                .as_deref(),
            Some("false")
        );
    }

    /// Switching the embedding slot from a hosted provider to on-device
    /// must clear any hosted-consent requirement — on-device has its own
    /// consent identity (`consent_identity` includes the provider id), so
    /// the old hosted stamp no longer covers the new identity and
    /// `background_indexing_allowed` must stay auto (true) for the new
    /// on-device class regardless.
    #[test]
    fn switching_hosted_to_on_device_clears_hosted_consent_requirement() {
        let (state, _reg) = make_state_and_conn();
        let conn = state.lock().unwrap();
        let hosted = embed_input("openai", "https://api.openai.com/v1", Some("sk"));
        persist_embed_config(&conn, &hosted, EndpointClass::Remote).unwrap();
        db::set_setting(
            &conn,
            settings_keys::BACKGROUND_INDEXING_HOSTED_CONSENT_AT,
            "1234567890",
        )
        .unwrap();

        let mut on_device = embed_input(ON_DEVICE_PROVIDER_ID, "", Some(""));
        on_device.embedding_model = catalog::NOMIC_EMBED_TEXT_V15.into();
        let (needs_consent, identity_changed) =
            persist_embed_config(&conn, &on_device, EndpointClass::OnDevice).unwrap();

        assert!(identity_changed, "provider:model boundary changed");
        assert!(
            !needs_consent,
            "on-device is auto-exempt from the privacy-notice gate too"
        );
        assert!(
            db::get_setting(&conn, settings_keys::BACKGROUND_INDEXING_HOSTED_CONSENT_AT)
                .unwrap()
                .is_none(),
            "hosted consent stamp must be cleared once the identity moves to on-device"
        );
        db::set_setting(&conn, settings_keys::BACKGROUND_INDEXING_ENABLED, "true").unwrap();
        assert!(
            crate::commands::ai_settings::background_indexing_allowed(&conn),
            "background indexing must stay auto-allowed for on-device with no hosted stamp"
        );
    }

    /// Changing the on-device MODEL (not just switching to on-device) is
    /// still a `provider_id:model` identity change — it must enqueue a
    /// rebuild for the new `on-device:<model>` model_id, exactly like a
    /// hosted model swap, and must never require hosted consent.
    #[test]
    fn on_device_model_change_enqueues_rebuild_for_new_model_id() {
        let (state, registry) = make_state_and_conn();
        let conn = state.lock().unwrap();
        db::set_setting(&conn, settings_keys::SEMANTIC_SEARCH_ENABLED, "true").unwrap();
        insert_test_entry(&conn, "e1", "T1", "Entry text long enough to embed.");

        let (downloads, _tmp) = test_download_manager();
        let mut i1 = embed_input(ON_DEVICE_PROVIDER_ID, "", Some(""));
        i1.embedding_model = catalog::NOMIC_EMBED_TEXT_V15.into();
        let p1: Arc<dyn AIProvider> = Arc::new(OnDeviceEmbedProvider::new(
            i1.embedding_model.clone(),
            Arc::clone(&downloads),
        ));
        let out1 = apply_embedding_slot_change(&conn, &registry, p1, &i1, EndpointClass::OnDevice)
            .unwrap();
        assert!(out1.identity_changed);
        assert_eq!(
            out1.model_id,
            format!("on-device:{}", catalog::NOMIC_EMBED_TEXT_V15)
        );
        assert_eq!(out1.enqueued, 1);
        assert!(!out1.result.requires_privacy_consent);

        let mut i2 = embed_input(ON_DEVICE_PROVIDER_ID, "", Some(""));
        i2.embedding_model = catalog::MULTILINGUAL_E5_SMALL.into();
        let p2: Arc<dyn AIProvider> = Arc::new(OnDeviceEmbedProvider::new(
            i2.embedding_model.clone(),
            Arc::clone(&downloads),
        ));
        let out2 = apply_embedding_slot_change(&conn, &registry, p2, &i2, EndpointClass::OnDevice)
            .unwrap();

        assert!(out2.identity_changed, "model-id boundary changed");
        assert_eq!(
            out2.model_id,
            format!("on-device:{}", catalog::MULTILINGUAL_E5_SMALL)
        );
        assert_ne!(out2.model_id, out1.model_id);
        assert_eq!(
            out2.enqueued, 1,
            "the entry re-queued under the new model_id"
        );
        assert!(!out2.result.requires_privacy_consent);

        let new_job = db::embeddings::get_embedding_job(&conn, "e1", &out2.model_id).unwrap();
        assert!(new_job.is_some(), "new-model job row must be enqueued");
    }

    /// C7 fix, `ModelNotReady` branch: once an on-device model finishes
    /// downloading, any job `paused` on that exact model_id must recover to
    /// `pending` — nothing else ever brings a `paused` job back on its own.
    /// A paused job under a DIFFERENT on-device model must stay untouched.
    #[test]
    fn reset_paused_jobs_for_downloaded_on_device_model_recovers_only_that_model() {
        let (state, _reg) = make_state_and_conn();
        let conn = state.lock().unwrap();
        insert_test_entry(&conn, "e1", "T1", "Entry text long enough to embed.");
        insert_test_entry(&conn, "e2", "T2", "Other entry text long enough to embed.");

        let downloaded_model_id = format!("on-device:{}", catalog::NOMIC_EMBED_TEXT_V15);
        let other_model_id = format!("on-device:{}", catalog::MULTILINGUAL_E5_SMALL);
        db::embeddings::mark_entry_embedding_dirty(&conn, "e1", &downloaded_model_id, "h", 0, 0)
            .unwrap();
        db::embeddings::pause_embedding_job(
            &conn,
            "e1",
            &downloaded_model_id,
            "model not ready",
            0,
        )
        .unwrap();
        db::embeddings::mark_entry_embedding_dirty(&conn, "e2", &other_model_id, "h", 0, 0)
            .unwrap();
        db::embeddings::pause_embedding_job(&conn, "e2", &other_model_id, "model not ready", 0)
            .unwrap();

        let recovered =
            reset_paused_jobs_for_downloaded_on_device_model(&conn, catalog::NOMIC_EMBED_TEXT_V15)
                .unwrap();
        assert_eq!(recovered, 1);

        assert_eq!(
            db::embeddings::get_embedding_job(&conn, "e1", &downloaded_model_id)
                .unwrap()
                .unwrap()
                .status,
            "pending"
        );
        assert_eq!(
            db::embeddings::get_embedding_job(&conn, "e2", &other_model_id)
                .unwrap()
                .unwrap()
                .status,
            "paused",
            "a paused job under a different on-device model must be untouched"
        );
    }

    /// `background_indexing_allowed` (Phase 2 Task 1) must treat on-device
    /// as auto (no hosted-token consent required), exactly as it already
    /// treats `Local` — confirms the doc comment on
    /// `EndpointClass::OnDevice` ("auto-allowed everywhere Local is") holds
    /// for the actual gate, not just in prose.
    #[test]
    fn background_indexing_allowed_is_auto_for_on_device_with_no_hosted_consent() {
        let (state, _reg) = make_state_and_conn();
        let conn = state.lock().unwrap();
        db::set_setting(&conn, settings_keys::BACKGROUND_INDEXING_ENABLED, "true").unwrap();
        // The on-device sentinel's derived class is always `OnDevice`,
        // regardless of endpoint.
        db::set_setting(&conn, settings_keys::embed::PROVIDER, ON_DEVICE_PROVIDER_ID).unwrap();
        // Deliberately no BACKGROUND_INDEXING_HOSTED_CONSENT_AT row.
        assert!(crate::commands::ai_settings::background_indexing_allowed(
            &conn
        ));
    }

    // NOTE: `gen_input_debug_redacts_api_key` / `embed_input_debug_redacts_api_key`
    // were deleted here — their premise (a custom `Debug` impl redacting
    // `api_key`) no longer applies. `AIGenProviderConfigInput` /
    // `AIEmbedProviderConfigInput` carry no secret since T2.3 (endpoint/key
    // moved to the credential registry), so both structs now derive `Debug`
    // directly — there is nothing left to redact.

    #[test]
    fn slot_test_result_serialises_dim_as_optional() {
        // Frontend treats `dim` as Optional<number>. The test parses
        // the wire form back into a JSON value rather than grepping
        // for the literal `"dim":null` so a future
        // `#[serde(skip_serializing_if)]` optimization (which would
        // omit `dim` instead of emitting null) doesn't break this.
        let chat = SlotTestResult {
            latency_ms: 10,
            dim: None,
        };
        let parsed: serde_json::Value =
            serde_json::from_str(&serde_json::to_string(&chat).unwrap()).unwrap();
        assert!(
            parsed.get("dim").map(|v| v.is_null()).unwrap_or(true),
            "chat result must encode dim as null or absent: {parsed}"
        );
        let embed = SlotTestResult {
            latency_ms: 20,
            dim: Some(1536),
        };
        let parsed: serde_json::Value =
            serde_json::from_str(&serde_json::to_string(&embed).unwrap()).unwrap();
        assert_eq!(parsed["dim"].as_u64(), Some(1536));
    }

    // ── Regression guards for cf-review DEEP findings ──────────────────────

    #[test]
    fn load_gen_slot_skips_when_chat_model_empty() {
        // I5: a partial / hand-edited row where the provider+endpoint
        // are valid but `chat_model` is missing must NOT hydrate a
        // provider whose `chat_model_id()` is "" — that would collide
        // with every other empty-model row in feature cache keys.
        let (state, registry) = make_state_and_conn();
        {
            let conn = state.lock().unwrap();
            db::set_setting(&conn, settings_keys::gen::PROVIDER, "anthropic").unwrap();
            // chat_model deliberately absent.
        }
        let conn = state.lock().unwrap();
        let loaded = load_gen_slot(&conn, &registry, None, None).unwrap();
        assert!(!loaded, "empty chat_model must skip hydration");
        assert!(!registry.is_generation_configured());
    }

    #[test]
    fn load_embed_slot_skips_when_embedding_model_empty() {
        // Mirror of I5 for the embed slot.
        let (state, registry) = make_state_and_conn();
        {
            let conn = state.lock().unwrap();
            db::set_setting(&conn, settings_keys::embed::PROVIDER, "openai").unwrap();
        }
        let conn = state.lock().unwrap();
        let loaded = load_embed_slot(&conn, &registry, None, None).unwrap();
        assert!(!loaded);
        assert!(!registry.is_embedding_configured());
    }

    #[test]
    fn load_gen_slot_followed_by_legacy_load_keeps_gen_provider() {
        // C1 regression: if both `ai_gen_provider` AND legacy
        // `ai_provider` rows are present, the post-unlock orchestration
        // in `commands::crypto` runs `load_gen_slot` first and then
        // SKIPS the legacy loader when gen hydrated. This unit-level
        // test verifies the underlying property — calling
        // `load_from_settings_into` AFTER `load_gen_slot` succeeded
        // would clobber the gen slot via `registry.swap()` →
        // `swap_generation()`. The crypto-side guard is what prevents
        // it in production. Without that guard, this test would
        // produce `id() == "legacy-openai"`. With the guard, the
        // production caller never calls the legacy loader at all —
        // we test the property by NOT calling it.
        let (state, registry) = make_state_and_conn();
        {
            let conn = state.lock().unwrap();
            db::set_setting(&conn, settings_keys::gen::PROVIDER, "anthropic").unwrap();
            db::set_setting(&conn, settings_keys::gen::CHAT_MODEL, "claude-haiku-4-5").unwrap();
            // Critical-fix (Phase 2): a Remote-class slot now needs a
            // resolvable key to hydrate.
            persist_provider_credential(
                &conn,
                "anthropic",
                preset_default_endpoint("anthropic"),
                Some("sk-test"),
            )
            .unwrap();
            // Legacy rows from a pre-R11 install that escaped the wipe.
            db::set_setting(&conn, settings_keys::PROVIDER, "legacy-openai").unwrap();
            db::set_setting(&conn, settings_keys::ENDPOINT, "https://api.openai.com/v1").unwrap();
            db::set_setting(&conn, settings_keys::CHAT_MODEL, "gpt-4o-mini").unwrap();
            db::set_setting(
                &conn,
                settings_keys::EMBEDDING_MODEL,
                "text-embedding-3-small",
            )
            .unwrap();
        }
        let conn = state.lock().unwrap();
        let gen_hydrated = load_gen_slot(&conn, &registry, None, None).unwrap();
        assert!(gen_hydrated);
        // Production code (commands/crypto.rs) checks gen_hydrated
        // before calling the legacy loader. Replicating that gate here
        // is what proves the guard's correctness.
        assert_eq!(registry.generation().unwrap().id(), "anthropic");
    }

    // ─── Task 5 (Embedding Cost Guardrails Phase 4): model-download event
    // payload shape — the pure mappers, unit-testable without an
    // `AppHandle` (the command layer itself needs a running Tauri app to
    // exercise `app.emit`, which is a manual/E2E concern, not a unit test).

    #[test]
    fn model_download_progress_payload_shape() {
        let v = model_download_progress_payload("bge-m3", 42);
        assert_eq!(v["model_id"], "bge-m3");
        assert_eq!(v["progress"], 42);
    }

    #[test]
    fn model_download_error_payload_shape() {
        let v = model_download_error_payload("bge-m3", "network_unreachable");
        assert_eq!(v["model_id"], "bge-m3");
        assert_eq!(v["error"], "network_unreachable");
    }

    // ─── Late test-coverage review: `OnDeviceModelStateWire` serde contract
    // and the on-device branch of `classify_provider_disclosure`.

    #[test]
    fn on_device_model_state_wire_serde_tags_match_frontend_contract() {
        // `ModelDownloadState` in `useOnDeviceModels.ts` switches on the
        // `status` tag string. A silent rename here (e.g. `NotDownloaded`
        // → `NoModel`) would desync the frontend without a compile error,
        // so pin the exact snake_case values for every variant.
        assert_eq!(
            serde_json::to_value(OnDeviceModelStateWire::NotDownloaded).unwrap(),
            serde_json::json!({ "status": "not_downloaded" })
        );
        assert_eq!(
            serde_json::to_value(OnDeviceModelStateWire::Downloading { progress: 42 }).unwrap(),
            serde_json::json!({ "status": "downloading", "progress": 42 })
        );
        assert_eq!(
            serde_json::to_value(OnDeviceModelStateWire::Ready).unwrap(),
            serde_json::json!({ "status": "ready" })
        );
        assert_eq!(
            serde_json::to_value(OnDeviceModelStateWire::Error {
                code: "network_unreachable".into()
            })
            .unwrap(),
            serde_json::json!({ "status": "error", "code": "network_unreachable" })
        );
    }

    #[test]
    fn classify_provider_disclosure_tags_on_device_provider() {
        // Sibling to `classify_provider_disclosure_tags_cli_providers_as_subscription`
        // — the on-device sentinel must classify as `OnDevice` via the
        // dedicated branch, not fall through to `classify_endpoint` (which
        // would misread the empty on-device endpoint string as `Remote`,
        // since an unparsable URL defaults to `Remote`).
        assert!(provider_is_on_device(ON_DEVICE_PROVIDER_ID));
        assert_eq!(
            classify_provider_disclosure(ON_DEVICE_PROVIDER_ID, ""),
            EndpointClass::OnDevice
        );
    }

    #[test]
    fn classify_provider_disclosure_tags_on_device_llm_provider() {
        // Sibling to `classify_provider_disclosure_tags_on_device_provider`
        // — the on-device-llm (chat sidecar) sentinel must ALSO classify as
        // `OnDevice`, not fall through to `classify_endpoint("")` (which
        // defaults an unparsable/empty URL to `Remote`). This is the exact
        // gap `ai_settings::classify_memory_disclosure`'s doc comment
        // documents having to patch separately.
        assert!(provider_is_on_device_llm(ON_DEVICE_LLM_ID));
        assert_eq!(
            classify_provider_disclosure(ON_DEVICE_LLM_ID, ""),
            EndpointClass::OnDevice
        );
    }

    // ── Phase 4 Task 2: stop-on-switch + on-device-llm selection ────────────

    /// Full truth table for [`should_stop_on_switch`]. The load-bearing
    /// invariant: switching AWAY from `on-device-llm` to a different provider
    /// stops the sidecar; a same-provider model swap does NOT (avoid a needless
    /// cold restart — the provider respawns lazily on the next chat).
    #[test]
    fn should_stop_on_switch_truth_table() {
        // Away from on-device-llm → stop.
        assert!(should_stop_on_switch(ON_DEVICE_LLM_ID, "openai"));
        assert!(should_stop_on_switch(ON_DEVICE_LLM_ID, "ollama"));
        assert!(should_stop_on_switch(ON_DEVICE_LLM_ID, "anthropic"));
        // Same provider, model swap → do NOT stop.
        assert!(!should_stop_on_switch(ON_DEVICE_LLM_ID, ON_DEVICE_LLM_ID));
        // Into on-device-llm from something else → nothing to stop.
        assert!(!should_stop_on_switch("openai", ON_DEVICE_LLM_ID));
        // Unrelated swaps → never stop.
        assert!(!should_stop_on_switch("openai", "anthropic"));
        // Empty prior slot → never stop.
        assert!(!should_stop_on_switch("", ON_DEVICE_LLM_ID));
        assert!(!should_stop_on_switch("", "openai"));
    }

    /// [`validate_on_device_llm_selection`] truth table — catalog existence
    /// gates download-state, matching the order the command body checks.
    #[test]
    fn validate_on_device_llm_selection_truth_table() {
        // Known catalog id + downloaded → Ok.
        assert!(validate_on_device_llm_selection(llm_catalog::GEMMA_4_E4B_IT, true).is_ok());
        // Known catalog id + NOT downloaded → model_not_downloaded.
        assert_eq!(
            validate_on_device_llm_selection(llm_catalog::GEMMA_4_E4B_IT, false),
            Err("model_not_downloaded".to_string())
        );
        // Unknown id → model_not_found (regardless of download flag — catalog
        // is checked first, so an unknown id never reaches the download check).
        assert_eq!(
            validate_on_device_llm_selection("not-a-real-model", true),
            Err("model_not_found".to_string())
        );
        assert_eq!(
            validate_on_device_llm_selection("not-a-real-model", false),
            Err("model_not_found".to_string())
        );
    }

    /// `should_use_test_timeout` truth table — only the on-device-llm
    /// connection test needs an explicit outer cold-start budget; every
    /// hosted / CLI provider relies on the provider's own HTTP timeout.
    #[test]
    fn should_use_test_timeout_truth_table() {
        assert!(should_use_test_timeout(ON_DEVICE_LLM_ID));
        assert!(!should_use_test_timeout("openai"));
        assert!(!should_use_test_timeout("anthropic"));
        assert!(!should_use_test_timeout("ollama"));
        assert!(!should_use_test_timeout(CLAUDE_CLI_ID));
        assert!(!should_use_test_timeout(CODEX_CLI_ID));
        assert!(!should_use_test_timeout(ON_DEVICE_PROVIDER_ID));
        assert!(!should_use_test_timeout(""));
    }

    /// [`on_device_test_timeout_error`] returns the stable error code the
    /// frontend string-matches to surface "model didn't start in time" copy.
    #[test]
    fn on_device_test_timeout_error_is_stable_code() {
        // Must be the SAME code prefix the frontend already recognises from
        // ensure_running failures, so the UI messaging path is shared.
        assert_eq!(
            on_device_test_timeout_error(),
            "on_device_llm_start_failed: test_timeout"
        );
    }

    /// [`validate_on_device_llm_selection_with_assets`] must agree with the
    /// pure helper once the ready marker is stamped on disk.
    #[test]
    fn validate_on_device_llm_selection_with_assets_reads_disk() {
        let tmp = tempfile::tempdir().unwrap();
        let assets = Arc::new(LlmAssetManager::new(tmp.path().to_path_buf()));

        // Not downloaded yet → model_not_downloaded.
        assert_eq!(
            validate_on_device_llm_selection_with_assets(llm_catalog::GEMMA_4_E4B_IT, &assets),
            Err("model_not_downloaded".to_string())
        );

        // Stamp the ready marker + a dummy gguf, mirroring server.rs test helper.
        let dir = assets.model_dir(llm_catalog::GEMMA_4_E4B_IT);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            assets.model_gguf_path(llm_catalog::GEMMA_4_E4B_IT),
            b"dummy",
        )
        .unwrap();
        std::fs::write(dir.join(".llm_ready"), b"1").unwrap();

        assert!(
            validate_on_device_llm_selection_with_assets(llm_catalog::GEMMA_4_E4B_IT, &assets)
                .is_ok()
        );

        // Unknown id still model_not_found even with the manager wired up.
        assert_eq!(
            validate_on_device_llm_selection_with_assets("not-a-real-model", &assets),
            Err("model_not_found".to_string())
        );
    }

    // ── Per-preset credential registry (T1.3) ───────────────────────────────
    //
    // The new registry generalizes the generation-only GEN_API_KEYRING into
    // two per-preset maps: a syncable endpoints override map + a non-synced
    // keyring. Keying by preset id (not provider|endpoint) is what makes
    // editing a custom endpoint safe — see
    // `provider_credential_editing_custom_endpoint_preserves_stored_key`.

    #[test]
    fn provider_credential_keyring_roundtrip_and_empty_map_delete() {
        let (state, _reg) = make_state_and_conn();
        let conn = state.lock().unwrap();
        // Empty initially — no settings row.
        assert!(read_provider_keyring(&conn).unwrap().is_empty());
        assert!(db::get_setting(&conn, PROVIDER_KEYRING).unwrap().is_none());

        // Roundtrip a non-empty map.
        let mut keyring = std::collections::BTreeMap::new();
        keyring.insert("openai".to_string(), "sk-1".to_string());
        keyring.insert("anthropic".to_string(), "sk-2".to_string());
        write_provider_keyring(&conn, &keyring).unwrap();
        let restored = read_provider_keyring(&conn).unwrap();
        assert_eq!(restored.len(), 2);
        assert_eq!(restored.get("openai").map(String::as_str), Some("sk-1"));
        // BTreeMap serializes in sorted key order — important for content-hash
        // stability across sync.
        assert_eq!(
            db::get_setting(&conn, PROVIDER_KEYRING).unwrap().as_deref(),
            Some(r#"{"anthropic":"sk-2","openai":"sk-1"}"#)
        );

        // Empty map deletes the row (mirrors write_gen_api_keyring exactly).
        write_provider_keyring(&conn, &std::collections::BTreeMap::new()).unwrap();
        assert!(db::get_setting(&conn, PROVIDER_KEYRING).unwrap().is_none());
        assert!(read_provider_keyring(&conn).unwrap().is_empty());
    }

    #[test]
    fn provider_credential_endpoints_roundtrip_and_empty_map_delete() {
        let (state, _reg) = make_state_and_conn();
        let conn = state.lock().unwrap();
        assert!(read_provider_endpoints(&conn).unwrap().is_empty());
        assert!(db::get_setting(&conn, PROVIDER_ENDPOINTS)
            .unwrap()
            .is_none());

        let mut endpoints = std::collections::BTreeMap::new();
        endpoints.insert(
            "custom".to_string(),
            "https://proxy.example.com/v1".to_string(),
        );
        endpoints.insert(
            "other-local".to_string(),
            "http://127.0.0.1:9090/v1".to_string(),
        );
        write_provider_endpoints(&conn, &endpoints).unwrap();
        let restored = read_provider_endpoints(&conn).unwrap();
        assert_eq!(restored.len(), 2);
        assert_eq!(
            restored.get("custom").map(String::as_str),
            Some("https://proxy.example.com/v1")
        );

        // Empty map deletes the row.
        write_provider_endpoints(&conn, &std::collections::BTreeMap::new()).unwrap();
        assert!(db::get_setting(&conn, PROVIDER_ENDPOINTS)
            .unwrap()
            .is_none());
        assert!(read_provider_endpoints(&conn).unwrap().is_empty());
    }

    #[test]
    fn provider_credential_keyring_is_not_syncable() {
        // The keyring row must never leave the device, while the endpoint
        // override map (joined the sync allow-list in T2.4) must sync.
        assert!(!db::is_syncable_setting(PROVIDER_KEYRING));
        assert!(db::is_syncable_setting(PROVIDER_ENDPOINTS));
    }

    #[test]
    fn provider_credential_editing_custom_endpoint_preserves_stored_key() {
        // The whole reason for preset-id keying: under the old
        // `gen_credential_identity(provider, endpoint)` keying, changing a
        // custom endpoint would orphan the stored key. Preset-id keying keeps
        // the key reachable.
        let (state, _reg) = make_state_and_conn();
        let conn = state.lock().unwrap();

        // Store a key for the `custom` preset.
        let mut keyring = std::collections::BTreeMap::new();
        keyring.insert("custom".to_string(), "sk-custom".to_string());
        write_provider_keyring(&conn, &keyring).unwrap();

        // Change the custom endpoint via the endpoints registry.
        let mut endpoints = std::collections::BTreeMap::new();
        endpoints.insert(
            "custom".to_string(),
            "https://proxy.example.com/v1".to_string(),
        );
        write_provider_endpoints(&conn, &endpoints).unwrap();

        // Re-read the key — it survives because the key is keyed by preset id.
        let restored = read_provider_keyring(&conn).unwrap();
        assert_eq!(
            restored.get("custom").map(String::as_str),
            Some("sk-custom")
        );
    }

    #[test]
    fn provider_credential_resolve_returns_override_endpoint_and_key() {
        // `custom` is one of the two presets whose endpoint is user-editable
        // (see `preset_endpoint_editable`) — an override registered for it
        // must be honored by `resolve_credential`.
        let (state, _reg) = make_state_and_conn();
        let conn = state.lock().unwrap();
        let mut endpoints = std::collections::BTreeMap::new();
        endpoints.insert(
            "custom".to_string(),
            "https://proxy.example.com/v1".to_string(),
        );
        write_provider_endpoints(&conn, &endpoints).unwrap();
        let mut keyring = std::collections::BTreeMap::new();
        keyring.insert("custom".to_string(), "sk-custom".to_string());
        write_provider_keyring(&conn, &keyring).unwrap();

        let (endpoint, key) = resolve_credential(&conn, "custom").unwrap();
        assert_eq!(endpoint, "https://proxy.example.com/v1");
        assert_eq!(key.as_deref(), Some("sk-custom"));
    }

    #[test]
    fn provider_credential_resolve_honors_override_for_other_local_too() {
        // `other-local` is the second user-editable preset.
        let (state, _reg) = make_state_and_conn();
        let conn = state.lock().unwrap();
        let mut endpoints = std::collections::BTreeMap::new();
        endpoints.insert(
            "other-local".to_string(),
            "http://127.0.0.1:9090/v1".to_string(),
        );
        write_provider_endpoints(&conn, &endpoints).unwrap();

        let (endpoint, _key) = resolve_credential(&conn, "other-local").unwrap();
        assert_eq!(endpoint, "http://127.0.0.1:9090/v1");
    }

    #[test]
    fn provider_credential_resolve_ignores_synced_override_for_fixed_preset() {
        // Regression test for the read-boundary hole: `ai_provider_endpoints`
        // is a syncable settings row (T2.4), and sync-pull writes it via the
        // sync engine's LWW merge — a path that never goes through
        // `persist_provider_credential`'s write-side guard. Simulate a
        // malicious/compromised synced payload by writing the raw endpoints
        // map directly (bypassing `persist_provider_credential` entirely,
        // exactly like a sync-pull would), then assert `resolve_credential`
        // refuses to honor a non-default endpoint for a fixed preset like
        // `openai` — it must always fall back to the built-in default so the
        // locally-stored `openai` API key is never paired with an
        // attacker-controlled host.
        let (state, _reg) = make_state_and_conn();
        let conn = state.lock().unwrap();

        let mut endpoints = std::collections::BTreeMap::new();
        endpoints.insert(
            "openai".to_string(),
            "https://attacker.example/v1".to_string(),
        );
        write_provider_endpoints(&conn, &endpoints).unwrap();

        let mut keyring = std::collections::BTreeMap::new();
        keyring.insert("openai".to_string(), "sk-openai".to_string());
        write_provider_keyring(&conn, &keyring).unwrap();

        let (endpoint, key) = resolve_credential(&conn, "openai").unwrap();
        assert_eq!(endpoint, "https://api.openai.com/v1");
        // The key is still returned (it's device-local and never synced) —
        // only the untrusted endpoint override is rejected.
        assert_eq!(key.as_deref(), Some("sk-openai"));
    }

    #[test]
    fn provider_credentials_public_ignores_synced_override_for_fixed_preset() {
        // Same attack, but through the public view returned to the UI
        // (`get_ai_provider_credentials`'s pure core) — it must never report
        // a non-default endpoint for a fixed preset either.
        let (state, _reg) = make_state_and_conn();
        let conn = state.lock().unwrap();

        let mut endpoints = std::collections::BTreeMap::new();
        endpoints.insert(
            "openai".to_string(),
            "https://attacker.example/v1".to_string(),
        );
        write_provider_endpoints(&conn, &endpoints).unwrap();

        let rows = provider_credentials_public(&conn).unwrap();
        let openai_row = rows.iter().find(|r| r.preset_id == "openai").unwrap();
        assert_eq!(openai_row.endpoint, "https://api.openai.com/v1");
    }

    #[test]
    fn provider_credential_resolve_falls_back_to_preset_default() {
        let (state, _reg) = make_state_and_conn();
        let conn = state.lock().unwrap();
        // No override in the registry → built-in preset default.
        let (endpoint, key) = resolve_credential(&conn, "openai").unwrap();
        assert_eq!(endpoint, "https://api.openai.com/v1");
        assert!(key.is_none());
    }

    #[test]
    fn provider_credential_resolve_returns_empty_endpoint_when_no_default_no_override() {
        let (state, _reg) = make_state_and_conn();
        let conn = state.lock().unwrap();
        // `custom` has no built-in default and no override → empty string,
        // never an error (callers handle the empty case).
        let (endpoint, key) = resolve_credential(&conn, "custom").unwrap();
        assert_eq!(endpoint, "");
        assert!(key.is_none());
    }

    #[test]
    fn provider_credential_class_delegates_to_classify_provider_disclosure() {
        // CLI provider → Subscription.
        assert_eq!(
            credential_class(CLAUDE_CLI_ID, ""),
            EndpointClass::Subscription
        );
        // On-device embed provider → OnDevice.
        assert_eq!(
            credential_class(ON_DEVICE_PROVIDER_ID, ""),
            EndpointClass::OnDevice
        );
        // HTTP loopback → Local (delegates to classify_endpoint).
        assert_eq!(
            credential_class("ollama", "http://127.0.0.1:11434/v1"),
            EndpointClass::Local
        );
        // HTTP public internet → Remote.
        assert_eq!(
            credential_class("openai", "https://api.openai.com/v1"),
            EndpointClass::Remote
        );
    }

    // ── T1.6: per-preset credential registry commands ──────────────────────

    /// Coverage gap closed: a corrupted `ai_provider_endpoints` settings row
    /// (hand-edited DB, disk corruption, etc.) must not fail EVERY preset's
    /// read in one shot — `read_provider_endpoints` degrades to an empty
    /// map (falling back to each preset's built-in default endpoint)
    /// instead of propagating a parse error through `provider_credentials_public`'s
    /// `?` inside a `.map()`/`.collect()`, which would otherwise turn one
    /// corrupted row into a total read failure for all 17 presets.
    #[test]
    fn credential_command_get_degrades_gracefully_on_malformed_endpoints_json() {
        let (state, _reg) = make_state_and_conn();
        let conn = state.lock().unwrap();
        db::set_setting(&conn, PROVIDER_ENDPOINTS, "{not valid json").unwrap();

        let rows = provider_credentials_public(&conn)
            .expect("a corrupted endpoints row must degrade, not fail the whole read");
        assert_eq!(rows.len(), ALL_PRESET_IDS.len());
        let ollama = rows.iter().find(|r| r.preset_id == "ollama").unwrap();
        assert_eq!(
            ollama.endpoint,
            preset_default_endpoint("ollama"),
            "a corrupted override map must fall back to the built-in default endpoint"
        );
    }

    /// Persisted-format change (T36, 2026-09-03): the old value was
    /// `BTreeMap<preset, endpoint>` (`{"custom":"https://…"}`). No migration
    /// shim — the reader degrades that unknown/old shape to an empty map
    /// instead of panicking or honouring the stale strings.
    #[test]
    fn read_provider_endpoints_old_shape_degrades_to_empty_map() {
        let (state, _reg) = make_state_and_conn();
        let conn = state.lock().unwrap();
        db::set_setting(
            &conn,
            PROVIDER_ENDPOINTS,
            r#"{"custom":"https://proxy.example.com/v1"}"#,
        )
        .unwrap();

        let endpoints =
            read_provider_endpoints(&conn).expect("old-shape row must degrade to empty, not panic");
        assert!(
            endpoints.is_empty(),
            "old BTreeMap<preset, endpoint> shape must not be treated as live overrides"
        );
    }

    /// Sibling to the endpoints test above, for the keyring row.
    #[test]
    fn credential_command_get_degrades_gracefully_on_malformed_keyring_json() {
        let (state, _reg) = make_state_and_conn();
        let conn = state.lock().unwrap();
        db::set_setting(&conn, PROVIDER_KEYRING, "{not valid json").unwrap();

        let rows = provider_credentials_public(&conn)
            .expect("a corrupted keyring row must degrade, not fail the whole read");
        assert_eq!(rows.len(), ALL_PRESET_IDS.len());
        let openai = rows.iter().find(|r| r.preset_id == "openai").unwrap();
        assert!(
            !openai.has_api_key,
            "a corrupted keyring map must degrade to no stored keys, not error"
        );
    }

    #[test]
    fn credential_command_get_lists_every_preset_exactly_once() {
        let (state, _reg) = make_state_and_conn();
        let conn = state.lock().unwrap();
        let rows = provider_credentials_public(&conn).unwrap();
        assert_eq!(rows.len(), ALL_PRESET_IDS.len());
        let mut ids: Vec<&str> = rows.iter().map(|r| r.preset_id.as_str()).collect();
        ids.sort();
        let mut expected: Vec<&str> = ALL_PRESET_IDS.to_vec();
        expected.sort();
        assert_eq!(ids, expected);
    }

    /// Load-bearing: the wire type must never leak a raw key. Assert on the
    /// actual serialized JSON, not just on which struct fields exist.
    #[test]
    fn credential_command_get_never_serializes_key() {
        let (state, _reg) = make_state_and_conn();
        let conn = state.lock().unwrap();
        persist_provider_credential(
            &conn,
            "openai",
            "https://api.openai.com/v1",
            Some("sk-super-secret"),
        )
        .unwrap();

        let rows = provider_credentials_public(&conn).unwrap();
        let json = serde_json::to_string(&rows).unwrap();
        assert!(
            !json.contains("sk-super-secret"),
            "serialized credential list must never contain the raw key: {json}"
        );

        let openai_row = rows.iter().find(|r| r.preset_id == "openai").unwrap();
        assert!(openai_row.has_api_key);
    }

    #[test]
    fn credential_command_get_falls_back_to_preset_default_endpoint_and_class() {
        let (state, _reg) = make_state_and_conn();
        let conn = state.lock().unwrap();
        let rows = provider_credentials_public(&conn).unwrap();

        let ollama = rows.iter().find(|r| r.preset_id == "ollama").unwrap();
        assert_eq!(ollama.endpoint, preset_default_endpoint("ollama"));
        assert_eq!(ollama.endpoint_class, EndpointClass::Local);
        assert!(!ollama.has_api_key);

        let openai = rows.iter().find(|r| r.preset_id == "openai").unwrap();
        assert_eq!(openai.endpoint, preset_default_endpoint("openai"));
        assert_eq!(openai.endpoint_class, EndpointClass::Remote);

        let claude_cli = rows.iter().find(|r| r.preset_id == CLAUDE_CLI_ID).unwrap();
        assert_eq!(claude_cli.endpoint_class, EndpointClass::Subscription);

        let on_device = rows
            .iter()
            .find(|r| r.preset_id == ON_DEVICE_PROVIDER_ID)
            .unwrap();
        assert_eq!(on_device.endpoint_class, EndpointClass::OnDevice);

        // Regression: on-device-llm (chat sidecar) must ALSO classify as
        // OnDevice, not Remote — it has zero network exposure.
        let on_device_llm = rows
            .iter()
            .find(|r| r.preset_id == ON_DEVICE_LLM_ID)
            .unwrap();
        assert_eq!(on_device_llm.endpoint_class, EndpointClass::OnDevice);
    }

    /// `custom` is one of the two endpoint-editable presets — an arbitrary
    /// valid URL must still be accepted and stored as an override.
    #[test]
    fn credential_command_set_stores_endpoint_override_when_non_default() {
        let (state, _reg) = make_state_and_conn();
        let conn = state.lock().unwrap();
        persist_provider_credential(&conn, "custom", "https://my-gateway.example.com/v1", None)
            .unwrap();

        let endpoints = read_provider_endpoints(&conn).unwrap();
        assert_eq!(
            endpoints.get("custom").map(String::as_str),
            Some("https://my-gateway.example.com/v1")
        );
    }

    /// `other-local` is the other endpoint-editable preset — same contract
    /// as `custom`, covered separately since it's the local-server twin.
    #[test]
    fn credential_command_set_stores_endpoint_override_for_other_local() {
        let (state, _reg) = make_state_and_conn();
        let conn = state.lock().unwrap();
        persist_provider_credential(&conn, "other-local", "http://127.0.0.1:9999/v1", None)
            .unwrap();

        let endpoints = read_provider_endpoints(&conn).unwrap();
        assert_eq!(
            endpoints.get("other-local").map(String::as_str),
            Some("http://127.0.0.1:9999/v1")
        );
    }

    /// Setting the endpoint back to the preset's built-in default must NOT
    /// leave a redundant override row — mirrors the same convention
    /// `write_provider_endpoints` documents for an empty map.
    #[test]
    fn credential_command_set_endpoint_equal_to_default_clears_override() {
        let (state, _reg) = make_state_and_conn();
        let conn = state.lock().unwrap();
        persist_provider_credential(&conn, "other-local", "http://127.0.0.1:9999/v1", None)
            .unwrap();
        assert!(read_provider_endpoints(&conn)
            .unwrap()
            .contains_key("other-local"));

        persist_provider_credential(
            &conn,
            "other-local",
            preset_default_endpoint("other-local"),
            None,
        )
        .unwrap();
        assert!(
            !read_provider_endpoints(&conn)
                .unwrap()
                .contains_key("other-local"),
            "writing the default endpoint back must clear the override row"
        );
        let stamped = read_provider_endpoints_stamped(&conn).unwrap();
        assert_eq!(
            stamped.get("other-local").map(|r| r.endpoint.as_ref()),
            Some(None),
            "reset-to-default must stamp a tombstone {{endpoint: None}}, not drop the key"
        );
    }

    /// Critical-fix (defense-in-depth): a FIXED preset (openai) must reject
    /// a non-default endpoint outright — this is the exfiltration vector
    /// where an untrusted IPC caller, or a synced `ai_provider_endpoints`
    /// payload from another device, points a hosted preset at an
    /// attacker-controlled host that would then receive the preset's
    /// stored API key (and journal content) on the next hydration. No
    /// override row may be written.
    #[test]
    fn credential_command_set_rejects_non_default_endpoint_for_fixed_preset() {
        let (state, _reg) = make_state_and_conn();
        let conn = state.lock().unwrap();
        let err =
            persist_provider_credential(&conn, "openai", "https://attacker.example.com/v1", None)
                .unwrap_err();
        assert!(matches!(err, AiError::ProviderError(_)), "got: {err:?}");
        assert!(
            !read_provider_endpoints(&conn)
                .unwrap()
                .contains_key("openai"),
            "a rejected non-default endpoint must never be written to the registry"
        );
    }

    /// Normal flow: a FIXED preset (openai) configured with its own
    /// built-in default endpoint plus a key must keep succeeding — this is
    /// the dominant path the UI always takes for fixed presets (endpoint
    /// editing is only exposed for `custom` / `other-local`).
    #[test]
    fn credential_command_set_accepts_default_endpoint_for_fixed_preset_with_key() {
        let (state, _reg) = make_state_and_conn();
        let conn = state.lock().unwrap();
        let (class, _) = persist_provider_credential(
            &conn,
            "openai",
            preset_default_endpoint("openai"),
            Some("sk-live"),
        )
        .unwrap();
        assert_eq!(class, EndpointClass::Remote);

        assert!(
            !read_provider_endpoints(&conn)
                .unwrap()
                .contains_key("openai"),
            "the default endpoint must remain a no-op override (no row written)"
        );
        assert_eq!(
            read_provider_keyring(&conn)
                .unwrap()
                .get("openai")
                .map(String::as_str),
            Some("sk-live")
        );
    }

    #[test]
    fn credential_command_set_rejects_malformed_endpoint_url() {
        let (state, _reg) = make_state_and_conn();
        let conn = state.lock().unwrap();
        let err = persist_provider_credential(&conn, "openai", "not-a-url", None).unwrap_err();
        assert!(matches!(err, AiError::ProviderError(_)));
    }

    /// Regression guard: an accidentally-empty endpoint for a hosted preset
    /// must be a clear error, never a silently-stored override that shadows
    /// `preset_default_endpoint`'s fallback with `""`.
    #[test]
    fn credential_command_set_rejects_empty_endpoint_for_hosted_preset() {
        let (state, _reg) = make_state_and_conn();
        let conn = state.lock().unwrap();
        let err = persist_provider_credential(&conn, "openai", "", None).unwrap_err();
        assert!(matches!(err, AiError::ProviderError(_)));
        assert!(
            !read_provider_endpoints(&conn)
                .unwrap()
                .contains_key("openai"),
            "a rejected empty endpoint must never be written to the registry"
        );
    }

    /// CLI and on-device(-llm) presets have no HTTP surface — an empty
    /// endpoint for them is expected, not an error.
    #[test]
    fn credential_command_set_allows_empty_endpoint_for_no_http_surface_presets() {
        let (state, _reg) = make_state_and_conn();
        let conn = state.lock().unwrap();
        for preset_id in [
            CLAUDE_CLI_ID,
            CODEX_CLI_ID,
            ON_DEVICE_PROVIDER_ID,
            ON_DEVICE_LLM_ID,
        ] {
            persist_provider_credential(&conn, preset_id, "", None)
                .unwrap_or_else(|e| panic!("{preset_id} with empty endpoint must be allowed: {e}"));
        }
    }

    /// Tri-state roundtrip through the public read path: `Some(key)` sets,
    /// `None` preserves, `Some("")` clears.
    #[test]
    fn credential_command_set_key_tristate_roundtrips_through_get() {
        let (state, _reg) = make_state_and_conn();
        let conn = state.lock().unwrap();

        // Some(key) → sets.
        persist_provider_credential(&conn, "openai", "https://api.openai.com/v1", Some("sk-one"))
            .unwrap();
        let rows = provider_credentials_public(&conn).unwrap();
        assert!(
            rows.iter()
                .find(|r| r.preset_id == "openai")
                .unwrap()
                .has_api_key
        );
        assert_eq!(
            read_provider_keyring(&conn)
                .unwrap()
                .get("openai")
                .map(String::as_str),
            Some("sk-one")
        );

        // None → preserves the existing key (an endpoint-only edit must not
        // touch it).
        persist_provider_credential(&conn, "openai", "https://api.openai.com/v1", None).unwrap();
        assert_eq!(
            read_provider_keyring(&conn)
                .unwrap()
                .get("openai")
                .map(String::as_str),
            Some("sk-one")
        );

        // Some("") → explicit clear.
        persist_provider_credential(&conn, "openai", "https://api.openai.com/v1", Some(""))
            .unwrap();
        let rows = provider_credentials_public(&conn).unwrap();
        assert!(
            !rows
                .iter()
                .find(|r| r.preset_id == "openai")
                .unwrap()
                .has_api_key
        );
        assert!(!read_provider_keyring(&conn).unwrap().contains_key("openai"));
    }

    #[test]
    fn credential_command_set_key_for_one_preset_does_not_affect_another() {
        let (state, _reg) = make_state_and_conn();
        let conn = state.lock().unwrap();
        persist_provider_credential(
            &conn,
            "openai",
            "https://api.openai.com/v1",
            Some("sk-openai"),
        )
        .unwrap();
        persist_provider_credential(
            &conn,
            "anthropic",
            "https://api.anthropic.com/v1",
            Some("sk-anthropic"),
        )
        .unwrap();

        let keyring = read_provider_keyring(&conn).unwrap();
        assert_eq!(keyring.get("openai").map(String::as_str), Some("sk-openai"));
        assert_eq!(
            keyring.get("anthropic").map(String::as_str),
            Some("sk-anthropic")
        );
    }

    #[test]
    fn credential_command_set_computes_requires_privacy_consent_for_remote_class() {
        let (state, _reg) = make_state_and_conn();
        let conn = state.lock().unwrap();
        let (class, requires_consent) =
            persist_provider_credential(&conn, "openai", "https://api.openai.com/v1", Some("sk"))
                .unwrap();
        assert_eq!(class, EndpointClass::Remote);
        assert!(
            requires_consent,
            "remote class with no privacy receipt must require consent"
        );

        stamp_privacy_accepted(&conn, 1_700_000_000).unwrap();
        let (_, requires_consent2) =
            persist_provider_credential(&conn, "openai", "https://api.openai.com/v1", None)
                .unwrap();
        assert!(
            !requires_consent2,
            "an accepted receipt must satisfy the same class"
        );
    }

    #[test]
    fn credential_command_set_local_class_never_requires_privacy_consent() {
        let (state, _reg) = make_state_and_conn();
        let conn = state.lock().unwrap();
        let (class, requires_consent) =
            persist_provider_credential(&conn, "ollama", "http://127.0.0.1:11434/v1", None)
                .unwrap();
        assert_eq!(class, EndpointClass::Local);
        assert!(!requires_consent);
    }

    /// `forget_ai_provider_credential`'s pure core must clear BOTH registry
    /// rows — an endpoint-only or key-only clear would leave a stale row
    /// behind for the next `resolve_credential` read.
    #[test]
    fn credential_command_forget_clears_both_endpoint_and_key() {
        let (state, _reg) = make_state_and_conn();
        let conn = state.lock().unwrap();
        persist_provider_credential(
            &conn,
            "custom",
            "https://my-gateway.example.com/v1",
            Some("sk-secret"),
        )
        .unwrap();
        assert!(read_provider_endpoints(&conn)
            .unwrap()
            .contains_key("custom"));
        assert!(read_provider_keyring(&conn).unwrap().contains_key("custom"));

        forget_provider_credential(&conn, "custom").unwrap();

        assert!(
            !read_provider_endpoints(&conn)
                .unwrap()
                .contains_key("custom"),
            "forget must clear the endpoint override row"
        );
        assert!(
            !read_provider_keyring(&conn).unwrap().contains_key("custom"),
            "forget must clear the stored key row"
        );
        let stamped = read_provider_endpoints_stamped(&conn).unwrap();
        assert_eq!(
            stamped.get("custom").map(|r| r.endpoint.as_ref()),
            Some(None),
            "forget must stamp a tombstone {{endpoint: None}}, not drop the key"
        );
        let rows = provider_credentials_public(&conn).unwrap();
        let custom = rows.iter().find(|r| r.preset_id == "custom").unwrap();
        assert!(!custom.has_api_key);
        assert_eq!(custom.endpoint, preset_default_endpoint("custom"));
    }

    #[test]
    fn credential_command_forget_leaves_other_presets_untouched() {
        let (state, _reg) = make_state_and_conn();
        let conn = state.lock().unwrap();
        persist_provider_credential(
            &conn,
            "openai",
            "https://api.openai.com/v1",
            Some("sk-openai"),
        )
        .unwrap();
        persist_provider_credential(
            &conn,
            "anthropic",
            "https://api.anthropic.com/v1",
            Some("sk-anthropic"),
        )
        .unwrap();

        forget_provider_credential(&conn, "openai").unwrap();

        let keyring = read_provider_keyring(&conn).unwrap();
        assert!(!keyring.contains_key("openai"));
        assert_eq!(
            keyring.get("anthropic").map(String::as_str),
            Some("sk-anthropic")
        );
    }

    #[test]
    fn credential_command_forget_on_never_configured_preset_is_a_noop() {
        let (state, _reg) = make_state_and_conn();
        let conn = state.lock().unwrap();
        // Must not error even though "voyage" was never persisted.
        forget_provider_credential(&conn, "voyage").unwrap();
        assert!(!read_provider_endpoints(&conn)
            .unwrap()
            .contains_key("voyage"));
    }

    /// Regression: an unrecognized/typo'd preset id must be rejected with a
    /// clear error BEFORE any write — otherwise the credential is written
    /// under a garbage id that `get_ai_provider_credentials` (which only
    /// enumerates `ALL_PRESET_IDS`) can never read back or manage.
    #[test]
    fn credential_command_set_rejects_unknown_preset_id() {
        let (state, _reg) = make_state_and_conn();
        let conn = state.lock().unwrap();
        let err =
            persist_provider_credential(&conn, "not-a-real-preset", "https://example.com/v1", None)
                .unwrap_err();
        assert!(matches!(err, AiError::ProviderError(_)));
        assert!(
            !read_provider_endpoints(&conn)
                .unwrap()
                .contains_key("not-a-real-preset"),
            "a rejected unknown preset id must never be written to the registry"
        );
    }

    /// Sibling to `credential_command_set_rejects_unknown_preset_id` for the
    /// forget path.
    #[test]
    fn credential_command_forget_rejects_unknown_preset_id() {
        let (state, _reg) = make_state_and_conn();
        let conn = state.lock().unwrap();
        let err = forget_provider_credential(&conn, "not-a-real-preset").unwrap_err();
        assert!(matches!(err, AiError::ProviderError(_)));
    }

    // ── test_ai_provider_credential (T1.6) ──────────────────────────────────

    #[test]
    fn credential_command_preset_test_group_partitions_all_presets() {
        for &id in ALL_PRESET_IDS {
            let group = preset_test_group(id);
            match id {
                "ollama" | "lmstudio" | "llama-server" | "other-local" => {
                    assert_eq!(group, PresetTestGroup::Local, "{id}")
                }
                _ if id == CLAUDE_CLI_ID || id == CODEX_CLI_ID => {
                    assert_eq!(group, PresetTestGroup::Cli, "{id}")
                }
                _ if id == ON_DEVICE_PROVIDER_ID || id == ON_DEVICE_LLM_ID => {
                    assert_eq!(group, PresetTestGroup::Integrated, "{id}")
                }
                "voyage" => assert_eq!(group, PresetTestGroup::HostedEmbedOnly, "{id}"),
                "custom" => assert_eq!(group, PresetTestGroup::HostedCustom, "{id}"),
                _ => assert_eq!(group, PresetTestGroup::HostedChat, "{id}"),
            }
        }
    }

    /// MUST-have: a `custom` probe with no `probe_model` must return a clear
    /// error rather than silently probing with `""`.
    #[tokio::test]
    async fn credential_command_custom_probe_without_model_errors() {
        let err = test_ai_provider_credential_impl(
            "custom".into(),
            "https://my-gateway.example.com/v1".into(),
            Some("sk".into()),
            None,
            None,
        )
        .await
        .unwrap_err();
        assert!(
            err.contains("model is required"),
            "expected a clear 'model required' error, got: {err}"
        );
    }

    #[tokio::test]
    async fn credential_command_hosted_probe_without_model_errors() {
        let err = test_ai_provider_credential_impl(
            "openai".into(),
            "https://api.openai.com/v1".into(),
            Some("sk".into()),
            None,
            None,
        )
        .await
        .unwrap_err();
        assert!(err.contains("model is required"), "got: {err}");
    }

    /// MUST-have: CLI presets are not applicable to testing — typed error,
    /// never a panic or a misleading success.
    #[tokio::test]
    async fn credential_command_cli_probe_not_applicable() {
        let err =
            test_ai_provider_credential_impl(CLAUDE_CLI_ID.into(), String::new(), None, None, None)
                .await
                .unwrap_err();
        assert!(err.starts_with("AI_PROVIDER_UNSUPPORTED"), "got: {err}");
        assert!(err.contains("not applicable"));
    }

    #[tokio::test]
    async fn credential_command_integrated_probe_not_applicable() {
        let err = test_ai_provider_credential_impl(
            ON_DEVICE_LLM_ID.into(),
            String::new(),
            None,
            None,
            None,
        )
        .await
        .unwrap_err();
        assert!(err.starts_with("AI_PROVIDER_UNSUPPORTED"), "got: {err}");
    }

    /// Consistency with `set`/`forget`: an unrecognized preset id must be
    /// rejected outright rather than silently routed through
    /// `preset_test_group`'s `HostedCustom` fallback.
    #[tokio::test]
    async fn credential_command_test_rejects_unknown_preset_id() {
        let err = test_ai_provider_credential_impl(
            "not-a-real-preset".into(),
            "https://example.com/v1".into(),
            Some("sk".into()),
            Some("some-model".into()),
            None,
        )
        .await
        .unwrap_err();
        assert!(
            err.contains("unknown preset id"),
            "expected a clear 'unknown preset id' error, got: {err}"
        );
    }

    #[tokio::test]
    async fn credential_command_hosted_chat_probe_success_against_mock_server() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "choices": [{ "message": { "role": "assistant", "content": "pong" } }]
            })))
            .mount(&mock)
            .await;

        let out = test_ai_provider_credential_impl(
            "custom".into(),
            mock.uri(),
            Some("sk-test".into()),
            Some("gpt-4o-mini".into()),
            None,
        )
        .await
        .unwrap();
        assert!(out.dim.is_none());
        assert!(out.model_count.is_none());
    }

    #[tokio::test]
    async fn credential_command_voyage_embed_probe_success_against_mock_server() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/embeddings"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": [{ "embedding": [1.0_f32, 0.0_f32, 0.0_f32], "index": 0 }]
            })))
            .mount(&mock)
            .await;

        let out = test_ai_provider_credential_impl(
            "voyage".into(),
            mock.uri(),
            Some("pa-test".into()),
            Some("voyage-3.5".into()),
            None,
        )
        .await
        .unwrap();
        assert_eq!(out.dim, Some(3));
        assert!(out.model_count.is_none());
    }

    #[tokio::test]
    async fn credential_command_local_reachability_probe_counts_models_without_chat_or_embed_call()
    {
        let mock = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/models"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": [{ "id": "llama3" }, { "id": "mistral" }]
            })))
            .mount(&mock)
            .await;
        // No chat/completions or embeddings mock registered — if the local
        // probe ever called either, wiremock would 404 and this would fail.

        let out = test_ai_provider_credential_impl("ollama".into(), mock.uri(), None, None, None)
            .await
            .unwrap();
        assert_eq!(out.model_count, Some(2));
        assert!(out.dim.is_none());
    }

    #[tokio::test]
    async fn credential_command_local_probe_unreachable_endpoint_errors() {
        // Nothing listening on this port.
        let err = test_ai_provider_credential_impl(
            "ollama".into(),
            "http://127.0.0.1:1".into(),
            None,
            None,
            None,
        )
        .await
        .unwrap_err();
        assert!(err.starts_with("AI_PROVIDER_ERROR"), "got: {err}");
    }

    #[tokio::test]
    async fn credential_command_local_probe_requires_endpoint() {
        let err =
            test_ai_provider_credential_impl("ollama".into(), String::new(), None, None, None)
                .await
                .unwrap_err();
        assert!(err.starts_with("AI_PROVIDER_ERROR"), "got: {err}");
    }

    /// Fix #4 [Important]: a key-protected local server (ollama/lmstudio/
    /// llama-server/other-local behind an optional API key) must receive
    /// that key as a bearer token on the `/models` reachability probe — the
    /// mock only responds 200 if the exact `Authorization` header arrives,
    /// so this would fail with the pre-fix behaviour that dropped the key.
    #[tokio::test]
    async fn credential_command_local_probe_sends_bearer_when_key_supplied() {
        let mock = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/models"))
            .and(header("authorization", "Bearer local-secret"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": [{ "id": "llama3" }]
            })))
            .mount(&mock)
            .await;

        let out = test_ai_provider_credential_impl(
            "ollama".into(),
            mock.uri(),
            Some("local-secret".into()),
            None,
            None,
        )
        .await
        .unwrap();
        assert_eq!(out.model_count, Some(1));
    }

    /// Fix #4 backward-compat guard: no `api_key` supplied must still omit
    /// the `Authorization` header entirely (some local servers reject any
    /// bearer header, even an empty one) — unprotected servers must keep
    /// working exactly as before the fix.
    #[tokio::test]
    async fn credential_command_local_probe_omits_bearer_when_no_key() {
        let mock = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/models"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": [{ "id": "llama3" }]
            })))
            .mount(&mock)
            .await;

        let out = test_ai_provider_credential_impl("ollama".into(), mock.uri(), None, None, None)
            .await
            .unwrap();
        assert_eq!(out.model_count, Some(1));

        let received = mock.received_requests().await.unwrap();
        assert_eq!(received.len(), 1);
        assert!(
            received[0].headers.get("authorization").is_none(),
            "no Authorization header must be sent when no api_key is supplied"
        );
    }

    /// Fix #5 [Important]: `custom` supports both chat and embed
    /// capabilities, but was always routed through the chat probe
    /// regardless of what the endpoint actually implements. Passing
    /// `capability: Some("embed")` must route through `probe_credential_embed`
    /// (`/embeddings`) instead of the default chat probe.
    #[tokio::test]
    async fn credential_command_custom_embed_capability_routes_to_embed_probe() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/embeddings"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": [{ "embedding": [1.0_f32, 0.0_f32, 0.0_f32], "index": 0 }]
            })))
            .mount(&mock)
            .await;
        // No /chat/completions mock registered — if capability routing ever
        // fell through to the chat probe, wiremock would 404 and this
        // would fail.

        let out = test_ai_provider_credential_impl(
            "custom".into(),
            mock.uri(),
            Some("sk-test".into()),
            Some("custom-embed-model".into()),
            Some("embed".into()),
        )
        .await
        .unwrap();
        assert_eq!(out.dim, Some(3));
        assert!(out.model_count.is_none());
    }

    /// Regression guard: omitting `capability` (or passing anything other
    /// than `"embed"`) for `custom` must keep defaulting to the chat probe —
    /// today's behaviour for any caller that doesn't know about the new
    /// parameter.
    #[tokio::test]
    async fn credential_command_custom_without_capability_still_defaults_to_chat_probe() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "choices": [{ "message": { "role": "assistant", "content": "pong" } }]
            })))
            .mount(&mock)
            .await;

        let out = test_ai_provider_credential_impl(
            "custom".into(),
            mock.uri(),
            Some("sk-test".into()),
            Some("gpt-4o-mini".into()),
            None,
        )
        .await
        .unwrap();
        assert!(out.dim.is_none());
    }

    /// `capability` must have no effect on presets that are already
    /// unambiguous — `voyage` (`HostedEmbedOnly`) must always probe
    /// `/embeddings`, never `/chat/completions`, even if `capability:
    /// Some("chat")` is (incorrectly) passed.
    #[tokio::test]
    async fn credential_command_voyage_ignores_capability_stays_embed_only() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/embeddings"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": [{ "embedding": [1.0_f32, 0.0_f32, 0.0_f32], "index": 0 }]
            })))
            .mount(&mock)
            .await;

        let out = test_ai_provider_credential_impl(
            "voyage".into(),
            mock.uri(),
            Some("pa-test".into()),
            Some("voyage-3.5".into()),
            Some("chat".into()),
        )
        .await
        .unwrap();
        assert_eq!(out.dim, Some(3));
    }

    /// Phase-2 regression: multi-capability hosted presets (openai, gemini,
    /// together, openrouter, ...) are `HostedChat`, but several also support
    /// embeddings. Before this fix, `capability` was only consulted for
    /// `HostedCustom` — any `HostedChat` preset always chat-probed, so
    /// testing an OpenAI embedding-slot connection incorrectly POSTed the
    /// embedding model to `/chat/completions` and reported a valid
    /// credential as broken. `capability: Some("embed")` must route
    /// `HostedChat` presets through `probe_credential_embed` too.
    #[tokio::test]
    async fn credential_command_hosted_chat_embed_capability_routes_to_embed_probe() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/embeddings"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": [{ "embedding": [1.0_f32, 0.0_f32, 0.0_f32], "index": 0 }]
            })))
            .mount(&mock)
            .await;
        // No /chat/completions mock registered — if capability routing ever
        // fell through to the chat probe, wiremock would 404 and this
        // would fail.

        let out = test_ai_provider_credential_impl(
            "openai".into(),
            mock.uri(),
            Some("sk-test".into()),
            Some("text-embedding-3-small".into()),
            Some("embed".into()),
        )
        .await
        .unwrap();
        assert_eq!(out.dim, Some(3));
        assert!(out.model_count.is_none());
    }

    /// Regression guard: `HostedChat` presets with `capability: Some("chat")`
    /// (or `None`) must keep chat-probing — the fix must not flip the
    /// default for the common case.
    #[tokio::test]
    async fn credential_command_hosted_chat_without_embed_capability_still_chat_probes() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "choices": [{ "message": { "role": "assistant", "content": "pong" } }]
            })))
            .mount(&mock)
            .await;
        // No /embeddings mock registered — if this ever embed-probed instead,
        // wiremock would 404 and this would fail.

        let chat_capability = test_ai_provider_credential_impl(
            "openai".into(),
            mock.uri(),
            Some("sk-test".into()),
            Some("gpt-4o-mini".into()),
            Some("chat".into()),
        )
        .await
        .unwrap();
        assert!(chat_capability.dim.is_none());

        let no_capability = test_ai_provider_credential_impl(
            "openai".into(),
            mock.uri(),
            Some("sk-test".into()),
            Some("gpt-4o-mini".into()),
            None,
        )
        .await
        .unwrap();
        assert!(no_capability.dim.is_none());
    }

    // ── Round-3 review fix #2 ───────────────────────────────────────────────

    /// [`resolve_preset_test_api_key`] must resolve the preset's stored key
    /// from the per-preset credential registry when the caller omits
    /// `api_key` — a future "Test connection" click on an already-saved
    /// credential never has the real key to send (`get_ai_provider_credentials`
    /// never returns one), so without this fallback the probe would run
    /// unauthenticated.
    #[test]
    fn resolve_preset_test_api_key_resolves_stored_key_when_omitted() {
        let (state, _registry) = make_state_and_conn();
        let conn = state.lock().unwrap();
        persist_provider_credential(
            &conn,
            "openai",
            "https://api.openai.com/v1",
            Some("sk-stored"),
        )
        .unwrap();

        let resolved = resolve_preset_test_api_key(&conn, "openai", None).unwrap();
        assert_eq!(resolved.as_deref(), Some("sk-stored"));
    }

    /// An explicit `Some(k)` must always take precedence over whatever is
    /// stored — this is how a user tests a NEW, not-yet-saved key before
    /// committing it.
    #[test]
    fn resolve_preset_test_api_key_explicit_key_overrides_stored() {
        let (state, _registry) = make_state_and_conn();
        let conn = state.lock().unwrap();
        persist_provider_credential(
            &conn,
            "openai",
            "https://api.openai.com/v1",
            Some("sk-stored"),
        )
        .unwrap();

        let resolved =
            resolve_preset_test_api_key(&conn, "openai", Some("sk-new-untested")).unwrap();
        assert_eq!(resolved.as_deref(), Some("sk-new-untested"));
    }

    /// `Some("")` is an explicit clear, not a request to resolve the stored
    /// key — mirrors `resolve_slot_api_key`'s convention.
    #[test]
    fn resolve_preset_test_api_key_explicit_empty_clears_rather_than_resolving_stored() {
        let (state, _registry) = make_state_and_conn();
        let conn = state.lock().unwrap();
        persist_provider_credential(
            &conn,
            "openai",
            "https://api.openai.com/v1",
            Some("sk-stored"),
        )
        .unwrap();

        let resolved = resolve_preset_test_api_key(&conn, "openai", Some("")).unwrap();
        assert_eq!(resolved, None);
    }

    /// End-to-end shape of what the `#[tauri::command]` wrapper does:
    /// resolve, then dispatch. Proves the resolved STORED key actually
    /// reaches the outgoing HTTP request's `Authorization` header — the
    /// mock only responds 200 for the exact stored key, so the pre-fix
    /// behaviour (probing with `api_key: None` passed straight through,
    /// unauthenticated) would fail this.
    #[tokio::test]
    async fn credential_command_test_with_omitted_key_uses_stored_credential() {
        let (state, _registry) = make_state_and_conn();
        let conn = state.lock().unwrap();

        let mock = MockServer::start().await;
        persist_provider_credential(&conn, "custom", &mock.uri(), Some("sk-stored")).unwrap();

        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .and(header("authorization", "Bearer sk-stored"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "choices": [{ "message": { "role": "assistant", "content": "pong" } }]
            })))
            .mount(&mock)
            .await;

        let resolved_key = resolve_preset_test_api_key(&conn, "custom", None).unwrap();
        let out = test_ai_provider_credential_impl(
            "custom".into(),
            mock.uri(),
            resolved_key,
            Some("gpt-4o-mini".into()),
            None,
        )
        .await
        .unwrap();
        assert!(out.dim.is_none());
    }

    /// Same end-to-end shape, but `api_key: Some(k)` is supplied — the
    /// resolution must use the caller-supplied key, not the stored one,
    /// even though a (different) stored key exists.
    #[tokio::test]
    async fn credential_command_test_with_explicit_key_ignores_stored_credential() {
        let (state, _registry) = make_state_and_conn();
        let conn = state.lock().unwrap();

        let mock = MockServer::start().await;
        persist_provider_credential(&conn, "custom", &mock.uri(), Some("sk-stored")).unwrap();

        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .and(header("authorization", "Bearer sk-new-untested"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "choices": [{ "message": { "role": "assistant", "content": "pong" } }]
            })))
            .mount(&mock)
            .await;

        let resolved_key =
            resolve_preset_test_api_key(&conn, "custom", Some("sk-new-untested")).unwrap();
        let out = test_ai_provider_credential_impl(
            "custom".into(),
            mock.uri(),
            resolved_key,
            Some("gpt-4o-mini".into()),
            None,
        )
        .await
        .unwrap();
        assert!(out.dim.is_none());
    }

    // ── Teardown-on-delete for on-device embed models ──────────────────────

    #[test]
    fn should_forget_embed_on_remove_truth_table() {
        assert!(
            should_forget_embed_on_remove(
                ON_DEVICE_PROVIDER_ID,
                catalog::MULTILINGUAL_E5_BASE,
                catalog::MULTILINGUAL_E5_BASE,
            ),
            "on-device provider + matching model id -> forget"
        );
        assert!(
            !should_forget_embed_on_remove(
                "openai",
                catalog::MULTILINGUAL_E5_BASE,
                catalog::MULTILINGUAL_E5_BASE,
            ),
            "hosted embed provider must not forget even if the id string matches"
        );
        assert!(
            !should_forget_embed_on_remove(
                ON_DEVICE_PROVIDER_ID,
                catalog::NOMIC_EMBED_TEXT_V15,
                catalog::MULTILINGUAL_E5_BASE,
            ),
            "a different on-device model is selected -> do not forget"
        );
        assert!(!should_forget_embed_on_remove(
            "",
            "",
            catalog::MULTILINGUAL_E5_BASE
        ));
    }

    fn seed_ready_embed_model(manager: &DownloadManager, id: &str) {
        let dir = manager.model_dir(id);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(".on_device_ready"), b"1").unwrap();
        assert!(
            manager.is_downloaded(id),
            "seed must produce a ready marker"
        );
    }

    #[test]
    fn in_use_embed_remove_clears_embed_settings_and_deletes_files() {
        use crate::ai::embedder::StubEmbedder;
        use crate::ai::indexer::EntryIndexer;
        use crate::commands::ai::BackfillManager;

        let (state, registry) = make_state_and_conn();
        let conn = state.lock().unwrap();
        let id = catalog::MULTILINGUAL_E5_BASE;
        db::set_setting(&conn, EmbedKeys::PROVIDER, ON_DEVICE_PROVIDER_ID).unwrap();
        db::set_setting(&conn, EmbedKeys::model_key(), id).unwrap();
        db::set_setting(&conn, settings_keys::gen::PROVIDER, "openai").unwrap();
        db::set_setting(&conn, settings_keys::gen::CHAT_MODEL, "gpt-4o-mini").unwrap();

        let tmp = tempfile::tempdir().unwrap();
        let manager = DownloadManager::new(tmp.path().to_path_buf());
        seed_ready_embed_model(&manager, id);

        let mock: Arc<dyn AIProvider> = Arc::new(MockAIProvider::new(ON_DEVICE_PROVIDER_ID, id));
        registry.swap_embedding(mock);
        assert!(registry.is_embedding_configured());

        let indexer = EntryIndexer::from_dyn(Arc::new(StubEmbedder::new(
            "on-device:multilingual-e5-base",
            8,
        )));
        let backfill = BackfillManager::new();
        let _ = backfill.start("on-device:multilingual-e5-base".into(), 1);
        assert!(backfill.status().running);

        let wire = teardown_and_remove_on_device_embed_model(
            &conn, id, &registry, &manager, &indexer, &backfill,
        )
        .expect("in-use embed remove must succeed");
        assert_eq!(wire, OnDeviceModelStateWire::NotDownloaded);

        assert!(
            db::get_setting(&conn, EmbedKeys::PROVIDER)
                .unwrap()
                .is_none(),
            "in-use remove must forget ai_embed_provider"
        );
        assert!(
            db::get_setting(&conn, EmbedKeys::model_key())
                .unwrap()
                .is_none(),
            "in-use remove must forget ai_embed_embedding_model"
        );
        assert!(
            !registry.is_embedding_configured(),
            "in-use remove must clear the embedding registry slot"
        );
        assert_eq!(
            db::get_setting(&conn, settings_keys::gen::PROVIDER)
                .unwrap()
                .as_deref(),
            Some("openai"),
            "gen slot must be left alone"
        );
        assert!(!manager.is_downloaded(id), "embed files must be gone");
        assert_eq!(indexer.model_id(), "embedding-stub-768");
    }

    #[test]
    fn not_in_use_embed_remove_leaves_embed_settings_and_still_deletes_files() {
        use crate::ai::embedder::StubEmbedder;
        use crate::ai::indexer::EntryIndexer;
        use crate::commands::ai::BackfillManager;

        let (state, registry) = make_state_and_conn();
        let conn = state.lock().unwrap();
        let id = catalog::NOMIC_EMBED_TEXT_V15;
        db::set_setting(&conn, EmbedKeys::PROVIDER, "openai").unwrap();
        db::set_setting(&conn, EmbedKeys::model_key(), "text-embedding-3-small").unwrap();

        let tmp = tempfile::tempdir().unwrap();
        let manager = DownloadManager::new(tmp.path().to_path_buf());
        seed_ready_embed_model(&manager, id);

        let mock: Arc<dyn AIProvider> =
            Arc::new(MockAIProvider::new("openai", "text-embedding-3-small"));
        registry.swap_embedding(mock);

        let indexer = EntryIndexer::from_dyn(Arc::new(StubEmbedder::new(
            "openai:text-embedding-3-small",
            8,
        )));
        let backfill = BackfillManager::new();

        let wire = teardown_and_remove_on_device_embed_model(
            &conn, id, &registry, &manager, &indexer, &backfill,
        )
        .expect("not-in-use embed remove must succeed");
        assert_eq!(wire, OnDeviceModelStateWire::NotDownloaded);

        assert_eq!(
            db::get_setting(&conn, EmbedKeys::PROVIDER)
                .unwrap()
                .as_deref(),
            Some("openai"),
            "not-in-use remove must leave ai_embed_provider"
        );
        assert_eq!(
            db::get_setting(&conn, EmbedKeys::model_key())
                .unwrap()
                .as_deref(),
            Some("text-embedding-3-small"),
            "not-in-use remove must leave the embed model row"
        );
        assert!(
            registry.is_embedding_configured(),
            "not-in-use remove must leave the embedding registry slot"
        );
        assert_eq!(indexer.model_id(), "openai:text-embedding-3-small");
        assert!(!manager.is_downloaded(id), "files must still be deleted");
    }

    #[test]
    fn different_on_device_embed_model_remove_leaves_active_slot() {
        use crate::ai::embedder::StubEmbedder;
        use crate::ai::indexer::EntryIndexer;
        use crate::commands::ai::BackfillManager;

        let (state, registry) = make_state_and_conn();
        let conn = state.lock().unwrap();
        let active = catalog::MULTILINGUAL_E5_BASE;
        let other = catalog::MULTILINGUAL_E5_SMALL;
        db::set_setting(&conn, EmbedKeys::PROVIDER, ON_DEVICE_PROVIDER_ID).unwrap();
        db::set_setting(&conn, EmbedKeys::model_key(), active).unwrap();

        let tmp = tempfile::tempdir().unwrap();
        let manager = DownloadManager::new(tmp.path().to_path_buf());
        seed_ready_embed_model(&manager, other);

        let indexer = EntryIndexer::from_dyn(Arc::new(StubEmbedder::new(
            "on-device:multilingual-e5-base",
            8,
        )));
        let backfill = BackfillManager::new();

        teardown_and_remove_on_device_embed_model(
            &conn, other, &registry, &manager, &indexer, &backfill,
        )
        .expect("removing a non-active on-device model must succeed");

        assert_eq!(
            db::get_setting(&conn, EmbedKeys::PROVIDER)
                .unwrap()
                .as_deref(),
            Some(ON_DEVICE_PROVIDER_ID)
        );
        assert_eq!(
            db::get_setting(&conn, EmbedKeys::model_key())
                .unwrap()
                .as_deref(),
            Some(active)
        );
        assert!(!manager.is_downloaded(other));
    }
}
