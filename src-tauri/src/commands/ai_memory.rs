//! AI User Memory extraction command + apply-ops logic (Phase 3 Task T3.2).
//!
//! This module owns the **core extraction fn** [`extract_memories_for_source`]
//! and its apply-ops logic: given a source (`daily_chat` session or
//! `journal_entry`), gather its text, ask the configured memory generation
//! model (on-machine by default; hosted/CLI only once the user has opted
//! into `ai_memory_allow_hosted` — see
//! `docs/plans/2026-07-29-ai-user-memory/README.md`'s Amendment section) how
//! to consolidate it against the existing related memories, then apply the
//! returned add/update/delete ops to `memory_items` / `memory_embeddings` /
//! `memory_item_sources`, marking the `memory_jobs` row complete / skipped /
//! failed as appropriate.
//!
//! **Scope.** This module implements:
//! - T3.2: the core extraction fn [`extract_memories_for_source`] and its
//!   apply-ops logic.
//! - T3.3: the scan pass [`run_memory_scan`] + [`scan_memories`] command that
//!   populates `memory_jobs` via content-hash diff.
//!
//! The background worker loop that calls both fns on a cadence is T3.4 and
//! lands in a later dispatch on top of this public surface.
//!
//! Plan references (`docs/plans/2026-07-29-ai-user-memory`):
//! - decision 6 — consolidate at extraction time (the model emits
//!   add/update/delete ops over an "existing related memories" list, not raw
//!   facts).
//! - decision 8 — asymmetric privacy gate. Invisible entries are ALWAYS
//!   excluded; locked entries are excluded UNLESS `ai_memory_include_protected`
//!   is ON — a memory-extraction-specific opt-in (see
//!   [`read_memory_include_protected`]), independent of the entry-embedding
//!   backfill's `ai_embed_include_protected`. Mirrors the unconditional
//!   invisible filter inside `get_entry_for_provider`.
//! - decision 11 — AI-usage attribution. Every provider call in the
//!   extraction worker (related-memory query embed, extraction chat, inline
//!   item embeds, backfill embeds) is wrapped in
//!   `with_feature(FEATURE_MEMORY_EXTRACTION, ...)`. The
//!   `FEATURE_MEMORY_RETRIEVAL` slug is reserved for the Phase 4 chat-time
//!   query embed and is NOT used here.
//!
//! All DB access goes through `src-tauri/src/db/` (no raw SQL in commands).
//! Every provider call is async and holds NO DB lock across `.await` — each
//! `with_conn` closure returns before the next `.await`.

use std::sync::{Arc, OnceLock};

use rusqlite::Connection;
use tauri::State;

use crate::ai::audit::with_feature;
use crate::ai::chunking;
use crate::ai::memory_extractor::{
    parse_consolidation_ops, parse_extraction_ops, sanitize_memory_text, ConsolidationOp,
    CONSOLIDATION_SYSTEM_PROMPT, EXTRACTION_SYSTEM_PROMPT, FEATURE_MEMORY_CONSOLIDATION,
    FEATURE_MEMORY_EXTRACTION,
};
use crate::ai::persona_builder::{
    build_style_prompt, build_traits_prompt, exceeds_verbatim_echo_drop_threshold,
    parse_persona_sections, persona_nonempty_line_count, render_persona_answers,
    sanitize_persona_text, strip_verbatim_echoes, validate_and_sanitize_persona_answers,
    FEATURE_PERSONA_BUILD,
};
use crate::ai::provider::{provider_namespaced_model_id, ChatOpts, Message, MessageRole};
use crate::ai::provider_registry::ProviderRegistry;
use crate::db::{self, memory, persona};
use crate::AppState;

/// Number of existing related memories fed to the extraction model for
/// consolidation context (decision 6). Small enough to keep the prompt well
/// under a small model's context window; large enough that the model sees the
/// facts most likely to overlap with the source.
const RELATED_MEMORIES_K: usize = 6;

/// Permissive `min_score` floor for [`memory::retrieve_top_k_memories`] at
/// the consolidation call site — see that fn's doc for the canonical
/// two-floors explanation (this site vs. [`crate::commands::ai::CHAT_MEMORY_MIN_SIMILARITY`]).
/// `f32::NEG_INFINITY` rather than `-1.0`: [`crate::db::embeddings::cosine_unit`]
/// is a bare dot product with no unit-vector normalization enforced, so
/// `-1.0` is only a true floor under an assumption the fn doesn't guarantee
/// (💡 review pass 2) — `NEG_INFINITY` keeps every candidate regardless,
/// which is what "permissive" is supposed to mean here.
const CONSOLIDATION_MIN_SCORE: f32 = f32::NEG_INFINITY;

/// Backoff schedule (seconds) for a failed extraction job, indexed by the
/// current `attempt_count` BEFORE the bump. Mirrors the embeddings worker's
/// 60 / 300 / 900 / 3600s cadence; after the last step the interval saturates
/// at 3600s until the worker (T3.4) decides to pause the job.
const BACKOFF_SECONDS: &[i64] = &[60, 300, 900, 3600];

/// How many extraction jobs one worker tick claims. Bounded so a single tick
/// never fans out into an unbounded batch of model calls — mirrors the
/// embedding worker's small per-tick batch (`WORKER_PASS_DIRTY_BATCH`).
const MEMORY_CLAIM_LIMIT: usize = 5;

/// Upper bound on how many items the backfill pass embeds in one tick. Memory
/// item counts are bounded (distilled durable facts), so this is a safety cap
/// against a pathological post-sync flood rather than a normally-binding limit.
const MEMORY_BACKFILL_LIMIT: usize = 50;

/// Pause a job after this many cumulative extraction failures. The backoff
/// schedule ([`BACKOFF_SECONDS`]) has four steps (60 / 300 / 900 / 3600s); once
/// a job has burned through the whole schedule, further retries would just
/// repeat the saturated 3600s interval, so the worker pauses the job instead.
/// The embedding indexer pauses immediately on auth/config-class errors (via
/// `is_auth_or_config_error`); extraction surfaces a `String` error at the loop
/// boundary (T3.2 stringifies before `fail_job`), so the equivalent gate here
/// is attempt-count-based.
const PAUSE_AT_ATTEMPT_COUNT: i64 = BACKOFF_SECONDS.len() as i64;

/// Background memory tick interval (seconds). The embedding worker ticks every
/// 500ms because it services save-triggered dirty marks and the user expects a
/// just-saved entry to be searchable promptly. Memory extraction is scan-driven
/// and model-expensive (each claimed source is a full chat call), so a slower
/// cadence is both appropriate and deliberate — 30s keeps a fresh journal edit
/// or chat turn visible to extraction within a minute without burning CPU/GPU
/// on an idle database.
const MEMORY_TICK_INTERVAL_SECS: u64 = 30;

const PERSONA_SAMPLE_ENTRY_LIMIT: usize = 12;
const PERSONA_SAMPLE_ENTRY_MAX_CHARS: usize = 1_500;
const PERSONA_SAMPLE_TOTAL_MAX_CHARS: usize = 15_000;
const PERSONA_STYLE_MIN_ENTRIES: usize = 3;
const PERSONA_REFRESH_COOLDOWN_SECS: i64 = 24 * 60 * 60;

/// A pull can introduce memory items whose peer vectors use a different
/// model. Wake the worker so its active-model backfill does not wait for the
/// next 30-second scan interval. `Notify` retains one permit, so a nudge that
/// arrives while the worker is busy or between waits is not lost.
static MEMORY_WORKER_NUDGE: OnceLock<tokio::sync::Notify> = OnceLock::new();

fn memory_worker_nudge() -> &'static tokio::sync::Notify {
    MEMORY_WORKER_NUDGE.get_or_init(tokio::sync::Notify::new)
}

/// Wake the memory worker after sync has merged an item missing the local
/// model's vector. The tick itself retains the normal provider/configuration
/// gate, so this is a zero-work no-op when AI User Memory is not configured.
pub fn nudge_memory_worker() {
    memory_worker_nudge().notify_one();
}

// ---------------------------------------------------------------------------
// Core extraction fn
// ---------------------------------------------------------------------------

/// `true` iff `class` — the endpoint class of a memory slot's currently
/// swapped-in provider (`AIProvider::endpoint_class()`, the LIVE resolved
/// class, not a settings-row lookup — a zero-config on-device default has no
/// settings row at all) — satisfies the unified AI privacy receipt:
/// auto-true for `Local`/`OnDevice`, and for `Remote`/`Subscription` only
/// once the user has accepted the general AI privacy notice
/// (`ai_provider::class_privacy_accepted`, the same receipt every other
/// off-machine AI feature checks). Memory slots are on-machine by default; a
/// `Remote`/`Subscription` class here only happens once the user has ALSO
/// opted into `ai_memory_allow_hosted` — this is a second, independent gate
/// on top of that opt-in, not a replacement for it.
fn memory_class_privacy_accepted(
    state: &AppState,
    class: crate::ai::provider::EndpointClass,
) -> Result<bool, String> {
    state.with_conn(|conn| {
        crate::commands::ai_provider::class_privacy_accepted(conn, class).map_err(String::from)
    })
}

/// Extract durable user memories from a single source.
///
/// `source_type` is one of `"daily_chat"` (a chat session transcript) or
/// `"journal_entry"` (an entry's indexable text). `source_id` is the chat
/// session id or entry id.
///
/// Flow (strictly ordered — see plan T3.2):
/// 1. **Gate.** If the feature is inactive (`is_user_memory_active` = master
///    preference AND both memory slots configured), return `Ok(())` WITHOUT
///    writing to the job — never `skipped`, so a temporarily-off toggle can't
///    strand sources. An unclaimed job stays `pending`; a job the worker
///    already claimed stays `in_progress` until
///    `recover_stranded_in_progress_memory_jobs` re-queues it on the next
///    ACTIVE tick, after which it is re-processed. Zero provider calls in
///    this path.
/// 2. **Gather source text + privacy gate.** Invisible entries are always
///    excluded; locked entries are excluded unless `ai_memory_include_protected`
///    is ON. A skipped source (locked-no-opt-in, invisible, missing, or empty)
///    marks the job `skipped` and returns with no provider call.
/// 3. **Related-memory query embed** (memory embed slot), attributed to
///    `memory_extraction`.
/// 4. **Retrieve top-K existing related memories** (decision 6) — the
///    retrieval-time privacy re-check inside `retrieve_top_k_memories`
///    already drops hits whose contributing entries are currently
///    locked/invisible.
/// 5. **Extraction chat call** (memory generation slot), attributed to
///    `memory_extraction`.
/// 6. **Parse** the model's output via `parse_extraction_ops` (strict — any
///    rejection fails the WHOLE job, no partial application).
/// 7. **Apply ops** — add/update/delete, each with an inline item embed for
///    add/update. A single op whose `id` does not exist is skipped (logged),
///    not a job failure. Provider/parse errors fail the job.
/// 8. On success → `complete_memory_job`. On provider/parse error →
///    `fail_memory_job` with the next backoff interval, then propagate `Err`.
///
/// This fn is the entry point for the T3.4 worker loop and takes raw
/// `&AppState` / `&ProviderRegistry` (NOT a `#[tauri::command]` shape). The
/// thin [`extract_memories_for_source_command`] wrapper exposes it to the
/// frontend for manual triggering.
///
/// `now` is threaded through every helper that writes a timestamp
/// (`mark_skipped`, `fail_job`, `apply_ops`, `embed_memory_item`,
/// `complete_memory_job`) so tests can assert exact backoff intervals and
/// watermark values rather than racing `chrono::Utc::now()`. Callers that are
/// not test-driven (the Tauri command wrapper) pass a real
/// `chrono::Utc::now().timestamp()`.
pub async fn extract_memories_for_source(
    state: &AppState,
    registry: &ProviderRegistry,
    source_type: &str,
    source_id: &str,
    now: i64,
) -> Result<(), String> {
    // 1. GATE — preference ON ∧ both memory slots. Bail before any provider
    //    call or source-text read when inactive. Do NOT mark the job skipped:
    //    a temporary master-toggle off must not strand sources as skipped.
    let active = state.with_conn(|conn| {
        Ok(crate::commands::ai_settings::is_user_memory_active(
            conn, registry,
        ))
    })?;
    if !active {
        return Ok(());
    }
    // The gate above already guarantees both slots are populated; these
    // accessors re-read the registry, so a concurrent settings save could
    // have emptied a slot in between (benign TOCTOU). Bail the same way the
    // gate does — leave the job as-is; the next active tick's
    // stranded-`in_progress` recovery re-queues it.
    let gen_slot = registry.memory_generation();
    let embed_slot = registry.memory_embedder();
    let (gen_present, embed_present) = (gen_slot.is_some(), embed_slot.is_some());
    let (Some(gen_provider), Some(embed_provider)) = (gen_slot, embed_slot) else {
        log::warn!(
            "memory extraction for {source_type}:{source_id} bailed: a memory slot emptied \
             after the active gate (generation set: {gen_present}, embedding set: \
             {embed_present}); job left for the next active tick"
        );
        return Ok(());
    };
    // Provider-namespaced (`"{provider}:{model}"`) — MUST stay in the same
    // form `sync::engine::configured_memory_embedding_model_id` composes from
    // the settings rows, or peer devices can never adopt this device's
    // synced vectors (`adopt_memory_embedding_if_matching`).
    let embed_model_id = provider_namespaced_model_id(embed_provider.as_ref());

    // 1b. PRIVACY — a hosted/CLI memory slot (only reachable once
    //     `ai_memory_allow_hosted` is on) still needs the same unified AI
    //     privacy receipt every other off-machine AI feature requires before
    //     raw entries/transcripts are sent to it. Local/OnDevice are
    //     auto-exempt. Skip (not fail) the job — this is a consent gap, not
    //     an error. Uses the hash-CLEARING skip (like the scan-time
    //     locked/invisible gate), not `mark_skipped` — a recoverable consent
    //     gap needs the recoverable marker, so accepting the receipt later
    //     lets the next scan's content-hash diff re-queue the source instead
    //     of it staying `skipped` forever with its hash preserved.
    if !memory_class_privacy_accepted(state, gen_provider.endpoint_class())?
        || !memory_class_privacy_accepted(state, embed_provider.endpoint_class())?
    {
        mark_skipped_recoverable(state, source_type, source_id, now)?;
        return Ok(());
    }

    // 2. Gather source text (+ privacy gate for journal_entry). Returns None
    //    when the source should be treated as skipped (missing, invisible,
    //    locked-without-opt-in, or empty).
    let source_text: Option<String> =
        state.with_conn(|conn| gather_source_text(conn, source_type, source_id))?;
    let Some(source_text) = source_text else {
        mark_skipped(state, source_type, source_id, now)?;
        return Ok(());
    };
    if source_text.trim().is_empty() {
        mark_skipped(state, source_type, source_id, now)?;
        return Ok(());
    }

    // 3. Related-memory query embed (extraction-worker attribution).
    let query_vec = {
        let result = with_feature(FEATURE_MEMORY_EXTRACTION, async {
            embed_provider.embed_query(&[source_text.as_str()]).await
        })
        .await;
        let vecs = match result {
            Ok(v) => v,
            Err(e) => {
                // Provider error → fail the job + propagate. Mirrors the
                // chat-failure path below: every provider-error branch in this
                // fn must call fail_job so the attempt counter advances and the
                // pause threshold can fire (without fail_job the tick's
                // recover_stranded step would flip in_progress → pending every
                // tick → perpetual retries that never pause).
                let msg = format!("memory related-query embed failed: {e}");
                log::warn!("{msg} (source {source_type}:{source_id})");
                fail_job(state, source_type, source_id, &msg, now)?;
                return Err(msg);
            }
        };
        if vecs.is_empty() {
            let msg = format!(
                "memory embedder returned no vector for related-query (source {source_type}:{source_id})"
            );
            fail_job(state, source_type, source_id, &msg, now)?;
            return Err(msg);
        }
        vecs[0].clone()
    };

    // 4. Retrieve top-K existing related memories for consolidation context.
    //    Permissive min_score (CONSOLIDATION_MIN_SCORE) — consolidation must
    //    see its K nearest neighbors regardless of relevance, unlike chat
    //    retrieval's relevance floor.
    let related: Vec<memory::MemoryHit> = state.with_conn(|conn| {
        memory::retrieve_top_k_memories(
            conn,
            &query_vec,
            &embed_model_id,
            RELATED_MEMORIES_K,
            CONSOLIDATION_MIN_SCORE,
        )
        .map_err(|e| e.to_string())
    })?;

    // 5. Extraction generation call (memory generation slot).
    let user_content = build_extraction_user_message(&source_text, &related);
    let messages = vec![
        Message {
            role: MessageRole::System,
            content: EXTRACTION_SYSTEM_PROMPT.to_string(),
        },
        Message {
            role: MessageRole::User,
            content: user_content,
        },
    ];
    let opts = ChatOpts {
        max_tokens: Some(400),
        temperature: Some(0.2),
        model: None,
    };
    let raw = {
        let result = with_feature(FEATURE_MEMORY_EXTRACTION, async {
            gen_provider.chat(&messages, opts).await
        })
        .await;
        match result {
            Ok(s) => s,
            Err(e) => {
                let msg = format!("memory extraction chat failed: {e}");
                log::warn!("{msg} (source {source_type}:{source_id})");
                fail_job(state, source_type, source_id, &msg, now)?;
                return Err(msg);
            }
        }
    };

    // 6. Parse — strict, atomic (no partial application).
    let ops = match parse_extraction_ops(&raw) {
        Ok(ops) => ops,
        Err(parse_err) => {
            log::warn!(
                "memory extraction parse failed (source {source_type}:{source_id}): {parse_err}"
            );
            fail_job(state, source_type, source_id, &parse_err, now)?;
            return Err(parse_err);
        }
    };

    // 7. Apply ops. Per-op embed failures are best-effort (logged + continued)
    // — see `apply_ops`. Only a DB-level apply error propagates here.
    if let Err(apply_err) = apply_ops(
        state,
        &embed_provider,
        &embed_model_id,
        source_type,
        source_id,
        &ops,
        now,
    )
    .await
    {
        log::warn!("memory apply-ops failed (source {source_type}:{source_id}): {apply_err}");
        fail_job(state, source_type, source_id, &apply_err, now)?;
        return Err(apply_err);
    }

    // 8. Complete the job.
    state.with_conn(|conn| {
        memory::complete_memory_job(conn, source_type, source_id, now).map_err(|e| e.to_string())
    })?;
    Ok(())
}

/// Thin `#[tauri::command]` wrapper so the frontend (or a debug trigger) can
/// kick off an extraction manually. The T3.4 worker calls the core fn
/// directly with its own `&AppState` / `&ProviderRegistry`.
///
/// **Concurrency guard.** The worker always pre-claims via
/// [`memory::claim_due_memory_jobs`], which atomically flips a `pending`/
/// `error` row to `in_progress` before extraction starts — so two concurrent
/// worker ticks never race on the same source. This command path skips that
/// claim step (it delegates straight to the core fn), so a manual "Extract
/// now" click while the worker is mid-extraction of the same source would
/// race on `memory_items` rows. [`guard_manual_extraction`] refuses the call
/// when the job is already `in_progress`, mirroring the worker's claim guard
/// without adding a second claimer.
#[tauri::command]
pub async fn extract_memories_for_source_command(
    source_type: String,
    source_id: String,
    state: State<'_, AppState>,
    registry: State<'_, ProviderRegistry>,
) -> Result<(), String> {
    guard_manual_extraction(&state, &source_type, &source_id)?;
    let now = chrono::Utc::now().timestamp();
    extract_memories_for_source(&state, &registry, &source_type, &source_id, now).await
}

/// Refuse a manual extraction trigger when the worker is already
/// mid-extraction of the same source (`memory_jobs.status == 'in_progress'`).
/// Returns `Ok(())` when the trigger may proceed (no row yet, or status is
/// anything other than `in_progress`). Extracted as a separate fn so the guard
/// is unit-testable without spinning up the Tauri `State` wrapper.
fn guard_manual_extraction(
    state: &AppState,
    source_type: &str,
    source_id: &str,
) -> Result<(), String> {
    let in_progress = state.with_conn(|conn| {
        Ok(memory::get_memory_job(conn, source_type, source_id)
            .map_err(|e| e.to_string())?
            .map(|j| j.status == "in_progress")
            .unwrap_or(false))
    })?;
    if in_progress {
        return Err(format!(
            "memory extraction already in progress for {source_type}:{source_id}"
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Scan pass (T3.3) — content-hash diff against the memory_jobs watermark
// ---------------------------------------------------------------------------

/// Maximum number of sources of EACH type (`journal_entry`, `daily_chat`) a
/// single scan pass considers. The scan is content-hash-diff-driven (a source
/// whose hash hasn't changed is a no-op), but the candidate walk still loads
/// each source's text to compute the hash — so an unbounded walk would
/// re-read the whole history every tick. 200 keeps a single pass cheap while
/// covering the vast majority of an active user's recent activity; an edit to
/// an older entry promotes it back into the window via the `updated_at DESC`
/// ordering of [`memory::list_recent_memory_candidate_entry_ids`].
const SCAN_WINDOW_LIMIT: i64 = 200;

/// Walk recent `journal_entry` and `daily_chat` sources, content-hash each,
/// and (re)queue the ones whose hash changed into `memory_jobs` as `pending`.
/// Returns the count of sources **newly claimed** by this pass — i.e. sources
/// whose `memory_jobs` row transitioned to `pending` from any other state
/// (or was freshly inserted) as a result of this scan. Specifically NOT
/// counted:
/// - sources whose stored hash matches their current hash (no churn — the
///   watermark upsert is a no-op);
/// - sources that were already `pending` before this pass (already queued,
///   the scan did not change their state);
/// - sources the asymmetric privacy gate rejects, or that have no
///   gatherable text — these are marked `skipped` (see below) and excluded
///   from the count.
///
/// **Scan-driven, NOT edit-driven** (plan decision 5). There is no per-edit
/// dirty-mark hook; the scan walks candidates on each invocation. The T3.4
/// worker will call this on a cadence; [`scan_memories`] exposes it for
/// manual triggering from settings.
///
/// **Gate.** If [`crate::commands::ai_settings::is_user_memory_active`] is
/// false (preference off or either memory slot unconfigured), the pass is a
/// no-op and returns `Ok(0)` with ZERO DB writes.
///
/// **Privacy gate (decision 8).** Reuses [`gather_source_text`] verbatim —
/// invisible entries are excluded unconditionally (via
/// `get_entry_for_provider`'s built-in filter), locked entries unless
/// `ai_memory_include_protected` is ON. Gated / missing / empty sources are
/// watermarked `skipped` via [`memory::upsert_memory_job_skipped`] so the
/// worker does not keep re-queueing them. `daily_chat` sources have no
/// lockable target and are never dropped by the lock half of the gate.
///
/// **Scan timestamps.** Every pass that gets past the gate:
/// - write-once stamps [`crate::ai::provider::settings_keys::MEMORY_FIRST_SCANNED_AT`]
///   so the settings label can tell "nothing has ever scanned" from "a scan
///   has run" (re-stamping would be a settings write every tick for a boolean);
/// - always stamps [`crate::ai::provider::settings_keys::MEMORY_LAST_SCANNED_AT`]
///   so "Last scanned" reflects BOTH the manual button and the worker tick.
/// Both are stamped BEFORE the candidate loops: one persistently failing
/// source must not keep the label claiming nothing ever scanned / never
/// update "Last scanned" while the feature is demonstrably running.
///
/// **Content hash.** Uses [`chunking::content_hash`] — the SAME formula the
/// embedding indexer uses for `entry_embedding_jobs.content_hash` (see
/// `src/ai/chunking.rs:454`). Drift here would silently break the "unchanged
/// → no churn" guarantee.
pub fn run_memory_scan(state: &AppState, registry: &ProviderRegistry) -> Result<usize, String> {
    // 1. GATE — preference ON ∧ both memory slots. Bail before any DB write
    //    so a disabled feature accumulates zero churn.
    let active = state.with_conn(|conn| {
        Ok(crate::commands::ai_settings::is_user_memory_active(
            conn, registry,
        ))
    })?;
    if !active {
        return Ok(0);
    }

    let now = chrono::Utc::now().timestamp();
    state.with_conn(|conn| {
        let mut claimed = 0usize;

        // Write-once marker that SOME scan has run on this device — the
        // settings label's "never scanned" state must not survive a worker
        // tick. Re-stamping would be a settings write every 30s for a value
        // only ever read as a boolean, so leave an existing value alone.
        // Before the loops on purpose: a source that errors on every pass must
        // not keep the label claiming nothing ever scanned.
        let first_scanned_key = crate::ai::provider::settings_keys::MEMORY_FIRST_SCANNED_AT;
        if db::get_setting(conn, first_scanned_key)
            .map_err(|e| e.to_string())?
            .is_none()
        {
            db::set_setting(conn, first_scanned_key, &now.to_string())
                .map_err(|e| e.to_string())?;
        }

        // "Last scanned" label — every successful pass (manual button AND
        // worker tick). Same pre-loop placement as first_scanned.
        db::set_setting(
            conn,
            crate::ai::provider::settings_keys::MEMORY_LAST_SCANNED_AT,
            &now.to_string(),
        )
        .map_err(|e| e.to_string())?;

        // journal_entry candidates.
        let entry_ids = memory::list_recent_memory_candidate_entry_ids(conn, SCAN_WINDOW_LIMIT)
            .map_err(|e| e.to_string())?;
        for entry_id in entry_ids {
            let source_text = gather_source_text(conn, "journal_entry", &entry_id)?;
            claimed += claim_one_source(conn, "journal_entry", &entry_id, source_text, now)?;
        }

        // daily_chat candidates.
        let session_ids =
            memory::list_recent_memory_candidate_chat_session_ids(conn, SCAN_WINDOW_LIMIT)
                .map_err(|e| e.to_string())?;
        for session_id in session_ids {
            let source_text = gather_source_text(conn, "daily_chat", &session_id)?;
            claimed += claim_one_source(conn, "daily_chat", &session_id, source_text, now)?;
        }

        Ok(claimed)
    })
}

/// Thin `#[tauri::command]` wrapper exposing [`run_memory_scan`] for manual
/// triggering (a "Scan memories now" button in Phase 5 settings). Returns the
/// number of sources newly claimed by the pass. The T3.4 worker calls
/// [`run_memory_scan`] directly with its own `&AppState` / `&ProviderRegistry`.
/// The last-scanned stamp lives inside [`run_memory_scan`] so both paths
/// share one write site.
#[tauri::command]
pub fn scan_memories(
    state: State<'_, AppState>,
    registry: State<'_, ProviderRegistry>,
) -> Result<usize, String> {
    run_memory_scan(&state, &registry)
}

/// Persist the last-scan timestamp the settings header shows next to the
/// memories count ([`crate::ai::provider::settings_keys::MEMORY_LAST_SCANNED_AT`]).
/// Used by tests; production stamps go through [`run_memory_scan`].
#[cfg(test)]
fn stamp_memory_last_scanned(state: &AppState, now: i64) -> Result<(), String> {
    state.with_conn(|conn| {
        db::set_setting(
            conn,
            crate::ai::provider::settings_keys::MEMORY_LAST_SCANNED_AT,
            &now.to_string(),
        )
        .map_err(|e| e.to_string())
    })
}

// ---------------------------------------------------------------------------
// Whole-list consolidation ("Scan memories" tidy pass)
// ---------------------------------------------------------------------------

/// Upper bound on how many memory items ride one consolidation chat call.
/// Items are ≤500 chars each ([`crate::ai::memory_extractor::sanitize_memory_text`]),
/// so a full batch stays well inside any real model's context, and 30 items'
/// worth of ops fits comfortably inside [`CONSOLIDATION_MAX_TOKENS`]. Merges
/// only happen WITHIN a batch — the pass is opportunistic, not convergent: a
/// duplicate pair straddling a batch boundary may keep missing each other
/// because `list_memory_items` orders by `updated_at DESC` and every applied
/// op reshuffles that order (known limitation, see docs/LATER.md).
const CONSOLIDATION_BATCH_MAX_ITEMS: usize = 30;

/// Output budget for one consolidation chat call. Sized for the worst case —
/// every item in a full batch appearing in an op with a rewritten ≤500-char
/// text — unlike extraction's 400 (which covers a single source's few ops).
/// A truncated response fails the strict parse and skips that one batch.
const CONSOLIDATION_MAX_TOKENS: u32 = 4000;

/// Minimum gap between two consolidation passes. The tidy pass is
/// destructive (tombstones + rewrites) and a model asked to tidy an
/// already-clean list keeps "improving" it — every extra Scan click melted
/// more memories away. Inside this window the Scan button still scans for
/// NEW sources; only the tidy phase is skipped. The stamp
/// ([`settings_keys::MEMORY_LAST_CONSOLIDATED_AT`]) is written BEFORE the
/// destructive batch loop (a post-ops stamp failure would re-open the
/// melt-down window) and best-effort reset when EVERY batch failed, so a
/// genuine failure stays immediately retryable.
const CONSOLIDATION_COOLDOWN_SECS: i64 = 6 * 3600;

/// Merge duplicates, synthesize related fragments, and drop trivia across the
/// WHOLE memory list in one LLM pass (batched). Triggered by the settings
/// "Scan memories" button alongside [`run_memory_scan`] — extraction dedup is
/// only opportunistic (top-K related at extract time), so independently
/// extracting devices accumulate near-duplicates that only a whole-list pass
/// can fold back together.
///
/// Same gates as extraction: master preference ∧ both memory slots
/// ([`crate::commands::ai_settings::is_user_memory_active`]) and the
/// per-class privacy receipt for BOTH slots — all no-op `Ok(0)` when unmet
/// (a consent gap is not an error). Only ENABLED items participate (a
/// user-disabled memory must not leak its text into a merged fact), and the
/// retrieval-grade locked/invisible re-check
/// ([`memory::retain_privacy_safe_memory_ids`]) filters candidates before
/// any text reaches the generation provider.
///
/// Returns the number of ops applied. A provider/parse failure skips that ONE
/// batch (the strict parse is atomic per batch, mirroring extraction's
/// no-partial-application rule) and the pass continues; `Err` is returned
/// only when every batch failed, so a partial run still reports its applied
/// count. DB failures always propagate.
pub async fn consolidate_memories(
    state: &AppState,
    registry: &ProviderRegistry,
    now: i64,
) -> Result<usize, String> {
    let active = state.with_conn(|conn| {
        Ok(crate::commands::ai_settings::is_user_memory_active(
            conn, registry,
        ))
    })?;
    if !active {
        return Ok(0);
    }
    let (Some(gen_provider), Some(embed_provider)) =
        (registry.memory_generation(), registry.memory_embedder())
    else {
        // Benign TOCTOU with the gate above — same contract as extraction.
        return Ok(0);
    };
    let embed_model_id = provider_namespaced_model_id(embed_provider.as_ref());

    if !memory_class_privacy_accepted(state, gen_provider.endpoint_class())?
        || !memory_class_privacy_accepted(state, embed_provider.endpoint_class())?
    {
        return Ok(0);
    }

    // COOLDOWN — see [`CONSOLIDATION_COOLDOWN_SECS`]: repeated runs on an
    // already-tidied list keep shrinking it, so inside the window the pass
    // is a silent no-op (the caller's scan phase still claims new sources).
    // A DB error on the read propagates (this fn's contract: DB failures are
    // never guessed around); a garbage or non-positive stamp is treated as
    // absent, while a FUTURE stamp (clock skew) still engages the cooldown —
    // both directions fail toward NOT running the destructive pass.
    let last_consolidated: Option<i64> = state
        .with_conn(|conn| {
            db::get_setting(
                conn,
                crate::ai::provider::settings_keys::MEMORY_LAST_CONSOLIDATED_AT,
            )
            .map_err(|e| e.to_string())
        })?
        .and_then(|v| v.parse::<i64>().ok())
        .filter(|last| *last > 0);
    if let Some(last) = last_consolidated {
        if now.saturating_sub(last) < CONSOLIDATION_COOLDOWN_SECS {
            log::info!(
                "memory consolidation skipped: last pass ran {}s ago (cooldown {}s)",
                now.saturating_sub(last),
                CONSOLIDATION_COOLDOWN_SECS
            );
            return Ok(0);
        }
    }

    // Candidates: enabled items whose contributing entries are all still
    // visible (fail-closed privacy filter, same one persona building uses).
    let items =
        state.with_conn(|conn| memory::list_memory_items(conn).map_err(|e| e.to_string()))?;
    let enabled: Vec<_> = items.into_iter().filter(|i| i.enabled).collect();
    let ids: Vec<String> = enabled.iter().map(|i| i.id.clone()).collect();
    let safe: std::collections::HashSet<String> = state
        .with_conn(|conn| Ok(memory::retain_privacy_safe_memory_ids(conn, &ids)))?
        .into_iter()
        .collect();
    let candidates: Vec<_> = enabled
        .into_iter()
        .filter(|i| safe.contains(&i.id))
        .collect();
    if candidates.len() < 2 {
        // Deliberately NOT stamped: nothing destructive ran, and a 0-1 item
        // list should tidy immediately once it grows past one item.
        return Ok(0);
    }

    // Stamp the cooldown BEFORE any destructive op, not after: if the stamp
    // write failed after ops were applied, the very next Scan click would
    // bypass the cooldown and re-tidy the just-cleaned list — the exact
    // melt-down this constant exists to prevent. The all-batches-failed path
    // below best-effort resets the stamp so a genuine failure stays
    // immediately retryable; if even that reset fails, the cooldown stays
    // engaged — the safe direction (skips tidying, loses nothing).
    stamp_memory_last_consolidated(state, now)?;

    // Per-batch provider/parse failures are skipped (logged + collected) so
    // one op-heavy or flaky batch cannot silently abandon the rest of the
    // list; the pass only fails outright when EVERY batch failed. DB errors
    // inside the apply step still propagate hard — those mean local state is
    // in doubt, not that the model misbehaved.
    let mut applied = 0usize;
    let mut batch_errors: Vec<String> = Vec::new();
    for batch in candidates.chunks(CONSOLIDATION_BATCH_MAX_ITEMS) {
        if batch.len() < 2 {
            continue;
        }
        let valid_ids: std::collections::HashSet<&str> =
            batch.iter().map(|i| i.id.as_str()).collect();
        let mut listing = String::with_capacity(batch.len() * 64);
        for item in batch {
            listing.push_str(&item.id);
            listing.push_str(" :: ");
            listing.push_str(&item.text);
            listing.push('\n');
        }
        let messages = vec![
            Message {
                role: MessageRole::System,
                content: CONSOLIDATION_SYSTEM_PROMPT.to_string(),
            },
            Message {
                role: MessageRole::User,
                content: listing,
            },
        ];
        let opts = ChatOpts {
            max_tokens: Some(CONSOLIDATION_MAX_TOKENS),
            temperature: Some(0.2),
            model: None,
        };
        let raw = match with_feature(FEATURE_MEMORY_CONSOLIDATION, async {
            gen_provider.chat(&messages, opts).await
        })
        .await
        {
            Ok(raw) => raw,
            Err(e) => {
                let msg = format!("memory consolidation chat failed: {e}");
                log::warn!("{msg}; skipping batch");
                batch_errors.push(msg);
                continue;
            }
        };
        let ops = match parse_consolidation_ops(&raw) {
            Ok(ops) => ops,
            Err(e) => {
                let msg = format!("memory consolidation parse failed: {e}");
                log::warn!("{msg}; skipping batch");
                batch_errors.push(msg);
                continue;
            }
        };
        applied += apply_consolidation_ops(
            state,
            &embed_provider,
            &embed_model_id,
            &valid_ids,
            &ops,
            now,
        )
        .await?;
    }
    if applied == 0 && !batch_errors.is_empty() {
        // Every batch failed: best-effort reset of the upfront stamp so the
        // retry isn't parked for a full cooldown. `0` parses to a
        // non-positive stamp, which the read above treats as absent. A
        // failed reset only leaves the cooldown engaged — the safe outcome.
        if let Err(e) = stamp_memory_last_consolidated(state, 0) {
            log::warn!("memory consolidation could not reset cooldown after failure: {e}");
        }
        return Err(batch_errors.join("; "));
    }
    if !batch_errors.is_empty() {
        log::warn!(
            "memory consolidation finished partially: {} batch(es) failed, {applied} op(s) applied",
            batch_errors.len()
        );
    }
    Ok(applied)
}

/// Persist the consolidation-cooldown stamp
/// ([`crate::ai::provider::settings_keys::MEMORY_LAST_CONSOLIDATED_AT`]).
/// Written BEFORE the destructive batch loop; `now = 0` resets it (read side
/// treats non-positive as absent).
fn stamp_memory_last_consolidated(state: &AppState, now: i64) -> Result<(), String> {
    state.with_conn(|conn| {
        db::set_setting(
            conn,
            crate::ai::provider::settings_keys::MEMORY_LAST_CONSOLIDATED_AT,
            &now.to_string(),
        )
        .map_err(|e| e.to_string())
    })
}

/// Apply one batch's tidy ops. Any op naming an id OUTSIDE the batch's input
/// set is skipped with a warn (hallucinated ids, and — load-bearing — ids the
/// privacy filter excluded from the prompt: the model never saw them, so an
/// op touching them is by definition fabricated). Skips mirror `apply_ops`'
/// missing-item semantics: logged, never a batch failure.
///
/// Merge ordering is the privacy invariant: the absorbed items' source links
/// are unioned onto `keep` BEFORE they are tombstoned, so the retrieval-time
/// locked/invisible re-check keeps seeing every entry that fed the merged
/// fact.
async fn apply_consolidation_ops(
    state: &AppState,
    embed_provider: &Arc<dyn crate::ai::provider::AIProvider>,
    embed_model_id: &str,
    valid_ids: &std::collections::HashSet<&str>,
    ops: &[ConsolidationOp],
    now: i64,
) -> Result<usize, String> {
    let mut applied = 0usize;
    for op in ops {
        match op {
            ConsolidationOp::Merge { keep, absorb, text } => {
                if !valid_ids.contains(keep.as_str()) {
                    log::warn!("memory consolidation merge skipped: keep id {keep} not in batch");
                    continue;
                }
                let absorb_valid: Vec<String> = absorb
                    .iter()
                    .filter(|a| {
                        let ok = valid_ids.contains(a.as_str());
                        if !ok {
                            log::warn!(
                                "memory consolidation merge: absorb id {a} not in batch, skipped"
                            );
                        }
                        ok
                    })
                    .cloned()
                    .collect();
                if absorb_valid.is_empty() {
                    log::warn!(
                        "memory consolidation merge skipped: no valid absorb id for keep {keep}"
                    );
                    continue;
                }
                // Single transaction: source union + tombstones + text update
                // commit together or not at all — a mid-merge failure must
                // never tombstone an absorbed fact without the merged text
                // that preserves it (liveness of keep/absorb is re-checked
                // inside, atomically with the writes).
                let merged = state.with_conn(|conn| {
                    memory::merge_memory_items(conn, keep, &absorb_valid, text, now)
                        .map_err(|e| e.to_string())
                })?;
                if !merged {
                    log::warn!(
                        "memory consolidation merge skipped: keep {keep} or every absorb id \
                         no longer live"
                    );
                    continue;
                }
                // Best-effort inline re-embed — backfill recovers a failure,
                // same rationale as `apply_ops`.
                if let Err(e) = embed_memory_item(
                    state,
                    FEATURE_MEMORY_CONSOLIDATION,
                    embed_provider,
                    embed_model_id,
                    keep,
                    text,
                    now,
                )
                .await
                {
                    log::warn!(
                        "memory consolidation inline embed failed for merged item {keep}: {e}; \
                         backfill will recover"
                    );
                }
                applied += 1;
            }
            ConsolidationOp::Rewrite { id, text } => {
                if !valid_ids.contains(id.as_str()) || !memory_item_exists(state, id)? {
                    log::warn!("memory consolidation rewrite skipped: id {id} not in batch");
                    continue;
                }
                state.with_conn(|conn| {
                    memory::update_memory_item_text(conn, id, text, now).map_err(|e| e.to_string())
                })?;
                if let Err(e) = embed_memory_item(
                    state,
                    FEATURE_MEMORY_CONSOLIDATION,
                    embed_provider,
                    embed_model_id,
                    id,
                    text,
                    now,
                )
                .await
                {
                    log::warn!(
                        "memory consolidation inline embed failed for rewritten item {id}: {e}; \
                         backfill will recover"
                    );
                }
                applied += 1;
            }
            ConsolidationOp::Drop { id } => {
                if !valid_ids.contains(id.as_str()) || !memory_item_exists(state, id)? {
                    log::warn!("memory consolidation drop skipped: id {id} not in batch");
                    continue;
                }
                state.with_conn(|conn| {
                    memory::tombstone_memory_item(conn, id, now).map_err(|e| e.to_string())
                })?;
                applied += 1;
            }
        }
    }
    Ok(applied)
}

/// Single-flight latch for [`consolidate_memories_command`]. The pass makes
/// destructive (tombstoning) writes from a snapshot of the list read at its
/// start, so two overlapping runs can merge in opposite directions from the
/// same pre-race state — the UI disables the Scan button while in flight,
/// and this latch is the backend guarantee behind it.
static CONSOLIDATION_IN_FLIGHT: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// RAII release for [`CONSOLIDATION_IN_FLIGHT`]: the flag must be reset even
/// when the pass panics or the future is dropped mid-await — a plain
/// store-after-await would wedge the latch shut for the rest of the process
/// and every later Scan's tidy phase would fail as "already running".
struct ConsolidationFlightGuard;

impl Drop for ConsolidationFlightGuard {
    fn drop(&mut self) {
        CONSOLIDATION_IN_FLIGHT.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

/// Thin `#[tauri::command]` wrapper exposing [`consolidate_memories`] — the
/// tidy phase the settings "Scan memories" button runs right after
/// [`scan_memories`]. Returns the number of ops applied. A second invocation
/// while one is already running fails fast instead of racing it.
#[tauri::command]
pub async fn consolidate_memories_command(
    state: State<'_, AppState>,
    registry: State<'_, ProviderRegistry>,
) -> Result<usize, String> {
    if CONSOLIDATION_IN_FLIGHT.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return Err("MEMORY_CONSOLIDATION_ALREADY_RUNNING".to_string());
    }
    let _guard = ConsolidationFlightGuard;
    consolidate_memories(&state, &registry, chrono::Utc::now().timestamp()).await
}

// ---------------------------------------------------------------------------
// Persona synthesis (Phase 7 T7.3)
// ---------------------------------------------------------------------------

/// Result returned to the Persona card after a manual rebuild. `style_ready`
/// is false when there are fewer than three privacy-eligible entries, letting
/// the UI explain that it needs more material instead of inventing a style.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonaBuildResult {
    pub style_ready: bool,
}

/// Build the singleton persona from user-authored answers, distilled memory
/// items, and a bounded privacy-eligible sample of journal entries.
///
/// The memory pair gates this BEFORE any source read or provider call. All
/// parsed/sanitized output remains in memory until every required guard has
/// passed, so a copying model can never partially overwrite the document.
pub async fn build_persona_inner(
    state: &AppState,
    registry: &ProviderRegistry,
    force: bool,
    now: i64,
) -> Result<PersonaBuildResult, String> {
    // Persona is its own feature, NOT a sub-feature of User Memory: the master
    // memory preference must not block an explicit rebuild. Only the two memory
    // model slots are required, because the build itself runs on the memory
    // generation provider (and samples the memory embedder's material).
    // `run_memory_tick`'s AUTO-rebuild is separately gated by the tick's own
    // `is_user_memory_active` check, so turning memory off still stops
    // background persona churn.
    if !registry.is_memory_enabled() {
        return Ok(PersonaBuildResult { style_ready: false });
    }
    let gen_provider = registry
        .memory_generation()
        .ok_or_else(|| "memory generation provider is unavailable".to_string())?;
    // PRIVACY — see `memory_class_privacy_accepted` doc comment. Persona
    // traits + style both run on the memory generation slot only.
    if !memory_class_privacy_accepted(state, gen_provider.endpoint_class())? {
        return Ok(PersonaBuildResult { style_ready: false });
    }

    let (current, memories, samples) = state.with_conn(|conn| {
        let current = persona::read_persona(conn).map_err(|e| e.to_string())?;
        if current.user_edited && !force {
            return Err("persona has user edits; explicit force is required to rebuild".into());
        }
        // `list_memory_items` has NO retrieval-time privacy re-check (unlike
        // `retrieve_top_k_memories`), so a fact distilled from an entry that
        // has since been locked, made invisible, or deleted would otherwise
        // ride the persona prompt to a possibly-hosted provider. Filter
        // through the shared fail-closed probe first.
        let items = memory::list_memory_items(conn)
            .map_err(|e| e.to_string())?
            .into_iter()
            .filter(|item| item.enabled)
            .collect::<Vec<_>>();
        let safe_ids: std::collections::HashSet<String> = memory::retain_privacy_safe_memory_ids(
            conn,
            &items.iter().map(|i| i.id.clone()).collect::<Vec<_>>(),
        )
        .into_iter()
        .collect();
        let memories = items
            .into_iter()
            .filter(|item| safe_ids.contains(&item.id))
            .map(|item| item.text)
            .collect::<Vec<_>>();
        let samples = collect_persona_entry_samples(conn)?;
        Ok((current, memories, samples))
    })?;

    let answers = render_persona_answers(&current.answers_json);
    // No authoritative material → do not invent a persona on a small model.
    // Style can still be produced from eligible entries alone; traits stay
    // empty so the card can show "not enough material" rather than fiction.
    let has_traits_input = !answers.trim().is_empty() || !memories.is_empty();
    let style_ready = samples.len() >= PERSONA_STYLE_MIN_ENTRIES;
    if !has_traits_input && !style_ready {
        return Ok(PersonaBuildResult { style_ready: false });
    }

    let traits = if has_traits_input {
        let traits_messages = persona_messages(build_traits_prompt(&answers, &memories));
        let traits_raw = with_feature(FEATURE_PERSONA_BUILD, async {
            gen_provider
                .chat(&traits_messages, persona_chat_opts())
                .await
        })
        .await
        .map_err(|e| format!("persona traits synthesis failed: {e}"))?;
        let (traits, _) = parse_persona_sections(&traits_raw)
            .map_err(|e| format!("persona traits response was invalid: {e}"))?;
        let traits = sanitize_persona_text(&traits);
        if traits.is_empty() {
            return Err("persona traits response was empty after sanitization".into());
        }
        traits
    } else {
        // Nothing authoritative to re-synthesize — keep the previous traits
        // column rather than inventing or wiping it for a style-only rebuild.
        current.traits_text.clone()
    };

    let style = if style_ready {
        let style_messages = persona_messages(build_style_prompt(&samples));
        let style_raw = with_feature(FEATURE_PERSONA_BUILD, async {
            gen_provider
                .chat(&style_messages, persona_chat_opts())
                .await
        })
        .await
        .map_err(|e| format!("persona style synthesis failed: {e}"))?;
        let (_, style) = parse_persona_sections(&style_raw)
            .map_err(|e| format!("persona style response was invalid: {e}"))?;
        let total_lines = persona_nonempty_line_count(&style);
        let (style, dropped) = strip_verbatim_echoes(&style, &samples);
        if exceeds_verbatim_echo_drop_threshold(dropped, total_lines) {
            return Err("persona style response copied too much source text".into());
        }
        sanitize_persona_text(&style)
    } else {
        String::new()
    };

    // Only persist when at least one generated section has content. Empty
    // traits+style would clear a previous document for no reason.
    if traits.is_empty() && style.is_empty() {
        return Ok(PersonaBuildResult { style_ready: false });
    }

    let written = state.with_conn(|conn| {
        persona::write_persona_generated_if_current(conn, &traits, &style, now, current.updated_at)
            .map_err(|e| e.to_string())
    })?;
    if !written {
        return Err(
            "persona changed while rebuilding; no changes were saved. Rebuild again.".into(),
        );
    }
    Ok(PersonaBuildResult { style_ready })
}

/// Manual rebuild entry point. `force` is only true after the UI confirmation
/// dialog acknowledges that custom trait/style edits will be replaced.
#[tauri::command]
pub async fn build_persona(
    force: bool,
    state: State<'_, AppState>,
    registry: State<'_, ProviderRegistry>,
) -> Result<PersonaBuildResult, String> {
    build_persona_inner(&state, &registry, force, chrono::Utc::now().timestamp()).await
}

/// Read the singleton persona document for the Settings card. This is purely
/// local state, so it remains available without either memory provider slot.
#[tauri::command]
pub fn get_persona(state: State<'_, AppState>) -> Result<persona::PersonaRow, String> {
    state.with_conn(|conn| persona::read_persona(conn).map_err(|e| e.to_string()))
}

/// Persist the fixed-question interview answers. The command deliberately has
/// no memory-provider gate: answers are user-authored local data and are also
/// useful before a model is configured. Each saved value is bounded again at
/// this trust boundary even though the UI enforces the same limit.
#[tauri::command]
pub fn write_persona_answers(
    answers_json: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    save_persona_answers(&state, &answers_json)
}

fn save_persona_answers(state: &AppState, answers_json: &str) -> Result<(), String> {
    let answers_json = validate_and_sanitize_persona_answers(answers_json)?;
    state.with_conn(|conn| {
        persona::write_persona_answers(conn, &answers_json).map_err(|e| e.to_string())
    })
}

/// Save direct edits to the generated sections. This is an explicit user
/// action, so it marks the row `user_edited` and is never provider-gated.
#[tauri::command]
pub fn write_persona_user_edit(
    traits_text: String,
    style_text: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.with_conn(|conn| {
        persona::write_persona_user_edit(conn, &traits_text, &style_text).map_err(|e| e.to_string())
    })
}

/// Enable or disable injection of the persona block without touching its
/// answers or generated text.
#[tauri::command]
pub fn set_persona_enabled(enabled: bool, state: State<'_, AppState>) -> Result<(), String> {
    state.with_conn(|conn| persona::set_persona_enabled(conn, enabled).map_err(|e| e.to_string()))
}

fn persona_messages(prompt: String) -> Vec<Message> {
    vec![Message {
        role: MessageRole::User,
        content: prompt,
    }]
}

fn persona_chat_opts() -> ChatOpts {
    ChatOpts {
        max_tokens: Some(500),
        temperature: Some(0.2),
        model: None,
    }
}

/// Select a compact raw-entry sample. Candidate ids are already newest-first;
/// within that recent window, longer entries win ties for more style signal.
/// Every source still passes `get_entry_for_provider` and the protected-entry
/// gate, so invisible content never enters a prompt.
fn collect_persona_entry_samples(conn: &Connection) -> Result<Vec<String>, String> {
    // I1 fix: persona synthesis runs on-machine, but its OUTPUT is injected
    // into the general `gen` prompt, which CAN be hosted — so this must gate
    // on the memory-specific opt-in, not the unrelated entry-embedding
    // backfill toggle (flipping that would otherwise silently start sending
    // locked-journal-flavored style text off-machine).
    //
    // The opt-in is ALSO scoped to the User Memory master preference: Settings
    // presents it as a sub-setting of that group, and turning the master off
    // does not reset it. Since a persona rebuild no longer requires the master
    // preference, reading the raw flag would let a stale opt-in keep feeding
    // locked-entry text into style samples after the user believed they had
    // switched the whole thing off. A scope-limited opt-in must not outlive
    // the toggle it was scoped under.
    let include_protected = read_memory_include_protected(conn)
        && crate::commands::ai_settings::read_feature_toggle_on(
            conn,
            crate::ai::provider::settings_keys::USER_MEMORY_ENABLED,
        )
        .map_err(|e| e.to_string())?;
    let candidate_ids = memory::list_recent_memory_candidate_entry_ids(conn, SCAN_WINDOW_LIMIT)
        .map_err(|e| e.to_string())?;
    let mut candidates = Vec::new();
    for (recency, id) in candidate_ids.into_iter().enumerate() {
        let Some(entry) =
            db::queries::get_entry_for_provider(conn, &id).map_err(|e| e.to_string())?
        else {
            continue;
        };
        if entry.is_locked && !include_protected {
            continue;
        }
        let text = crate::ai::indexer::build_indexable_text(
            entry.title.as_deref(),
            entry.content_text.as_deref(),
        );
        if !text.trim().is_empty() {
            candidates.push((recency, text));
        }
    }
    candidates.sort_by(|(left_recency, left), (right_recency, right)| {
        let left_score = left.len().saturating_sub(left_recency.saturating_mul(8));
        let right_score = right.len().saturating_sub(right_recency.saturating_mul(8));
        right_score.cmp(&left_score)
    });

    let mut total = 0usize;
    Ok(candidates
        .into_iter()
        .take(PERSONA_SAMPLE_ENTRY_LIMIT)
        .filter_map(|(_, text)| {
            let sample = truncate_persona_sample(&text, PERSONA_SAMPLE_ENTRY_MAX_CHARS);
            let remaining = PERSONA_SAMPLE_TOTAL_MAX_CHARS.saturating_sub(total);
            if remaining == 0 {
                return None;
            }
            let sample = truncate_persona_sample(&sample, remaining);
            if sample.is_empty() {
                return None;
            }
            total += sample.len();
            Some(sample)
        })
        .collect())
}

fn truncate_persona_sample(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let end = text
        .char_indices()
        .nth(max_chars)
        .map_or(text.len(), |(index, _)| index);
    text[..end].trim_end().to_string()
}

async fn maybe_auto_refresh_persona(
    state: &AppState,
    registry: &ProviderRegistry,
    now: i64,
) -> Result<(), String> {
    let due = state.with_conn(|conn| {
        let persona = persona::read_persona(conn).map_err(|e| e.to_string())?;
        let newest_memory = memory::list_all_memory_items_for_sync(conn)
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|item| item.updated_at)
            .max();
        let generated_at = persona.generated_at.unwrap_or(0);
        Ok(persona.enabled
            && !persona.user_edited
            && newest_memory.is_some_and(|updated_at| updated_at > generated_at)
            && now.saturating_sub(generated_at) >= PERSONA_REFRESH_COOLDOWN_SECS)
    })?;
    if due {
        build_persona_inner(state, registry, false, now).await?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Memory item management commands (Phase 5 T5.1)
// ---------------------------------------------------------------------------

/// List every live (non-deleted) memory item, newest (`updated_at`) first.
/// Thin wrapper over [`memory::list_memory_items`] — the shape the Phase 5
/// Settings memory list renders. `MemoryItemRow` serializes to camelCase; the
/// `isDeleted` field is always `false` here (the DB query filters it).
#[tauri::command]
pub fn list_memory_items(state: State<'_, AppState>) -> Result<Vec<memory::MemoryItemRow>, String> {
    state.with_conn(|conn| memory::list_memory_items(conn).map_err(|e| e.to_string()))
}

/// Edit one memory item's text. Re-sanitizes via [`sanitize_memory_text`]
/// (the same normalization the extractor applies to every extracted fact) so
/// a user edit can't sneak whitespace / control-char padding past the stored
/// row. Timestamp is `chrono::Utc::now()` — the DB layer bumps `updated_at`
/// AND wipes stale embeddings atomically inside one transaction
/// (see [`memory::update_memory_item_text`]).
#[tauri::command]
pub fn update_memory_item_text(
    memory_id: String,
    text: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let sanitized = sanitize_memory_text(&text);
    let now = chrono::Utc::now().timestamp();
    state.with_conn(|conn| {
        memory::update_memory_item_text(conn, &memory_id, &sanitized, now)
            .map_err(|e| e.to_string())
    })
}

/// Enable or disable a memory item. A disabled item is hidden from retrieval
/// without being deleted — the user's off switch for a fact they no longer
/// want injected into chat. Thin wrapper over [`memory::set_memory_enabled`].
#[tauri::command]
pub fn set_memory_enabled(
    memory_id: String,
    enabled: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let now = chrono::Utc::now().timestamp();
    state.with_conn(|conn| {
        memory::set_memory_enabled(conn, &memory_id, enabled, now).map_err(|e| e.to_string())
    })
}

/// Soft-delete (tombstone) a memory item. The row is NOT physically removed —
/// the tombstone propagates via sync (last-writer-wins on `updated_at`) so a
/// delete reaches every device. Thin wrapper over
/// [`memory::tombstone_memory_item`].
#[tauri::command]
pub fn delete_memory_item(memory_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let now = chrono::Utc::now().timestamp();
    state.with_conn(|conn| {
        memory::tombstone_memory_item(conn, &memory_id, now).map_err(|e| e.to_string())
    })
}

// I11 fix: this module used to expose dedicated `get_memory_include_protected`
// / `set_memory_include_protected` #[tauri::command]s. That duplicates the
// house convention for settings toggles — the generic `get_setting`/
// `set_setting` commands (`lib.rs`), which is exactly how
// `useEmbedIncludeProtected.ts` reads/writes `ai_embed_include_protected`
// already. Removed both commands (and their `_impl` fns + `lib.rs`
// registrations); the frontend reads/writes
// `settings_keys::MEMORY_INCLUDE_PROTECTED` through the generic settings
// commands instead. [`read_memory_include_protected`] below remains the
// canonical backend read path and is still covered by
// `memory_include_protected_defaults_false_and_round_trips`.

// ---------------------------------------------------------------------------
// Private helpers (scan)
// ---------------------------------------------------------------------------

/// Watermark one candidate source based on its gathered text:
/// - `Some(text)` → content-hash diff via
///   [`memory::upsert_memory_job_watermark`]. Returns `1` if the row
///   transitioned INTO `pending` (newly claimed by this pass), `0` otherwise
///   (hash unchanged → no-op, or row was already `pending` before).
/// - `None` → source is gated / missing / empty. Mark it `skipped` (NEVER
///   `pending`) via [`memory::upsert_memory_job_skipped`] and return `0`.
///
/// "Newly claimed" = the row's status AFTER the upsert is `pending` AND its
/// status BEFORE the upsert was anything else (including absent). A row that
/// was already `pending` is NOT re-counted even if its hash changed — it was
/// already queued for the worker.
fn claim_one_source(
    conn: &Connection,
    source_type: &str,
    source_id: &str,
    source_text: Option<String>,
    now: i64,
) -> Result<usize, String> {
    let Some(text) = source_text else {
        // Gated (invisible / locked-without-opt-in) or missing / empty.
        memory::upsert_memory_job_skipped(conn, source_type, source_id, now)
            .map_err(|e| e.to_string())?;
        return Ok(0);
    };

    // `text` for `daily_chat` already excludes assistant messages — see
    // `gather_source_text`'s doc for why that filter's content_hash
    // side effect is intentional.
    let hash = chunking::content_hash(&text);
    // Snapshot before-status so we only count transitions INTO pending.
    let before_status = memory::get_memory_job(conn, source_type, source_id)
        .map_err(|e| e.to_string())?
        .map(|j| j.status);
    memory::upsert_memory_job_watermark(conn, source_type, source_id, &hash, 0, now)
        .map_err(|e| e.to_string())?;
    let after_status = memory::get_memory_job(conn, source_type, source_id)
        .map_err(|e| e.to_string())?
        .map(|j| j.status);

    if after_status.as_deref() == Some("pending") && before_status.as_deref() != Some("pending") {
        Ok(1)
    } else {
        Ok(0)
    }
}

// ---------------------------------------------------------------------------
// Private helpers (extraction)
// ---------------------------------------------------------------------------

/// Read `ai_memory_include_protected` — `true` when locked entries are
/// eligible for AI User Memory extraction (and, per the I1 fix, for Phase 7
/// persona style sampling too). Default OFF, fail-closed. See
/// [`crate::ai::provider::settings_keys::MEMORY_INCLUDE_PROTECTED`] for the
/// canonical explanation of why this is a key dedicated from
/// `ai_embed_include_protected` — do not re-derive that rationale here.
///
/// Read at every call site that gates a feature on this: [`run_memory_scan`]
/// → [`claim_one_source`] and [`extract_memories_for_source`] (both via
/// [`gather_source_text`], so there is only one place extraction's gate can
/// drift), plus [`collect_persona_entry_samples`] directly.
fn read_memory_include_protected(conn: &Connection) -> bool {
    crate::commands::ai_settings::read_bool_setting(
        conn,
        crate::ai::provider::settings_keys::MEMORY_INCLUDE_PROTECTED,
    )
}

/// Load and concatenate a source's text for extraction. Returns:
/// - `Ok(Some(text))` when the source has text worth extracting.
/// - `Ok(None)` when the source should be SKIPPED (missing, invisible,
///   locked-without-opt-in, deleted, or empty). The caller marks the job
///   `skipped` and returns with no provider call.
/// - `Err` on a DB error or an unknown `source_type`.
///
/// **Privacy gate (decision 8):** for `journal_entry`, invisible entries are
/// excluded unconditionally (via `get_entry_for_provider`'s built-in filter)
/// and locked entries are excluded unless `ai_memory_include_protected` is
/// ON — a memory-extraction-specific opt-in, separate from
/// `ai_embed_include_protected` (see [`read_memory_include_protected`]).
/// `daily_chat` sessions have no lockable target and are never dropped by
/// this gate (per the retrieval-time re-check docs in
/// `db::memory::retrieve_top_k_memories`).
///
/// **`daily_chat` is the user's own words only.** Only `role == "user"`
/// messages are gathered — an assistant reply is the MODEL'S OWN generated
/// text, not something the user said, so including it would let the
/// extractor "remember" facts the assistant invented (or merely
/// paraphrased) rather than facts the user actually stated. Messages are
/// joined bare (no `"role: "` prefix) since every surviving line is now
/// known to be the user's.
///
/// 💡 Review pass 2 note: this filter changes what text feeds
/// [`chunking::content_hash`] at the `claim_one_source` watermark (this
/// module) — the hash is over user-only text, not the raw transcript.
/// Introducing/changing this filter therefore changes the content hash of
/// every EXISTING `daily_chat` session, so the next scan sees every
/// already-`indexed` session as "content changed" and re-extracts it once.
/// Intentional and self-limiting (a one-time re-extraction, not a
/// per-scan loop — the new hash matches on the following scan).
fn gather_source_text(
    conn: &Connection,
    source_type: &str,
    source_id: &str,
) -> Result<Option<String>, String> {
    match source_type {
        "daily_chat" => {
            let session = db::load_chat_session(conn, source_id).map_err(|e| e.to_string())?;
            let Some(session) = session else {
                return Ok(None); // deleted / missing → skip
            };
            let mut parts: Vec<String> = Vec::new();
            for m in &session.messages {
                if m.role == "user" && !m.content.trim().is_empty() {
                    parts.push(m.content.clone());
                }
            }
            if parts.is_empty() {
                return Ok(None);
            }
            Ok(Some(parts.join("\n")))
        }
        "journal_entry" => {
            // get_entry_for_provider already excludes invisible + deleted
            // entries (returns None). The lock gate is applied separately
            // here, matching the indexer's C2 pre-embed guard.
            let entry =
                db::queries::get_entry_for_provider(conn, source_id).map_err(|e| e.to_string())?;
            let Some(entry) = entry else {
                return Ok(None); // invisible / deleted / missing → skip
            };
            if entry.is_locked && !read_memory_include_protected(conn) {
                return Ok(None); // locked without opt-in → skip
            }
            let text = crate::ai::indexer::build_indexable_text(
                entry.title.as_deref(),
                entry.content_text.as_deref(),
            );
            if text.trim().is_empty() {
                return Ok(None);
            }
            Ok(Some(text))
        }
        other => Err(format!("unknown memory source_type: {other}")),
    }
}

/// Format the extraction model's user message: source text first, then the
/// existing related memories (one `id | text` line each) when any. Matches the
/// two-section layout the `EXTRACTION_SYSTEM_PROMPT` expects.
fn build_extraction_user_message(source_text: &str, related: &[memory::MemoryHit]) -> String {
    let mut s = format!("Source text:\n{source_text}");
    if !related.is_empty() {
        s.push_str("\n\nEXISTING related memories (id | text):");
        for hit in related {
            s.push_str(&format!("\n- {} | {}", hit.memory_id, hit.text));
        }
    }
    s
}

/// Apply a parsed batch of [`memory_extractor::MemoryOp`]s. Add/Update each
/// trigger an inline item embed (attributed to `memory_extraction`); Delete
/// just tombstones. An op whose referenced `id` does not exist (or has been
/// tombstoned) is skipped (logged) — NOT a job failure, per the plan.
///
/// **Per-op embed failures are best-effort** (logged + continued to the next
/// op): the item row is already committed by the time the inline embed runs,
/// and the scan's content-hash watermark is a no-op on re-extraction, so
/// failing the whole job here would leave the committed row duplicable — the
/// next claim re-runs the same Add, inserting a SECOND item with a fresh
/// `uuid::Uuid::new_v4()`. The un-embedded item is recovered by the T3.4
/// backfill pass ([`backfill_missing_embeddings`]) on this same tick. Only a
/// DB-level error (item/source write itself fails) propagates as `Err`.
async fn apply_ops(
    state: &AppState,
    embed_provider: &Arc<dyn crate::ai::provider::AIProvider>,
    embed_model_id: &str,
    source_type: &str,
    source_id: &str,
    ops: &[crate::ai::memory_extractor::MemoryOp],
    now: i64,
) -> Result<(), String> {
    for op in ops {
        match op {
            crate::ai::memory_extractor::MemoryOp::Add { text } => {
                let new_id = uuid::Uuid::new_v4().to_string();
                // Insert item + contributing source link.
                state.with_conn(|conn| {
                    memory::insert_memory_item(conn, &new_id, text, source_type, now)
                        .map_err(|e| e.to_string())?;
                    memory::add_memory_source(conn, &new_id, source_type, source_id)
                        .map_err(|e| e.to_string())?;
                    Ok(())
                })?;
                // Inline embed (memory_extraction attribution) — best-effort.
                // See the fn docstring: a failure here is recovered by the
                // backfill pass, NOT propagated (propagating would leave the
                // already-committed Add duplicable on retry).
                if let Err(e) = embed_memory_item(
                    state,
                    FEATURE_MEMORY_EXTRACTION,
                    embed_provider,
                    embed_model_id,
                    &new_id,
                    text,
                    now,
                )
                .await
                {
                    log::warn!(
                        "memory inline embed failed for new item {new_id} \
                         (source {source_type}:{source_id}): {e}; backfill will recover"
                    );
                }
            }
            crate::ai::memory_extractor::MemoryOp::Update { id, text } => {
                if !memory_item_exists(state, id)? {
                    log::warn!(
                        "memory update-op skipped: item {id} not found (source {source_type}:{source_id})"
                    );
                    continue;
                }
                state.with_conn(|conn| {
                    memory::update_memory_item_text(conn, id, text, now)
                        .map_err(|e| e.to_string())?;
                    memory::add_memory_source(conn, id, source_type, source_id)
                        .map_err(|e| e.to_string())?;
                    Ok(())
                })?;
                // Same best-effort rationale as Add.
                if let Err(e) = embed_memory_item(
                    state,
                    FEATURE_MEMORY_EXTRACTION,
                    embed_provider,
                    embed_model_id,
                    id,
                    text,
                    now,
                )
                .await
                {
                    log::warn!(
                        "memory inline embed failed for updated item {id} \
                         (source {source_type}:{source_id}): {e}; backfill will recover"
                    );
                }
            }
            crate::ai::memory_extractor::MemoryOp::Delete { id } => {
                if !memory_item_exists(state, id)? {
                    log::warn!(
                        "memory delete-op skipped: item {id} not found (source {source_type}:{source_id})"
                    );
                    continue;
                }
                state.with_conn(|conn| {
                    memory::tombstone_memory_item(conn, id, now).map_err(|e| e.to_string())
                })?;
            }
        }
    }
    Ok(())
}

/// Embed one memory item's text and upsert the vector. `feature` is the
/// audit-attribution slug of the CALLING pass — inline item embeds bill to
/// whoever triggered them (`memory_extraction` for the extraction worker +
/// backfill, `memory_consolidation` for the tidy pass), never the Phase 4
/// retrieval slug (decision 11). `now` threads through from the caller so
/// tests can assert exact timestamps.
async fn embed_memory_item(
    state: &AppState,
    feature: &str,
    embed_provider: &Arc<dyn crate::ai::provider::AIProvider>,
    embed_model_id: &str,
    memory_id: &str,
    text: &str,
    now: i64,
) -> Result<(), String> {
    // Hard-gate every auto vector spend (apply_ops, consolidation, backfill):
    // pending/pause/switch decision or Remote without key → keep text, skip
    // provider. Callers treat Ok as "done"; missing vectors recover later via
    // backfill once the decision unblocks.
    let auto_ok = state.with_conn(|conn| {
        Ok(crate::commands::ai_settings::memory_embed_auto_allowed(
            conn,
        ))
    })?;
    if !auto_ok {
        log::debug!(
            "[memory] skip embed for {memory_id}: memory_embed_auto_allowed=false \
             (decision/key gate); text kept"
        );
        return Ok(());
    }
    let vecs = with_feature(feature, async { embed_provider.embed(&[text]).await })
        .await
        .map_err(|e| format!("memory item embed failed for {memory_id}: {e}"))?;
    if vecs.is_empty() {
        return Err(format!(
            "memory embedder returned no vector for item {memory_id}"
        ));
    }
    let vec = &vecs[0];
    let dim = vec.len() as i64;
    let hash = chunking::content_hash(text);
    state.with_conn(|conn| {
        memory::upsert_memory_embedding(conn, memory_id, embed_model_id, dim, vec, &hash, now)
            .map_err(|e| e.to_string())
    })?;
    Ok(())
}

/// `true` when a non-deleted memory item with `id` exists. Delegates to the
/// DB-layer existence probe (a `SELECT 1 ... LIMIT 1`) rather than
/// materializing every non-deleted `MemoryItemRow`. Tombstoned items return
/// `false`, so update/delete ops on them are skipped rather than reanimating
/// or re-tombstoning.
fn memory_item_exists(state: &AppState, id: &str) -> Result<bool, String> {
    state.with_conn(|conn| memory::memory_item_exists(conn, id).map_err(|e| e.to_string()))
}

/// Mark the job `skipped` — used when the source is locked-without-opt-in,
/// invisible, missing, empty, or when the memory feature is not configured.
/// A no-op (not an error) if the job row does not exist yet (the scan T3.3
/// creates job rows; a manual trigger before any scan will touch zero rows).
fn mark_skipped(
    state: &AppState,
    source_type: &str,
    source_id: &str,
    now: i64,
) -> Result<(), String> {
    state.with_conn(|conn| {
        memory::skip_memory_job(conn, source_type, source_id, now).map_err(|e| e.to_string())
    })
}

/// Mark the job `skipped` the RECOVERABLE way — used when the reason is
/// expected to resolve on its own (the missing-consent gate above). Delegates
/// to [`memory::upsert_memory_job_skipped`], which clears `content_hash` so a
/// future scan's hash diff flips the row back to `pending` once the source
/// clears the gate, instead of [`skip_memory_job`]'s hash-preserving skip
/// (used by `mark_skipped` for reasons that need an explicit content change
/// to re-queue).
fn mark_skipped_recoverable(
    state: &AppState,
    source_type: &str,
    source_id: &str,
    now: i64,
) -> Result<(), String> {
    state.with_conn(|conn| {
        memory::upsert_memory_job_skipped(conn, source_type, source_id, now)
            .map_err(|e| e.to_string())
    })
}

/// Mark the job `error` after a failed extraction attempt: records `last_error`,
/// bumps `attempt_count`, and schedules the next retry using the
/// [`BACKOFF_SECONDS`] cadence indexed by the pre-bump attempt count. Reads
/// the current `attempt_count` and writes the failure atomically under one DB
/// lock so a concurrent claimer cannot race the backoff computation. `now` is
/// threaded from the caller (ultimately [`run_memory_tick`]'s `now`) so tests
/// can assert exact backoff intervals.
fn fail_job(
    state: &AppState,
    source_type: &str,
    source_id: &str,
    err: &str,
    now: i64,
) -> Result<(), String> {
    state.with_conn(|conn| {
        let attempt_count = memory::get_memory_job(conn, source_type, source_id)
            .map_err(|e| e.to_string())?
            .map(|j| j.attempt_count)
            .unwrap_or(0);
        let idx = (attempt_count as usize).min(BACKOFF_SECONDS.len() - 1);
        let next_attempt_at = now + BACKOFF_SECONDS[idx];
        memory::fail_memory_job(conn, source_type, source_id, err, next_attempt_at, now)
            .map_err(|e| e.to_string())?;
        Ok(())
    })
}

// ---------------------------------------------------------------------------
// Background worker loop (T3.4)
// ---------------------------------------------------------------------------

/// One tick of the background memory worker — the testable core of
/// [`run_memory_scan_loop`]. Returns `Err` only on an unrecoverable DB error
/// that prevents the tick from making progress; per-source extraction errors
/// are swallowed (logged) so one bad source cannot abort the whole tick.
///
/// Sequence (strictly ordered — plan T3.4):
/// 1. **Gate.** [`ProviderRegistry::is_memory_enabled`] false → return `Ok(())`
///    immediately. ZERO provider calls, ZERO DB writes — the whole feature is
///    inert when either memory slot is unconfigured.
/// 2. **Strand recovery.** [`memory::recover_stranded_in_progress_memory_jobs`]
///    flips any job left `in_progress` by a mid-extraction crash/cancel back to
///    `pending` so this tick's claim step can re-attempt it. Cheap and
///    idempotent — only touches `in_progress` rows. Paused jobs are
///    deliberately NOT reset here (that would defeat the pause); they recover
///    via scan-driven re-queue on content change, or via
///    [`memory::reset_paused_memory_jobs_to_pending`] once at loop start after
///    an app restart.
/// 3. **Scan.** [`run_memory_scan`] content-hash-diffs recent sources into
///    `pending` (T3.3).
/// 4. **Claim + extract.** Drain [`memory::claim_due_memory_jobs`] in batches
///    of [`MEMORY_CLAIM_LIMIT`], calling [`extract_memories_for_source`] per
///    claim (T3.2 — it owns complete/fail). After a failure bumps
///    `attempt_count` to [`PAUSE_AT_ATTEMPT_COUNT`], [`memory::pause_memory_job`]
///    takes over so auto-retry stops — mirroring the embedding indexer's pause.
///    One bad source never aborts the tick.
/// 5. **Model-swap backfill.** [`backfill_missing_embeddings`] re-embeds items
///    whose vector is missing for the active embed model (plan decision 10 —
///    load-bearing, not defensive).
///
/// No DB lock is held across any `.await` (provider call) — each `with_conn`
/// closure returns before the next `.await`, matching `AppState::with_conn`
/// discipline.
pub async fn run_memory_tick(
    state: &AppState,
    registry: &ProviderRegistry,
    now: i64,
) -> Result<(), String> {
    // 1. GATE — preference ON ∧ both memory slots. Inert otherwise: ZERO
    //    provider calls, ZERO DB writes.
    let active = state.with_conn(|conn| {
        Ok(crate::commands::ai_settings::is_user_memory_active(
            conn, registry,
        ))
    })?;
    if !active {
        return Ok(());
    }

    // 2. Strand recovery — flip any in_progress job left by a prior crash/cancel
    //    back to pending so this tick's claim step can re-attempt it.
    state.with_conn(|conn| {
        memory::recover_stranded_in_progress_memory_jobs(conn, now).map_err(|e| e.to_string())
    })?;

    // 3. Scan — content-hash-diff recent sources into pending.
    run_memory_scan(state, registry)?;

    // 4. Claim + extract. Drain in bounded batches; one bad source must not
    //    abort the tick.
    loop {
        let claimed = state.with_conn(|conn| {
            memory::claim_due_memory_jobs(conn, MEMORY_CLAIM_LIMIT, now).map_err(|e| e.to_string())
        })?;
        if claimed.is_empty() {
            break;
        }
        for job in claimed {
            let source_type = job.source_type.clone();
            let source_id = job.source_id.clone();
            if let Err(e) =
                extract_memories_for_source(state, registry, &source_type, &source_id, now).await
            {
                // T3.2 already fail_job'd (status=error, attempt_count bumped,
                // next_attempt_at scheduled). Re-read to decide whether this
                // failure crossed the pause threshold — if so, pause takes over
                // so auto-retry stops. The status check guards the rare path
                // where extract returned Err WITHOUT calling fail_job (e.g. a
                // `complete_memory_job` DB write failure after a successful
                // extraction) — in that case the job is not in `error` and we
                // do not pause it.
                let should_pause = state.with_conn(|conn| {
                    Ok(memory::get_memory_job(conn, &source_type, &source_id)
                        .map_err(|e| e.to_string())?
                        .map(|j| j.status == "error" && j.attempt_count >= PAUSE_AT_ATTEMPT_COUNT)
                        .unwrap_or(false))
                })?;
                if should_pause {
                    if let Err(pause_err) = state.with_conn(|conn| {
                        memory::pause_memory_job(conn, &source_type, &source_id, &e, now)
                            .map_err(|e| e.to_string())
                    }) {
                        log::warn!(
                            "[memory] pause_memory_job failed for {source_type}:{source_id}: {pause_err}"
                        );
                    }
                }
                // Continue to the next claimed job regardless.
            }
        }
    }

    // 5. Slow persona refresh shares this worker; it intentionally never
    //    forces through a user edit and failures do not stop extraction.
    if let Err(e) = maybe_auto_refresh_persona(state, registry, now).await {
        log::warn!("[memory] persona auto-refresh failed: {e}");
    }

    // 6. Model-swap / missing-vector backfill (plan decision 10 — load-bearing).
    backfill_missing_embeddings(state, registry, now).await;

    Ok(())
}

/// Embed enabled, non-deleted memory items that have no `memory_embeddings` row
/// for the active memory-embed model (plan decision 10 — load-bearing). An
/// embed-model swap or a peer pull whose vectors were written by a different
/// model would leave retrieval silently empty without this pass. Each embed is
/// attributed to `memory_extraction` (decision 11) via [`embed_memory_item`].
/// Errors are logged and skipped — one bad item must not abort the pass.
///
/// **Embed-sync decision gate:** when the memory slot decision is
/// `pending`/`pause`/`switch`, this pass is a no-op so we never spend
/// vector calls while the user still owes a choice. Text extraction/scan
/// on the same tick is intentionally **not** gated here (gen slot OK).
async fn backfill_missing_embeddings(state: &AppState, registry: &ProviderRegistry, now: i64) {
    let Some(embed_provider) = registry.memory_embedder() else {
        return; // is_memory_enabled() gate already checked upstream.
    };
    // Hard-gate vector spend on the device-local decision receipt.
    let auto_ok = state.with_conn(|conn| {
        crate::commands::ai_embedding_decision::maybe_stamp_memory_missing_key(conn);
        Ok(crate::commands::ai_settings::memory_embed_auto_allowed(
            conn,
        ))
    });
    match auto_ok {
        Ok(true) => {}
        Ok(false) => return,
        Err(e) => {
            log::warn!("[memory] backfill decision gate failed: {e}");
            return;
        }
    }
    // PRIVACY — see `memory_class_privacy_accepted` doc comment. This pass
    // calls the embed provider directly, independent of the per-source
    // extraction gate, so it needs its own check.
    match memory_class_privacy_accepted(state, embed_provider.endpoint_class()) {
        Ok(true) => {}
        Ok(false) => return,
        Err(e) => {
            log::warn!("[memory] backfill privacy check failed: {e}");
            return;
        }
    }
    // Provider-namespaced — same form as the extraction writer above and
    // sync's `configured_memory_embedding_model_id` (adoption predicate).
    let active_model_id = provider_namespaced_model_id(embed_provider.as_ref());

    // Load the ids missing a vector for the active model.
    let missing_ids: Vec<String> = match state.with_conn(|conn| {
        memory::list_memory_ids_missing_embedding_for_model(conn, &active_model_id)
            .map_err(|e| e.to_string())
    }) {
        Ok(v) => v,
        Err(e) => {
            log::warn!("[memory] backfill list failed: {e}");
            return;
        }
    };
    if missing_ids.is_empty() {
        return;
    }

    // Load item texts (memory item counts are bounded — distilled durable
    // facts — so the full list is cheap). Filter to the missing set + cap.
    let to_embed: Vec<(String, String)> =
        match state.with_conn(|conn| memory::list_memory_items(conn).map_err(|e| e.to_string())) {
            Ok(items) => items
                .into_iter()
                .filter(|i| i.enabled && missing_ids.contains(&i.id))
                .take(MEMORY_BACKFILL_LIMIT)
                .map(|i| (i.id, i.text))
                .collect(),
            Err(e) => {
                log::warn!("[memory] backfill item load failed: {e}");
                return;
            }
        };

    for (id, text) in to_embed {
        // Reuse the T3.2 inline-embed helper (attribution + upsert). On error,
        // log and continue — a single bad item must not abort the backfill.
        if let Err(e) = embed_memory_item(
            state,
            FEATURE_MEMORY_EXTRACTION,
            &embed_provider,
            &active_model_id,
            &id,
            &text,
            now,
        )
        .await
        {
            log::warn!("[memory] backfill embed failed for {id}: {e}");
        }
    }
}

/// Background memory worker loop (Phase 3 T3.4). Thin `loop { tick; sleep }`
/// wrapper around [`run_memory_tick`] — mirrors how the embedding backfill loop
/// (`commands::ai::run_backfill_loop`) relates to its tick body. The tick is
/// inert when [`ProviderRegistry::is_memory_enabled`] is false (no provider
/// calls, no DB writes), so spawning before either memory slot is configured is
/// free.
///
/// Once at loop start, [`memory::reset_paused_memory_jobs_to_pending`] gives
/// jobs paused in a previous app session a fresh attempt budget — the memory
/// analog of the embedding loop's startup
/// `recover_stranded_in_progress_jobs`. Paused jobs created DURING this run are
/// NOT reset every tick (that would defeat the pause); they recover via
/// scan-driven re-queue when their source's content changes.
///
/// Spawned once via [`start_memory_worker`] alongside the embedding backfill
/// loop in `commands::ai::start_indexing_worker`. Runs for the app's lifetime;
/// when the app is locked the real DB is swapped for a startup placeholder, so
/// the scan finds no candidates and the tick is naturally inert.
pub async fn run_memory_scan_loop(app: tauri::AppHandle) {
    use tauri::Manager;
    let app_state = app.state::<AppState>();
    let registry = app.state::<ProviderRegistry>();

    // One-time recovery: give jobs paused in a prior session a fresh start.
    let recover_now = chrono::Utc::now().timestamp();
    if let Err(e) = app_state.with_conn(|conn| {
        memory::reset_paused_memory_jobs_to_pending(conn, recover_now, recover_now)
            .map_err(|e| e.to_string())
    }) {
        log::warn!("[memory] startup paused-job recovery failed: {e}");
    }

    loop {
        let now = chrono::Utc::now().timestamp();
        if let Err(e) = run_memory_tick(&app_state, &registry, now).await {
            log::warn!("[memory] scan tick failed: {e}");
        }
        // After maybe_stamp_memory_missing_key inside backfill: emit if the
        // memory decision entered/refreshed pending (fingerprint-debounced).
        let _ = app_state.with_conn(|conn| {
            crate::commands::ai_embedding_decision::emit_embedding_decision_needed_if_changed(
                &app, conn,
            );
            Ok(())
        });
        tokio::select! {
            _ = tokio::time::sleep(std::time::Duration::from_secs(MEMORY_TICK_INTERVAL_SECS)) => {}
            _ = memory_worker_nudge().notified() => {}
        }
    }
}

/// Idempotent double-spawn guard for [`run_memory_scan_loop`]. `OnceLock` means
/// the worker is started exactly once per process — subsequent
/// `start_indexing_worker` calls (unlock, provider save) are no-ops, which is
/// correct because the tick gates on [`ProviderRegistry::is_memory_enabled`] at
/// runtime rather than depending on a per-call spawn.
static MEMORY_WORKER_STARTED: std::sync::OnceLock<()> = std::sync::OnceLock::new();

/// Idempotent: spawn the background memory worker ([`run_memory_scan_loop`])
/// once. Subsequent calls are no-ops — the loop runs for the app's lifetime.
/// Called from `commands::ai::start_indexing_worker` alongside the embedding
/// backfill loop spawn. The tick is inert unless both memory slots are
/// configured, so an early spawn (before the user configures the slots) costs
/// only one sleep per tick cycle.
pub fn start_memory_worker(app: tauri::AppHandle) {
    if MEMORY_WORKER_STARTED.set(()).is_err() {
        return; // already started — the loop runs for the app's lifetime
    }
    tauri::async_runtime::spawn(run_memory_scan_loop(app));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::error::AiError;
    use crate::ai::persona_builder::{PERSONA_ANSWERS_JSON_MAX_BYTES, PERSONA_ANSWERS_MAX_CHARS};
    use crate::ai::provider::{AIProvider, ChatOpts, EndpointClass, ImageOpts, Message};
    use crate::ai::provider_registry::ProviderRegistry;
    use crate::db::schema;
    use async_trait::async_trait;
    use rusqlite::{params, Connection};
    use std::sync::atomic::{AtomicUsize, Ordering};

    // ── Test DB + seeding helpers ───────────────────────────────────────────

    fn open_test_db() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        schema::migrate(&conn).expect("migrate");
        conn
    }

    fn make_state() -> AppState {
        let conn = open_test_db();
        AppState::new(conn)
    }

    /// Seed a journal + entry row. Mirrors `db::memory` tests' `seed_entry`.
    fn seed_entry(state: &AppState, journal_id: &str, entry_id: &str, is_locked: bool) {
        state
            .with_conn(|conn| {
                conn.execute(
                    "INSERT OR IGNORE INTO journals (id, name, created_at, updated_at)
                     VALUES (?1, 'J', 0, 0)",
                    params![journal_id],
                )
                .map_err(|e| e.to_string())?;
                conn.execute(
                    "INSERT INTO entries
                        (id, journal_id, title, content_text, entry_date,
                         created_at, updated_at, is_locked, is_invisible)
                     VALUES (?1, ?2, ?3, ?4, 0, 0, 0, ?5, 0)",
                    params![
                        entry_id,
                        journal_id,
                        "Title",
                        "Body content",
                        is_locked as i64
                    ],
                )
                .map_err(|e| e.to_string())?;
                Ok(())
            })
            .unwrap();
    }

    /// Seed a chat session + two messages (user + assistant).
    fn seed_chat_session(state: &AppState, session_id: &str) {
        state
            .with_conn(|conn| {
                conn.execute(
                    "INSERT INTO chat_sessions
                        (id, title, persona, persona_prompt_snapshot, language,
                         created_at, updated_at)
                     VALUES (?1, NULL, 'empathetic', '', 'en', 0, 0)",
                    params![session_id],
                )
                .map_err(|e| e.to_string())?;
                conn.execute(
                    "INSERT INTO chat_messages
                        (id, session_id, role, content, seq, created_at)
                     VALUES ('m1', ?1, 'user', 'I got promoted to senior engineer.', 0, 0)",
                    params![session_id],
                )
                .map_err(|e| e.to_string())?;
                conn.execute(
                    "INSERT INTO chat_messages
                        (id, session_id, role, content, seq, created_at)
                     VALUES ('m2', ?1, 'assistant', 'Congrats!', 1, 1)",
                    params![session_id],
                )
                .map_err(|e| e.to_string())?;
                Ok(())
            })
            .unwrap();
    }

    /// Pre-seed a `memory_jobs` row so skip/complete/fail transitions are
    /// observable (the UPDATEs affect zero rows otherwise).
    fn seed_job(state: &AppState, source_type: &str, source_id: &str) {
        state
            .with_conn(|conn| {
                memory::upsert_memory_job_watermark(conn, source_type, source_id, "h", 0, 100)
                    .map_err(|e| e.to_string())
            })
            .unwrap();
    }

    fn get_job_status(state: &AppState, source_type: &str, source_id: &str) -> String {
        state
            .with_conn(|conn| {
                memory::get_memory_job(conn, source_type, source_id).map_err(|e| e.to_string())
            })
            .unwrap()
            .expect("job row present")
            .status
    }

    /// Flip the `ai_user_memory_enabled` master preference (default-on).
    fn set_user_memory_toggle(state: &AppState, on: bool) {
        state
            .with_conn(|conn| {
                db::set_setting(
                    conn,
                    crate::ai::provider::settings_keys::USER_MEMORY_ENABLED,
                    if on { "true" } else { "false" },
                )
                .map_err(|e| e.to_string())
            })
            .unwrap();
    }

    // ── CountingFakeProvider ────────────────────────────────────────────────
    //
    // A minimal AIProvider that records how many times each method was called
    // and returns a canned chat response + a deterministic embedding vector.
    // `counts` is shared out-of-band so tests can assert call counts even
    // though the provider reaches the fn wrapped in AuditingProvider.

    #[derive(Default)]
    struct CallCounts {
        chat: AtomicUsize,
        embed: AtomicUsize,
        embed_query: AtomicUsize,
    }

    struct CountingFakeProvider {
        counts: Arc<CallCounts>,
        chat_response: String,
        embed_vec: Vec<f32>,
        endpoint_class: EndpointClass,
    }

    impl CountingFakeProvider {
        fn new(counts: Arc<CallCounts>, chat_response: &str) -> Self {
            Self {
                counts,
                chat_response: chat_response.to_string(),
                embed_vec: vec![0.1, 0.2, 0.3, 0.4],
                endpoint_class: EndpointClass::OnDevice,
            }
        }

        /// Override the auto-exempt `OnDevice` default — used to simulate a
        /// hosted/CLI memory slot for the F13 consent-gate tests.
        fn with_class(mut self, class: EndpointClass) -> Self {
            self.endpoint_class = class;
            self
        }
    }

    #[async_trait]
    impl AIProvider for CountingFakeProvider {
        fn id(&self) -> &str {
            "fake-memory"
        }
        fn display_name(&self) -> &str {
            "Fake Memory Provider"
        }
        fn embedding_model_id(&self) -> &str {
            "fake-embed-model"
        }
        fn chat_model_id(&self) -> &str {
            "fake-chat-model"
        }
        fn endpoint_host(&self) -> String {
            "localhost".to_string()
        }
        fn endpoint_class(&self) -> EndpointClass {
            self.endpoint_class
        }
        async fn embed(&self, _texts: &[&str]) -> Result<Vec<Vec<f32>>, AiError> {
            self.counts.embed.fetch_add(1, Ordering::SeqCst);
            Ok(vec![self.embed_vec.clone()])
        }
        async fn embed_query(&self, _texts: &[&str]) -> Result<Vec<Vec<f32>>, AiError> {
            self.counts.embed_query.fetch_add(1, Ordering::SeqCst);
            Ok(vec![self.embed_vec.clone()])
        }
        async fn chat(&self, _messages: &[Message], _opts: ChatOpts) -> Result<String, AiError> {
            self.counts.chat.fetch_add(1, Ordering::SeqCst);
            Ok(self.chat_response.clone())
        }
        // Trait defaults cover set_usage_sink / chat_stream / generate_image.
        // Explicitly referenced here to confirm we don't accidentally add an
        // ImageOpts import the trait default doesn't already cover.
        #[allow(unused_variables)]
        async fn generate_image(&self, prompt: &str, opts: ImageOpts) -> Result<Vec<u8>, AiError> {
            Err(AiError::ProviderUnsupported("no image gen".into()))
        }
    }

    /// Build a registry with both memory slots wired to a CountingFakeProvider
    /// sharing `counts`. Returns the registry; tests read `counts` afterwards.
    fn registry_with_memory(counts: Arc<CallCounts>, chat_response: &str) -> ProviderRegistry {
        registry_with_memory_class(counts, chat_response, EndpointClass::OnDevice)
    }

    /// Same as `registry_with_memory`, but both memory slots resolve to
    /// `class` instead of the auto-exempt `OnDevice` default — used to
    /// simulate a hosted/CLI memory slot for the F13 consent-gate tests.
    fn registry_with_memory_class(
        counts: Arc<CallCounts>,
        chat_response: &str,
        class: EndpointClass,
    ) -> ProviderRegistry {
        let registry = ProviderRegistry::default();
        let gen: Arc<dyn AIProvider> = Arc::new(
            CountingFakeProvider::new(Arc::clone(&counts), chat_response).with_class(class),
        );
        let embed: Arc<dyn AIProvider> =
            Arc::new(CountingFakeProvider::new(counts, chat_response).with_class(class));
        registry.swap_memory_generation(gen);
        registry.swap_memory_embedding(embed);
        registry
    }

    struct BlockingPersonaProvider {
        started: Arc<tokio::sync::Notify>,
        release: Arc<tokio::sync::Notify>,
        response: String,
    }

    #[async_trait]
    impl AIProvider for BlockingPersonaProvider {
        fn id(&self) -> &str {
            "blocking-persona"
        }
        fn display_name(&self) -> &str {
            "Blocking Persona Provider"
        }
        fn embedding_model_id(&self) -> &str {
            "blocking-embed"
        }
        fn endpoint_class(&self) -> EndpointClass {
            EndpointClass::OnDevice
        }
        async fn embed(&self, _texts: &[&str]) -> Result<Vec<Vec<f32>>, AiError> {
            Ok(vec![vec![0.1]])
        }
        async fn chat(&self, _messages: &[Message], _opts: ChatOpts) -> Result<String, AiError> {
            self.started.notify_one();
            self.release.notified().await;
            Ok(self.response.clone())
        }
    }

    fn registry_with_blocking_persona(
        started: Arc<tokio::sync::Notify>,
        release: Arc<tokio::sync::Notify>,
    ) -> ProviderRegistry {
        let registry = ProviderRegistry::default();
        let gen: Arc<dyn AIProvider> = Arc::new(BlockingPersonaProvider {
            started,
            release,
            response: "TRAITS:\nGenerated traits.\nSTYLE:\nNo style sample was provided.".into(),
        });
        let embed: Arc<dyn AIProvider> = Arc::new(CountingFakeProvider::new(
            Arc::new(CallCounts::default()),
            "{}",
        ));
        registry.swap_memory_generation(gen);
        registry.swap_memory_embedding(embed);
        registry
    }

    // ── Tests ───────────────────────────────────────────────────────────────

    // (a) locked entry source without opt-in is skipped, ZERO provider calls.
    #[tokio::test]
    async fn locked_entry_without_opt_in_is_skipped_with_no_provider_calls() {
        let state = make_state();
        seed_entry(&state, "j1", "e1", true); // LOCKED entry
        seed_job(&state, "journal_entry", "e1");
        // ai_memory_include_protected NOT set → defaults to false → gate skips.

        let counts = Arc::new(CallCounts::default());
        let registry = registry_with_memory(counts.clone(), "{\"ops\":[]}");

        extract_memories_for_source(&state, &registry, "journal_entry", "e1", 1000)
            .await
            .expect("skipped is Ok");

        assert_eq!(get_job_status(&state, "journal_entry", "e1"), "skipped");
        assert_eq!(counts.chat.load(Ordering::SeqCst), 0, "no chat calls");
        assert_eq!(counts.embed.load(Ordering::SeqCst), 0, "no embed calls");
        assert_eq!(
            counts.embed_query.load(Ordering::SeqCst),
            0,
            "no embed_query calls"
        );
    }

    // (a-extra) locked entry WITH opt-in IS processed.
    #[tokio::test]
    async fn locked_entry_with_opt_in_is_processed() {
        let state = make_state();
        seed_entry(&state, "j1", "e1", true); // LOCKED entry
        seed_job(&state, "journal_entry", "e1");
        state
            .with_conn(|conn| {
                crate::db::set_setting(
                    conn,
                    crate::ai::provider::settings_keys::MEMORY_INCLUDE_PROTECTED,
                    "true",
                )
                .map_err(|e| e.to_string())
            })
            .unwrap();

        let counts = Arc::new(CallCounts::default());
        let registry = registry_with_memory(counts.clone(), r#"{"ops":[]}"#);

        extract_memories_for_source(&state, &registry, "journal_entry", "e1", 1000)
            .await
            .expect("completed");

        assert_eq!(get_job_status(&state, "journal_entry", "e1"), "indexed");
        assert_eq!(counts.chat.load(Ordering::SeqCst), 1, "one chat call");
        assert_eq!(
            counts.embed_query.load(Ordering::SeqCst),
            1,
            "one query embed"
        );
    }

    // (a-extra-2) Bug 2 regression: `ai_embed_include_protected` (the entry-
    // embedding backfill's toggle) must NOT unlock memory extraction on its
    // own — the two opt-ins are independent keys.
    #[tokio::test]
    async fn embed_include_protected_alone_does_not_unlock_memory_extraction() {
        let state = make_state();
        seed_entry(&state, "j1", "e1", true); // LOCKED entry
        seed_job(&state, "journal_entry", "e1");
        state
            .with_conn(|conn| {
                crate::db::set_setting(
                    conn,
                    crate::ai::provider::settings_keys::EMBED_INCLUDE_PROTECTED,
                    "true",
                )
                .map_err(|e| e.to_string())
            })
            .unwrap();

        let counts = Arc::new(CallCounts::default());
        let registry = registry_with_memory(counts.clone(), r#"{"ops":[]}"#);

        extract_memories_for_source(&state, &registry, "journal_entry", "e1", 1000)
            .await
            .expect("skipped is Ok");

        assert_eq!(
            get_job_status(&state, "journal_entry", "e1"),
            "skipped",
            "ai_embed_include_protected must not double as memory's opt-in"
        );
        assert_eq!(counts.chat.load(Ordering::SeqCst), 0);
    }

    // F13: hosted memory class + no `ai_privacy_accepted_at` receipt is
    // skipped with ZERO provider calls — this is the consent gate itself
    // (1b in `extract_memories_for_source`), distinct from the locked-entry
    // gate above.
    #[tokio::test]
    async fn hosted_memory_without_privacy_receipt_is_skipped_with_no_provider_calls() {
        let state = make_state();
        seed_entry(&state, "j1", "e1", false);
        seed_job(&state, "journal_entry", "e1");
        // No `ai_privacy_accepted_at` receipt seeded — fresh DB default.

        let counts = Arc::new(CallCounts::default());
        let registry =
            registry_with_memory_class(counts.clone(), r#"{"ops":[]}"#, EndpointClass::Remote);

        extract_memories_for_source(&state, &registry, "journal_entry", "e1", 1000)
            .await
            .expect("skipped is Ok");

        assert_eq!(get_job_status(&state, "journal_entry", "e1"), "skipped");
        assert_eq!(counts.chat.load(Ordering::SeqCst), 0, "no chat calls");
        assert_eq!(counts.embed.load(Ordering::SeqCst), 0, "no embed calls");
        assert_eq!(
            counts.embed_query.load(Ordering::SeqCst),
            0,
            "no embed_query calls"
        );
    }

    // F13 companion: a hosted-class consent skip must clear `content_hash`
    // (like the scan-time locked/invisible gate), not preserve it — so
    // accepting the receipt later re-queues the source on the next scan's
    // hash diff instead of it staying `skipped` forever.
    #[tokio::test]
    async fn hosted_memory_consent_skip_clears_hash_so_next_scan_requeues() {
        let state = make_state();
        seed_entry(&state, "j1", "e1", false);
        seed_job(&state, "journal_entry", "e1");

        let counts = Arc::new(CallCounts::default());
        let registry =
            registry_with_memory_class(counts.clone(), r#"{"ops":[]}"#, EndpointClass::Remote);

        extract_memories_for_source(&state, &registry, "journal_entry", "e1", 1000)
            .await
            .expect("skipped is Ok");
        assert_eq!(get_job_status(&state, "journal_entry", "e1"), "skipped");

        let hash = state
            .with_conn(|conn| {
                memory::get_memory_job(conn, "journal_entry", "e1").map_err(|e| e.to_string())
            })
            .unwrap()
            .expect("job row")
            .content_hash;
        assert_eq!(hash, "", "consent-gap skip clears content_hash");

        // Simulate the next scan re-hashing the (unchanged) source: since
        // the stored hash ("") differs from the real one, the watermark
        // upsert flips the row back to `pending` even though the receipt
        // still hasn't been accepted — the scan doesn't gate on privacy,
        // extraction does (this test only checks re-queueing).
        state
            .with_conn(|conn| {
                memory::upsert_memory_job_watermark(
                    conn,
                    "journal_entry",
                    "e1",
                    "real-hash",
                    0,
                    2000,
                )
                .map_err(|e| e.to_string())
            })
            .unwrap();
        assert_eq!(get_job_status(&state, "journal_entry", "e1"), "pending");
    }

    // I11: the dedicated get/set commands were removed (the generic
    // `get_setting`/`set_setting` commands cover this key now — see the
    // module doc note above `read_memory_include_protected`); this test
    // keeps coverage of the backend read path itself, driven directly
    // through `db::set_setting` the way the generic commands would.
    #[test]
    fn memory_include_protected_defaults_false_and_round_trips() {
        let state = make_state();
        assert!(
            !state
                .with_conn(|conn| Ok(read_memory_include_protected(conn)))
                .unwrap(),
            "missing setting defaults false"
        );

        state
            .with_conn(|conn| {
                db::set_setting(
                    conn,
                    crate::ai::provider::settings_keys::MEMORY_INCLUDE_PROTECTED,
                    "true",
                )
                .map_err(|e| e.to_string())
            })
            .unwrap();
        assert!(state
            .with_conn(|conn| Ok(read_memory_include_protected(conn)))
            .unwrap());

        state
            .with_conn(|conn| {
                db::set_setting(
                    conn,
                    crate::ai::provider::settings_keys::MEMORY_INCLUDE_PROTECTED,
                    "false",
                )
                .map_err(|e| e.to_string())
            })
            .unwrap();
        assert!(
            !state
                .with_conn(|conn| Ok(read_memory_include_protected(conn)))
                .unwrap(),
            "round-trips back to false"
        );
    }

    // (b) add-op creates an embedded item with a source row.
    #[tokio::test]
    async fn add_op_creates_item_with_embedding_and_source() {
        let state = make_state();
        seed_entry(&state, "j1", "e1", false); // unlocked
        seed_job(&state, "journal_entry", "e1");

        let chat = r#"{"ops":[{"op":"add","text":"Works as a marine biologist"}]}"#;
        let counts = Arc::new(CallCounts::default());
        let registry = registry_with_memory(counts.clone(), chat);

        extract_memories_for_source(&state, &registry, "journal_entry", "e1", 1000)
            .await
            .expect("extraction completes");

        // memory_items: one row with the sanitized text.
        let items = state
            .with_conn(|conn| memory::list_memory_items(&conn).map_err(|e| e.to_string()))
            .unwrap();
        assert_eq!(items.len(), 1, "one memory item added");
        assert_eq!(items[0].text, "Works as a marine biologist");
        assert_eq!(items[0].source_type, "journal_entry");
        assert!(!items[0].is_deleted);

        let new_id = items[0].id.clone();

        // memory_embeddings: one row for the active model.
        let embed_count: i64 = state
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM memory_embeddings
                     WHERE memory_id = ?1 AND model_id = 'fake-memory:fake-embed-model'",
                    params![new_id],
                    |row| row.get(0),
                )
                .map_err(|e| e.to_string())
            })
            .unwrap();
        assert_eq!(embed_count, 1, "embedding row exists for active model");

        // memory_item_sources: one row linking item → journal_entry:e1.
        let sources = state
            .with_conn(|conn| {
                memory::list_sources_for_memory(&conn, &new_id).map_err(|e| e.to_string())
            })
            .unwrap();
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].source_type, "journal_entry");
        assert_eq!(sources[0].source_id, "e1");

        // chat once + embed_query once + one inline embed for the add.
        assert_eq!(counts.chat.load(Ordering::SeqCst), 1);
        assert_eq!(counts.embed_query.load(Ordering::SeqCst), 1);
        assert_eq!(counts.embed.load(Ordering::SeqCst), 1);
        assert_eq!(get_job_status(&state, "journal_entry", "e1"), "indexed");
    }

    // ── consolidate_memories (Scan & tidy) ──────────────────────────────────

    /// Seed one enabled memory item with a single journal_entry source.
    fn seed_memory_with_source(state: &AppState, id: &str, text: &str, entry_id: &str) {
        state
            .with_conn(|conn| {
                memory::insert_memory_item(conn, id, text, "journal_entry", 100)
                    .map_err(|e| e.to_string())?;
                memory::add_memory_source(conn, id, "journal_entry", entry_id)
                    .map_err(|e| e.to_string())?;
                Ok(())
            })
            .unwrap();
    }

    fn live_memory_ids(state: &AppState) -> Vec<String> {
        state
            .with_conn(|conn| memory::list_memory_items(conn).map_err(|e| e.to_string()))
            .unwrap()
            .into_iter()
            .map(|i| i.id)
            .collect()
    }

    #[tokio::test]
    async fn consolidate_merges_items_transfers_sources_and_re_embeds() {
        let state = make_state();
        seed_entry(&state, "j1", "e1", false);
        seed_entry(&state, "j1", "e2", false);
        seed_memory_with_source(&state, "m1", "Works as a biologist", "e1");
        seed_memory_with_source(&state, "m2", "Is a marine biologist", "e2");
        seed_memory_with_source(&state, "m3", "Enjoyed a pizza yesterday", "e1");

        let chat = r#"{"ops":[
            {"op":"merge","keep":"m1","absorb":["m2"],"text":"Works as a marine biologist"},
            {"op":"drop","id":"m3"}
        ]}"#;
        let counts = Arc::new(CallCounts::default());
        let registry = registry_with_memory(counts.clone(), chat);

        let applied = consolidate_memories(&state, &registry, 1000)
            .await
            .expect("consolidation completes");
        assert_eq!(applied, 2, "one merge + one drop applied");

        // m2 and m3 tombstoned; m1 survives with the merged text.
        assert_eq!(live_memory_ids(&state), vec!["m1".to_string()]);
        let items = state
            .with_conn(|conn| memory::list_memory_items(conn).map_err(|e| e.to_string()))
            .unwrap();
        assert_eq!(items[0].text, "Works as a marine biologist");

        // Source-laundering guard: m2's e2 source moved onto m1 BEFORE the
        // tombstone, so locking e2 later still drops the merged fact.
        let mut sources: Vec<String> = state
            .with_conn(|conn| {
                memory::list_sources_for_memory(conn, "m1").map_err(|e| e.to_string())
            })
            .unwrap()
            .into_iter()
            .map(|s| s.source_id)
            .collect();
        sources.sort();
        assert_eq!(sources, vec!["e1".to_string(), "e2".to_string()]);

        // The merged text was re-embedded under the namespaced model id.
        assert_eq!(
            count_embeddings_for_model(&state, "m1", "fake-memory:fake-embed-model"),
            1,
            "merged item re-embedded"
        );
        // One consolidation chat call, one inline embed for the merge.
        assert_eq!(counts.chat.load(Ordering::SeqCst), 1);
        assert_eq!(counts.embed.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn consolidate_inert_when_memory_disabled_or_too_few_items() {
        // Disabled: both slots missing → zero provider calls, Ok(0).
        let state = make_state();
        seed_entry(&state, "j1", "e1", false);
        seed_memory_with_source(&state, "m1", "Fact A", "e1");
        seed_memory_with_source(&state, "m2", "Fact B", "e1");
        let registry = ProviderRegistry::default();
        assert_eq!(
            consolidate_memories(&state, &registry, 1000).await.unwrap(),
            0
        );

        // Too few items: a single memory has nothing to merge with → Ok(0)
        // WITHOUT a chat call.
        let state = make_state();
        seed_entry(&state, "j1", "e1", false);
        seed_memory_with_source(&state, "m1", "Fact A", "e1");
        let counts = Arc::new(CallCounts::default());
        let registry = registry_with_memory(counts.clone(), r#"{"ops":[]}"#);
        assert_eq!(
            consolidate_memories(&state, &registry, 1000).await.unwrap(),
            0
        );
        assert_eq!(counts.chat.load(Ordering::SeqCst), 0, "no chat call");
        // The single-item early return sits BEFORE the cooldown stamp — a
        // stamp here would lock a 1-item list out of tidying for the whole
        // window once it grows.
        assert_eq!(
            read_stamp(
                &state,
                crate::ai::provider::settings_keys::MEMORY_LAST_CONSOLIDATED_AT
            ),
            None,
            "inert pass must not stamp the cooldown"
        );
    }

    #[tokio::test]
    async fn consolidate_parse_failure_is_err_and_applies_nothing() {
        let state = make_state();
        seed_entry(&state, "j1", "e1", false);
        seed_memory_with_source(&state, "m1", "Fact A", "e1");
        seed_memory_with_source(&state, "m2", "Fact B", "e1");
        // The extraction verb "add" is invalid in the consolidation schema.
        let counts = Arc::new(CallCounts::default());
        let registry = registry_with_memory(counts, r#"{"ops":[{"op":"add","text":"invented"}]}"#);

        assert!(consolidate_memories(&state, &registry, 1000).await.is_err());
        let mut ids = live_memory_ids(&state);
        ids.sort();
        assert_eq!(
            ids,
            vec!["m1".to_string(), "m2".to_string()],
            "no partial application on parse failure"
        );
    }

    #[tokio::test]
    async fn consolidate_excludes_locked_sourced_items_and_skips_foreign_ids() {
        let state = make_state();
        seed_entry(&state, "j1", "e1", false);
        seed_entry(&state, "j1", "e_locked", true); // locked entry
        seed_memory_with_source(&state, "m1", "Fact A", "e1");
        seed_memory_with_source(&state, "m2", "Fact B", "e1");
        seed_memory_with_source(&state, "m_locked", "Locked-sourced fact", "e_locked");

        // The model tries to drop the locked-sourced item AND a hallucinated
        // id — both must be skipped (they were never in the batch), while the
        // valid rewrite still applies.
        let chat = r#"{"ops":[
            {"op":"drop","id":"m_locked"},
            {"op":"drop","id":"m_hallucinated"},
            {"op":"rewrite","id":"m1","text":"Fact A, concise"}
        ]}"#;
        let counts = Arc::new(CallCounts::default());
        let registry = registry_with_memory(counts, chat);

        let applied = consolidate_memories(&state, &registry, 1000)
            .await
            .expect("consolidation completes");
        assert_eq!(applied, 1, "only the rewrite applied");

        let mut ids = live_memory_ids(&state);
        ids.sort();
        assert_eq!(
            ids,
            vec!["m1".to_string(), "m2".to_string(), "m_locked".to_string()],
            "locked-sourced item untouched, hallucinated id ignored"
        );
    }

    /// Chat provider that answers call #N with `responses[N-1]` (falls back
    /// to `{"ops":[]}` when exhausted) — lets multi-batch consolidation tests
    /// hand each batch a different scripted response.
    struct SequencedChatProvider {
        counts: Arc<CallCounts>,
        responses: std::sync::Mutex<std::collections::VecDeque<String>>,
    }

    #[async_trait]
    impl AIProvider for SequencedChatProvider {
        fn id(&self) -> &str {
            "fake-memory-seq"
        }
        fn display_name(&self) -> &str {
            "Sequenced Chat Provider"
        }
        fn embedding_model_id(&self) -> &str {
            "fake-embed-model"
        }
        fn chat_model_id(&self) -> &str {
            "fake-chat-model"
        }
        fn endpoint_host(&self) -> String {
            "localhost".to_string()
        }
        fn endpoint_class(&self) -> EndpointClass {
            EndpointClass::OnDevice
        }
        async fn embed(&self, _texts: &[&str]) -> Result<Vec<Vec<f32>>, AiError> {
            self.counts.embed.fetch_add(1, Ordering::SeqCst);
            Ok(vec![vec![0.1, 0.2, 0.3, 0.4]])
        }
        async fn embed_query(&self, _texts: &[&str]) -> Result<Vec<Vec<f32>>, AiError> {
            self.counts.embed_query.fetch_add(1, Ordering::SeqCst);
            Ok(vec![vec![0.1, 0.2, 0.3, 0.4]])
        }
        async fn chat(&self, _messages: &[Message], _opts: ChatOpts) -> Result<String, AiError> {
            self.counts.chat.fetch_add(1, Ordering::SeqCst);
            Ok(self
                .responses
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or_else(|| r#"{"ops":[]}"#.to_string()))
        }
    }

    #[tokio::test]
    async fn consolidate_remote_class_without_receipt_is_inert() {
        let state = make_state();
        seed_entry(&state, "j1", "e1", false);
        seed_memory_with_source(&state, "m1", "Fact A", "e1");
        seed_memory_with_source(&state, "m2", "Fact B", "e1");
        // Remote-class memory slots with NO ai_privacy_accepted_at receipt:
        // the consent gate must return before any provider call.
        let counts = Arc::new(CallCounts::default());
        let registry =
            registry_with_memory_class(counts.clone(), r#"{"ops":[]}"#, EndpointClass::Remote);

        assert_eq!(
            consolidate_memories(&state, &registry, 1000).await.unwrap(),
            0
        );
        assert_eq!(counts.chat.load(Ordering::SeqCst), 0, "no chat call");
        assert_eq!(counts.embed.load(Ordering::SeqCst), 0, "no embed call");
    }

    #[tokio::test]
    async fn consolidate_merge_with_invalid_keep_leaves_absorb_untouched() {
        let state = make_state();
        seed_entry(&state, "j1", "e1", false);
        seed_memory_with_source(&state, "m1", "Fact A", "e1");
        seed_memory_with_source(&state, "m2", "Fact B", "e1");
        // keep is hallucinated → the whole merge must skip WITHOUT
        // tombstoning the (valid) absorb id.
        let chat = r#"{"ops":[{"op":"merge","keep":"m_ghost","absorb":["m2"],"text":"bogus"}]}"#;
        let counts = Arc::new(CallCounts::default());
        let registry = registry_with_memory(counts, chat);

        let applied = consolidate_memories(&state, &registry, 1000).await.unwrap();
        assert_eq!(applied, 0);
        let mut ids = live_memory_ids(&state);
        ids.sort();
        assert_eq!(ids, vec!["m1".to_string(), "m2".to_string()]);
    }

    #[tokio::test]
    async fn consolidate_merge_with_no_valid_absorb_leaves_keep_unchanged() {
        let state = make_state();
        seed_entry(&state, "j1", "e1", false);
        seed_memory_with_source(&state, "m1", "Fact A", "e1");
        seed_memory_with_source(&state, "m2", "Fact B", "e1");
        let chat = r#"{"ops":[{"op":"merge","keep":"m1","absorb":["m_ghost"],"text":"bogus"}]}"#;
        let counts = Arc::new(CallCounts::default());
        let registry = registry_with_memory(counts, chat);

        let applied = consolidate_memories(&state, &registry, 1000).await.unwrap();
        assert_eq!(applied, 0);
        let items = state
            .with_conn(|conn| memory::list_memory_items(conn).map_err(|e| e.to_string()))
            .unwrap();
        let m1 = items.iter().find(|i| i.id == "m1").expect("m1 lives");
        assert_eq!(m1.text, "Fact A", "keep text untouched");
    }

    #[tokio::test]
    async fn consolidate_excludes_disabled_items_and_applies_rewrite_fully() {
        let state = make_state();
        seed_entry(&state, "j1", "e1", false);
        seed_memory_with_source(&state, "m1", "Fact A", "e1");
        seed_memory_with_source(&state, "m2", "Fact B", "e1");
        seed_memory_with_source(&state, "m_off", "Disabled fact", "e1");
        state
            .with_conn(|conn| {
                memory::set_memory_enabled(conn, "m_off", false, 200).map_err(|e| e.to_string())
            })
            .unwrap();

        // The model tries to drop the disabled item — it was never in the
        // prompt (enabled-only candidates), so the op must be skipped; the
        // rewrite of an enabled item applies fully (text + re-embed).
        let chat = r#"{"ops":[
            {"op":"drop","id":"m_off"},
            {"op":"rewrite","id":"m1","text":"Fact A, concise"}
        ]}"#;
        let counts = Arc::new(CallCounts::default());
        let registry = registry_with_memory(counts, chat);

        let applied = consolidate_memories(&state, &registry, 1000).await.unwrap();
        assert_eq!(applied, 1, "only the rewrite applied");

        let items = state
            .with_conn(|conn| memory::list_memory_items(conn).map_err(|e| e.to_string()))
            .unwrap();
        let m_off = items.iter().find(|i| i.id == "m_off").expect("m_off lives");
        assert!(
            !m_off.enabled && !m_off.is_deleted,
            "disabled item untouched"
        );
        let m1 = items.iter().find(|i| i.id == "m1").expect("m1 lives");
        assert_eq!(m1.text, "Fact A, concise", "rewrite text persisted");
        assert_eq!(
            count_embeddings_for_model(&state, "m1", "fake-memory:fake-embed-model"),
            1,
            "rewrite re-embedded"
        );
    }

    #[tokio::test]
    async fn consolidate_inline_embed_failure_still_applies_rewrite() {
        let state = make_state();
        seed_entry(&state, "j1", "e1", false);
        seed_memory_with_source(&state, "m1", "Fact A", "e1");
        seed_memory_with_source(&state, "m2", "Fact B", "e1");
        // First (and only) inline embed fails — the committed text must
        // survive (backfill recovers the vector), never propagate as Err.
        let chat = r#"{"ops":[{"op":"rewrite","id":"m1","text":"Fact A, concise"}]}"#;
        let counts = Arc::new(CallCounts::default());
        let registry = registry_with_embed_fail_on_nth(counts, chat, 1);

        let applied = consolidate_memories(&state, &registry, 1000).await.unwrap();
        assert_eq!(applied, 1, "rewrite still counts as applied");
        let items = state
            .with_conn(|conn| memory::list_memory_items(conn).map_err(|e| e.to_string()))
            .unwrap();
        let m1 = items.iter().find(|i| i.id == "m1").expect("m1 lives");
        assert_eq!(m1.text, "Fact A, concise");
        assert_eq!(
            count_embeddings_for_model(&state, "m1", "fake-memory-fail-nth:fake-embed-model"),
            0,
            "no vector row after the failed embed (backfill's job)"
        );
    }

    #[tokio::test]
    async fn consolidate_batches_continue_after_a_failed_batch() {
        let state = make_state();
        seed_entry(&state, "j1", "e1", false);
        // 32 enabled items with ascending updated_at → `list_memory_items`
        // (updated_at DESC) puts the 30 newest in batch 1 and the 2 oldest
        // (m01, m00) in batch 2.
        state
            .with_conn(|conn| {
                for i in 0..32 {
                    let id = format!("m{i:02}");
                    memory::insert_memory_item(
                        conn,
                        &id,
                        &format!("Fact number {i}"),
                        "journal_entry",
                        100 + i,
                    )
                    .map_err(|e| e.to_string())?;
                    memory::add_memory_source(conn, &id, "journal_entry", "e1")
                        .map_err(|e| e.to_string())?;
                }
                Ok(())
            })
            .unwrap();

        // Batch 1 gets garbage (parse fails → batch skipped, pass continues);
        // batch 2 gets a valid rewrite of the oldest item.
        let counts = Arc::new(CallCounts::default());
        let registry = ProviderRegistry::default();
        registry.swap_memory_generation(Arc::new(SequencedChatProvider {
            counts: Arc::clone(&counts),
            responses: std::sync::Mutex::new(std::collections::VecDeque::from([
                "not json at all".to_string(),
                r#"{"ops":[{"op":"rewrite","id":"m00","text":"Oldest fact, tidied"}]}"#.to_string(),
            ])),
        }));
        registry.swap_memory_embedding(Arc::new(CountingFakeProvider::new(
            Arc::clone(&counts),
            r#"{"ops":[]}"#,
        )));

        let applied = consolidate_memories(&state, &registry, 1000)
            .await
            .expect("partial success is Ok, not Err");
        assert_eq!(
            applied, 1,
            "batch 2's rewrite applied despite batch 1 failing"
        );
        assert_eq!(
            counts.chat.load(Ordering::SeqCst),
            2,
            "both batches attempted"
        );
        let items = state
            .with_conn(|conn| memory::list_memory_items(conn).map_err(|e| e.to_string()))
            .unwrap();
        let m00 = items.iter().find(|i| i.id == "m00").expect("m00 lives");
        assert_eq!(m00.text, "Oldest fact, tidied");
        // Partial success is still a completed pass — the cooldown must hold,
        // or one flaky batch would re-enable the destructive re-tidy on every
        // Scan click.
        assert_eq!(
            read_stamp(
                &state,
                crate::ai::provider::settings_keys::MEMORY_LAST_CONSOLIDATED_AT
            )
            .as_deref(),
            Some("1000"),
            "partial success keeps the cooldown stamp"
        );
    }

    /// Read one of the three memory timestamp settings straight from the DB.
    fn read_stamp(state: &AppState, key: &str) -> Option<String> {
        state
            .with_conn(|conn| db::get_setting(conn, key).map_err(|e| e.to_string()))
            .unwrap()
    }

    #[test]
    fn worker_scan_stamps_last_scanned() {
        // "Last scanned" must move for the worker tick too — not only the
        // manual button — so the settings label reflects any real scan pass.
        let state = make_state();
        seed_entry(&state, "j1", "e1", false);
        let counts = Arc::new(CallCounts::default());
        let registry = registry_with_memory(counts, r#"{"ops":[]}"#);

        let claimed = run_memory_scan(&state, &registry).expect("scan");
        assert!(claimed > 0, "test precondition: the scan claimed a source");
        assert!(
            read_stamp(
                &state,
                crate::ai::provider::settings_keys::MEMORY_LAST_SCANNED_AT
            )
            .is_some(),
            "worker-path scan must update the last-scanned label"
        );
    }

    #[test]
    fn inactive_scan_does_not_stamp_last_scanned() {
        // Gate false → zero DB writes, including the last-scanned stamp.
        let state = make_state();
        seed_entry(&state, "j1", "e1", false);
        let counts = Arc::new(CallCounts::default());
        let registry = ProviderRegistry::default();
        // Only the generation slot — `is_user_memory_active` stays false.
        registry
            .swap_memory_generation(Arc::new(CountingFakeProvider::new(counts, r#"{"ops":[]}"#)));

        let claimed = run_memory_scan(&state, &registry).expect("scan");
        assert_eq!(claimed, 0);
        assert_eq!(
            read_stamp(
                &state,
                crate::ai::provider::settings_keys::MEMORY_LAST_SCANNED_AT
            ),
            None,
            "inactive scan must not stamp last-scanned"
        );
    }

    #[test]
    fn worker_scan_stamps_first_scanned() {
        // The label's "never scanned" state must mean "no scan of ANY kind
        // has run", so the worker-path scan stamps this marker even though it
        // leaves the manual-scan label alone.
        let state = make_state();
        seed_entry(&state, "j1", "e1", false);
        let counts = Arc::new(CallCounts::default());
        let registry = registry_with_memory(counts, r#"{"ops":[]}"#);

        run_memory_scan(&state, &registry).expect("scan");
        assert!(
            read_stamp(
                &state,
                crate::ai::provider::settings_keys::MEMORY_FIRST_SCANNED_AT
            )
            .is_some(),
            "worker-path scan must record that a scan has happened"
        );
    }

    #[test]
    fn scan_does_not_overwrite_first_scanned() {
        // Write-once: a re-write on every tick would be a settings write every
        // 30s for a value nothing reads beyond "is it set".
        let state = make_state();
        seed_entry(&state, "j1", "e1", false);
        state
            .with_conn(|conn| {
                db::set_setting(
                    conn,
                    crate::ai::provider::settings_keys::MEMORY_FIRST_SCANNED_AT,
                    "1000",
                )
                .map_err(|e| e.to_string())
            })
            .unwrap();
        let counts = Arc::new(CallCounts::default());
        let registry = registry_with_memory(counts, r#"{"ops":[]}"#);

        run_memory_scan(&state, &registry).expect("scan");
        assert_eq!(
            read_stamp(
                &state,
                crate::ai::provider::settings_keys::MEMORY_FIRST_SCANNED_AT
            )
            .as_deref(),
            Some("1000"),
            "the first scan's timestamp must survive later scans"
        );
    }

    #[test]
    fn scan_with_no_candidates_still_stamps_first_scanned() {
        // The marker exists precisely for the "just enabled memory, nothing
        // written yet" device: the worker tick finds zero candidates, but a
        // scan HAS run and the label must stop saying otherwise.
        let state = make_state();
        let counts = Arc::new(CallCounts::default());
        let registry = registry_with_memory(counts, r#"{"ops":[]}"#);

        assert_eq!(run_memory_scan(&state, &registry).expect("scan"), 0);
        assert!(
            read_stamp(
                &state,
                crate::ai::provider::settings_keys::MEMORY_FIRST_SCANNED_AT
            )
            .is_some(),
            "an empty scan is still a scan"
        );
    }

    #[test]
    fn inactive_scan_does_not_stamp_first_scanned() {
        // Gate promise: ZERO DB writes when the feature is inactive — so a
        // user who never enabled memory still reads "never scanned".
        let state = make_state();
        seed_entry(&state, "j1", "e1", false);
        let counts = Arc::new(CallCounts::default());
        let registry = ProviderRegistry::default();
        // Only the generation slot — `is_user_memory_active` stays false.
        registry
            .swap_memory_generation(Arc::new(CountingFakeProvider::new(counts, r#"{"ops":[]}"#)));

        assert_eq!(run_memory_scan(&state, &registry).expect("scan"), 0);
        assert_eq!(
            read_stamp(
                &state,
                crate::ai::provider::settings_keys::MEMORY_FIRST_SCANNED_AT
            ),
            None,
            "inactive gate must not write the marker"
        );
    }

    #[tokio::test]
    async fn consolidate_future_stamp_still_engages_cooldown() {
        let state = make_state();
        seed_entry(&state, "j1", "e1", false);
        seed_memory_with_source(&state, "m1", "Fact A", "e1");
        seed_memory_with_source(&state, "m2", "Fact B", "e1");
        // Clock skew: the stamp is AHEAD of `now`. Fail-safe direction is to
        // keep skipping the destructive pass, never to bypass the cooldown.
        state
            .with_conn(|conn| {
                db::set_setting(
                    conn,
                    crate::ai::provider::settings_keys::MEMORY_LAST_CONSOLIDATED_AT,
                    "999999999999",
                )
                .map_err(|e| e.to_string())
            })
            .unwrap();
        let counts = Arc::new(CallCounts::default());
        let registry = registry_with_memory(counts.clone(), r#"{"ops":[]}"#);

        assert_eq!(
            consolidate_memories(&state, &registry, 1000).await.unwrap(),
            0
        );
        assert_eq!(counts.chat.load(Ordering::SeqCst), 0, "no chat call");
    }

    #[test]
    fn stamp_memory_last_scanned_roundtrips() {
        let state = make_state();
        stamp_memory_last_scanned(&state, 4242).expect("stamp");
        let stored = state
            .with_conn(|conn| {
                db::get_setting(
                    conn,
                    crate::ai::provider::settings_keys::MEMORY_LAST_SCANNED_AT,
                )
                .map_err(|e| e.to_string())
            })
            .unwrap();
        assert_eq!(stored.as_deref(), Some("4242"));
    }

    #[tokio::test]
    async fn consolidate_within_cooldown_is_skipped_and_after_cooldown_runs_again() {
        let state = make_state();
        seed_entry(&state, "j1", "e1", false);
        seed_memory_with_source(&state, "m1", "Fact A", "e1");
        seed_memory_with_source(&state, "m2", "Fact B", "e1");
        let counts = Arc::new(CallCounts::default());
        let registry = registry_with_memory(counts.clone(), r#"{"ops":[]}"#);

        // First run: pass executes (chat called once) and stamps the cooldown.
        assert_eq!(
            consolidate_memories(&state, &registry, 1000).await.unwrap(),
            0
        );
        assert_eq!(counts.chat.load(Ordering::SeqCst), 1);

        // Second run one minute later: inside the cooldown → tidy skipped,
        // NO provider call — repeated Scan clicks must not keep shrinking an
        // already-clean list.
        assert_eq!(
            consolidate_memories(&state, &registry, 1000 + 60)
                .await
                .unwrap(),
            0
        );
        assert_eq!(counts.chat.load(Ordering::SeqCst), 1, "cooldown skip");

        // Past the cooldown: the pass runs again.
        assert_eq!(
            consolidate_memories(&state, &registry, 1000 + CONSOLIDATION_COOLDOWN_SECS + 1)
                .await
                .unwrap(),
            0
        );
        assert_eq!(counts.chat.load(Ordering::SeqCst), 2, "cooldown expired");
    }

    #[tokio::test]
    async fn consolidate_failure_does_not_stamp_cooldown() {
        let state = make_state();
        seed_entry(&state, "j1", "e1", false);
        seed_memory_with_source(&state, "m1", "Fact A", "e1");
        seed_memory_with_source(&state, "m2", "Fact B", "e1");
        let counts = Arc::new(CallCounts::default());
        let registry = registry_with_memory(counts.clone(), "not json at all");

        // Every batch fails → Err and NO cooldown stamp...
        assert!(consolidate_memories(&state, &registry, 1000).await.is_err());
        assert_eq!(counts.chat.load(Ordering::SeqCst), 1);
        // ...so an immediate retry is allowed to run the provider again.
        assert!(consolidate_memories(&state, &registry, 1000 + 60)
            .await
            .is_err());
        assert_eq!(counts.chat.load(Ordering::SeqCst), 2, "retry not blocked");
    }

    #[tokio::test]
    async fn consolidate_all_batches_failing_is_err() {
        let state = make_state();
        seed_entry(&state, "j1", "e1", false);
        seed_memory_with_source(&state, "m1", "Fact A", "e1");
        seed_memory_with_source(&state, "m2", "Fact B", "e1");
        let counts = Arc::new(CallCounts::default());
        let registry = registry_with_memory(counts, "not json at all");

        assert!(
            consolidate_memories(&state, &registry, 1000).await.is_err(),
            "zero applied + every batch failed must surface as Err"
        );
    }

    // (b') Cross-path invariant with sync adoption: the worker must stamp
    // `memory_embeddings.model_id` in the SAME provider-namespaced
    // `"{provider}:{model}"` form that `sync::engine`'s
    // `configured_memory_embedding_model_id` composes from the settings rows
    // — otherwise `adopt_memory_embedding_if_matching` can never match a
    // peer's vectors and every synced memory arrives on other devices
    // without a usable embedding.
    #[tokio::test]
    async fn worker_stamps_provider_namespaced_model_id_for_sync_adoption() {
        let state = make_state();
        seed_entry(&state, "j1", "e1", false);
        seed_job(&state, "journal_entry", "e1");

        let chat = r#"{"ops":[{"op":"add","text":"Works as a marine biologist"}]}"#;
        let counts = Arc::new(CallCounts::default());
        let registry = registry_with_memory(counts, chat);

        extract_memories_for_source(&state, &registry, "journal_entry", "e1", 1000)
            .await
            .expect("extraction completes");

        let stored_model_id: String = state
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT model_id FROM memory_embeddings LIMIT 1",
                    [],
                    |row| row.get(0),
                )
                .map_err(|e| e.to_string())
            })
            .unwrap();
        // CountingFakeProvider: id() = "fake-memory",
        // embedding_model_id() = "fake-embed-model".
        assert_eq!(
            stored_model_id, "fake-memory:fake-embed-model",
            "worker-stamped model_id must be provider-namespaced so sync \
             adoption on peer devices can match it"
        );
    }

    // (c) update-op rewrites text and re-embeds (hash differs).
    #[tokio::test]
    async fn update_op_rewrites_text_and_re_embeds() {
        let state = make_state();
        seed_entry(&state, "j1", "e1", false);
        seed_job(&state, "journal_entry", "e1");

        // Pre-seed an existing memory item that the extraction model decides
        // to update. The related-memory retrieval will surface it because its
        // embedding ranks in the top-K (the fake embedder returns the same
        // vector for everything → cosine 1.0).
        let old_text = "Lives in Lisbon";
        let old_hash = chunking::content_hash(old_text);
        state
            .with_conn(|conn| {
                memory::insert_memory_item(&conn, "mem_existing", old_text, "journal_entry", 100)
                    .map_err(|e| e.to_string())?;
                memory::upsert_memory_embedding(
                    &conn,
                    "mem_existing",
                    "fake-memory:fake-embed-model",
                    4,
                    &[0.1, 0.2, 0.3, 0.4],
                    &old_hash,
                    110,
                )
                .map_err(|e| e.to_string())?;
                memory::add_memory_source(&conn, "mem_existing", "journal_entry", "e0")
                    .map_err(|e| e.to_string())?;
                Ok(())
            })
            .unwrap();

        let chat =
            r#"{"ops":[{"op":"update","id":"mem_existing","text":"Lives in Lisbon, Portugal"}]}"#;
        let counts = Arc::new(CallCounts::default());
        let registry = registry_with_memory(counts.clone(), chat);

        extract_memories_for_source(&state, &registry, "journal_entry", "e1", 1000)
            .await
            .expect("extraction completes");

        // Text changed.
        let items = state
            .with_conn(|conn| memory::list_memory_items(&conn).map_err(|e| e.to_string()))
            .unwrap();
        assert_eq!(items.len(), 1, "still exactly one item (update, not add)");
        assert_eq!(items[0].id, "mem_existing");
        assert_eq!(items[0].text, "Lives in Lisbon, Portugal");

        // Embedding hash changed to the new text's hash.
        let new_hash: String = state
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT content_hash FROM memory_embeddings
                     WHERE memory_id = 'mem_existing' AND model_id = 'fake-memory:fake-embed-model'",
                    [],
                    |row| row.get(0),
                )
                .map_err(|e| e.to_string())
            })
            .unwrap();
        assert_eq!(
            new_hash,
            chunking::content_hash("Lives in Lisbon, Portugal")
        );
        assert_ne!(
            new_hash, old_hash,
            "embedding hash must change after update"
        );

        // Source link for the update's contributing source was appended.
        let sources = state
            .with_conn(|conn| {
                memory::list_sources_for_memory(&conn, "mem_existing").map_err(|e| e.to_string())
            })
            .unwrap();
        assert_eq!(
            sources.len(),
            2,
            "both the seed source and the new e1 source"
        );
        assert!(sources.iter().any(|s| s.source_id == "e1"));
    }

    // (d) delete-op tombstones the item.
    #[tokio::test]
    async fn delete_op_tombstones_item() {
        let state = make_state();
        seed_entry(&state, "j1", "e1", false);
        seed_job(&state, "journal_entry", "e1");

        state
            .with_conn(|conn| {
                memory::insert_memory_item(&conn, "mem_doomed", "stale fact", "journal_entry", 100)
                    .map_err(|e| e.to_string())?;
                memory::upsert_memory_embedding(
                    &conn,
                    "mem_doomed",
                    "fake-memory:fake-embed-model",
                    4,
                    &[0.1, 0.2, 0.3, 0.4],
                    "h",
                    110,
                )
                .map_err(|e| e.to_string())?;
                Ok(())
            })
            .unwrap();

        let chat = r#"{"ops":[{"op":"delete","id":"mem_doomed"}]}"#;
        let counts = Arc::new(CallCounts::default());
        let registry = registry_with_memory(counts.clone(), chat);

        extract_memories_for_source(&state, &registry, "journal_entry", "e1", 1000)
            .await
            .expect("extraction completes");

        // list_memory_items filters is_deleted=0 → now empty.
        let items = state
            .with_conn(|conn| memory::list_memory_items(&conn).map_err(|e| e.to_string()))
            .unwrap();
        assert!(items.is_empty(), "tombstoned item excluded from list");

        // The row still exists with is_deleted=1.
        let is_deleted: i64 = state
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT is_deleted FROM memory_items WHERE id = 'mem_doomed'",
                    [],
                    |row| row.get(0),
                )
                .map_err(|e| e.to_string())
            })
            .unwrap();
        assert_eq!(is_deleted, 1, "item tombstoned");

        // delete does NOT inline-embed; only the query embed + chat fire.
        assert_eq!(
            counts.embed.load(Ordering::SeqCst),
            0,
            "no inline embed for delete"
        );
        assert_eq!(counts.chat.load(Ordering::SeqCst), 1);
        assert_eq!(counts.embed_query.load(Ordering::SeqCst), 1);
    }

    // (e) malformed provider JSON fails the job, NO partial DB writes.
    #[tokio::test]
    async fn malformed_provider_json_fails_job_with_no_partial_writes() {
        let state = make_state();
        seed_entry(&state, "j1", "e1", false);
        seed_job(&state, "journal_entry", "e1");

        let counts = Arc::new(CallCounts::default());
        let registry = registry_with_memory(counts.clone(), "this is not json at all");

        let err = extract_memories_for_source(&state, &registry, "journal_entry", "e1", 1000)
            .await
            .expect_err("malformed output must propagate Err");
        assert!(err.contains("JSON") || err.to_lowercase().contains("json"));

        // Job marked error.
        assert_eq!(get_job_status(&state, "journal_entry", "e1"), "error");

        // No new memory_items rows.
        let items = state
            .with_conn(|conn| memory::list_memory_items(&conn).map_err(|e| e.to_string()))
            .unwrap();
        assert!(items.is_empty(), "no partial writes on parse failure");

        // The query embed + chat still fired (they happen BEFORE the parse),
        // but no inline item embed.
        assert_eq!(counts.embed_query.load(Ordering::SeqCst), 1);
        assert_eq!(counts.chat.load(Ordering::SeqCst), 1);
        assert_eq!(counts.embed.load(Ordering::SeqCst), 0);
    }

    // (f) either memory slot unconfigured → `is_user_memory_active` is false,
    // so the MASTER GATE exits: the job row is left byte-identical (NOT
    // skipped — re-enabling must re-process it), ZERO provider calls. These
    // two tests exercise the gate-level behaviour; the per-slot let-else
    // below the gate is a TOCTOU guard that is unreachable when a slot is
    // missing at call time.
    #[tokio::test]
    async fn either_memory_slot_unconfigured_leaves_job_pending_with_no_provider_calls() {
        let state = make_state();
        seed_entry(&state, "j1", "e1", false);
        seed_job(&state, "journal_entry", "e1");
        let job_before = get_job_row(&state, "journal_entry", "e1");
        assert_eq!(job_before.status, "pending");

        let counts = Arc::new(CallCounts::default());
        let registry = ProviderRegistry::default();
        // Only memory_generation set; memory_embedding slot left empty.
        registry.swap_memory_generation(Arc::new(CountingFakeProvider::new(
            Arc::clone(&counts),
            r#"{"ops":[]}"#,
        )));

        extract_memories_for_source(&state, &registry, "journal_entry", "e1", 1000)
            .await
            .expect("inactive gate is Ok");

        // The whole row is untouched — not just the status: no attempt bump,
        // no error, no timestamp write.
        assert_eq!(
            get_job_row(&state, "journal_entry", "e1"),
            job_before,
            "inactive gate must not write to the job row"
        );
        assert_eq!(counts.chat.load(Ordering::SeqCst), 0);
        assert_eq!(counts.embed.load(Ordering::SeqCst), 0);
        assert_eq!(counts.embed_query.load(Ordering::SeqCst), 0);
    }

    // (f') embed slot set but gen slot empty → same row-untouched behaviour.
    #[tokio::test]
    async fn memory_generation_slot_unconfigured_leaves_job_pending() {
        let state = make_state();
        seed_entry(&state, "j1", "e1", false);
        seed_job(&state, "journal_entry", "e1");
        let job_before = get_job_row(&state, "journal_entry", "e1");
        assert_eq!(job_before.status, "pending");

        let counts = Arc::new(CallCounts::default());
        let registry = ProviderRegistry::default();
        registry.swap_memory_embedding(Arc::new(CountingFakeProvider::new(
            counts.clone(),
            r#"{"ops":[]}"#,
        )));

        extract_memories_for_source(&state, &registry, "journal_entry", "e1", 1000)
            .await
            .expect("inactive gate is Ok");

        assert_eq!(
            get_job_row(&state, "journal_entry", "e1"),
            job_before,
            "inactive gate must not write to the job row"
        );
        assert_eq!(counts.chat.load(Ordering::SeqCst), 0);
        assert_eq!(counts.embed_query.load(Ordering::SeqCst), 0);
    }

    // daily_chat source: chat transcript is concatenated and extracted.
    #[tokio::test]
    async fn daily_chat_source_extracts_from_transcript() {
        let state = make_state();
        seed_chat_session(&state, "sess1");
        seed_job(&state, "daily_chat", "sess1");

        let chat = r#"{"ops":[{"op":"add","text":"Was promoted to senior engineer"}]}"#;
        let counts = Arc::new(CallCounts::default());
        let registry = registry_with_memory(counts.clone(), chat);

        extract_memories_for_source(&state, &registry, "daily_chat", "sess1", 1000)
            .await
            .expect("extraction completes");

        let items = state
            .with_conn(|conn| memory::list_memory_items(&conn).map_err(|e| e.to_string()))
            .unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].text, "Was promoted to senior engineer");
        assert_eq!(items[0].source_type, "daily_chat");

        let sources = state
            .with_conn(|conn| {
                memory::list_sources_for_memory(&conn, &items[0].id).map_err(|e| e.to_string())
            })
            .unwrap();
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].source_type, "daily_chat");
        assert_eq!(sources[0].source_id, "sess1");
        assert_eq!(get_job_status(&state, "daily_chat", "sess1"), "indexed");
    }

    // Unknown source_type propagates an error. Because the test calls the core
    // fn directly (not via the tick's claim step), the seeded row is never
    // flipped to in_progress — gather_source_text returns Err before any
    // skip/complete/fail path runs, so the row stays at its pre-call status
    // (pending, as seeded by seed_job).
    #[tokio::test]
    async fn unknown_source_type_errors() {
        let state = make_state();
        seed_job(&state, "bogus", "x");
        let counts = Arc::new(CallCounts::default());
        let registry = registry_with_memory(counts.clone(), r#"{"ops":[]}"#);

        let err = extract_memories_for_source(&state, &registry, "bogus", "x", 1000)
            .await
            .expect_err("unknown source_type must error");
        assert!(err.contains("unknown memory source_type"), "{err}");

        // The fn returns Err before reaching any skip/complete/fail path, so
        // the seeded row stays at its pre-call status (pending) — NOT
        // in_progress, NOT error.
        assert_eq!(
            get_job_status(&state, "bogus", "x"),
            "pending",
            "unknown source_type leaves the seeded row untouched"
        );
    }

    // update-op on a non-existent id is skipped (NOT a job failure).
    #[tokio::test]
    async fn update_op_on_missing_id_is_skipped_not_failed() {
        let state = make_state();
        seed_entry(&state, "j1", "e1", false);
        seed_job(&state, "journal_entry", "e1");

        let chat = r#"{"ops":[{"op":"update","id":"does_not_exist","text":"x"}]}"#;
        let counts = Arc::new(CallCounts::default());
        let registry = registry_with_memory(counts.clone(), chat);

        extract_memories_for_source(&state, &registry, "journal_entry", "e1", 1000)
            .await
            .expect("missing-id op is skipped, job still completes");

        assert_eq!(get_job_status(&state, "journal_entry", "e1"), "indexed");
        let items = state
            .with_conn(|conn| memory::list_memory_items(&conn).map_err(|e| e.to_string()))
            .unwrap();
        assert!(items.is_empty(), "no item written for a missing-id update");
        // No inline embed fired (existence check short-circuited the op).
        assert_eq!(counts.embed.load(Ordering::SeqCst), 0);
    }

    // build_extraction_user_message shape — load-bearing prompt invariant.
    #[test]
    fn build_extraction_user_message_has_two_sections_when_related_present() {
        let related = vec![
            memory::MemoryHit {
                memory_id: "m1".into(),
                text: "fact one".into(),
                score: 0.9,
            },
            memory::MemoryHit {
                memory_id: "m2".into(),
                text: "fact two".into(),
                score: 0.5,
            },
        ];
        let msg = build_extraction_user_message("the source text", &related);
        assert!(msg.contains("Source text:\nthe source text"));
        assert!(msg.contains("EXISTING related memories"));
        assert!(msg.contains("- m1 | fact one"));
        assert!(msg.contains("- m2 | fact two"));
    }

    #[test]
    fn build_extraction_user_message_omits_related_section_when_empty() {
        let msg = build_extraction_user_message("only source", &[]);
        assert!(msg.contains("Source text:\nonly source"));
        assert!(
            !msg.contains("EXISTING related memories"),
            "no related section when list is empty"
        );
    }

    // ── gather_source_text: Bug 2 regression — dedicated memory opt-in ──────

    /// Seed a journal + entry with independently-controllable entry-level AND
    /// journal-level lock/invisible flags, for exercising the effective-lock
    /// projection `get_entry` performs (journal flag OR'd into the entry's).
    fn seed_entry_with_flags(
        conn: &Connection,
        journal_id: &str,
        entry_id: &str,
        entry_locked: bool,
        entry_invisible: bool,
        journal_locked: bool,
        journal_invisible: bool,
    ) {
        conn.execute(
            "INSERT OR IGNORE INTO journals (id, name, created_at, updated_at, is_locked, is_invisible)
             VALUES (?1, 'J', 0, 0, ?2, ?3)",
            params![journal_id, journal_locked as i64, journal_invisible as i64],
        )
        .expect("seed journal");
        conn.execute(
            "INSERT INTO entries
                (id, journal_id, title, content_text, entry_date,
                 created_at, updated_at, is_locked, is_invisible)
             VALUES (?1, ?2, 'Title', 'Body content', 0, 0, 0, ?3, ?4)",
            params![
                entry_id,
                journal_id,
                entry_locked as i64,
                entry_invisible as i64
            ],
        )
        .expect("seed entry");
    }

    #[test]
    fn gather_source_text_locked_entry_without_opt_in_returns_none() {
        let conn = open_test_db();
        seed_entry_with_flags(&conn, "j1", "e1", true, false, false, false);
        let text = gather_source_text(&conn, "journal_entry", "e1").expect("gather ok");
        assert!(
            text.is_none(),
            "locked entry without opt-in must be skipped"
        );
    }

    #[test]
    fn gather_source_text_locked_entry_with_opt_in_returns_text() {
        let conn = open_test_db();
        seed_entry_with_flags(&conn, "j1", "e1", true, false, false, false);
        crate::db::set_setting(
            &conn,
            crate::ai::provider::settings_keys::MEMORY_INCLUDE_PROTECTED,
            "true",
        )
        .unwrap();
        let text = gather_source_text(&conn, "journal_entry", "e1").expect("gather ok");
        assert!(text.is_some(), "locked entry with opt-in must be gathered");
    }

    #[test]
    fn gather_source_text_invisible_entry_returns_none_regardless_of_opt_in() {
        let conn = open_test_db();
        seed_entry_with_flags(&conn, "j1", "e1", false, true, false, false);
        crate::db::set_setting(
            &conn,
            crate::ai::provider::settings_keys::MEMORY_INCLUDE_PROTECTED,
            "true",
        )
        .unwrap();
        let text = gather_source_text(&conn, "journal_entry", "e1").expect("gather ok");
        assert!(
            text.is_none(),
            "invisible entry must be excluded even with the opt-in ON"
        );
    }

    #[test]
    fn gather_source_text_journal_level_lock_behaves_like_entry_level_lock() {
        let conn = open_test_db();
        // Entry itself unlocked, but its JOURNAL is locked — `get_entry`
        // projects the effective (OR'd) lock, so this must behave exactly
        // like an entry-level lock.
        seed_entry_with_flags(&conn, "j1", "e1", false, false, true, false);
        let text = gather_source_text(&conn, "journal_entry", "e1").expect("gather ok");
        assert!(
            text.is_none(),
            "journal-level lock without opt-in must be skipped, same as entry-level"
        );

        crate::db::set_setting(
            &conn,
            crate::ai::provider::settings_keys::MEMORY_INCLUDE_PROTECTED,
            "true",
        )
        .unwrap();
        let text = gather_source_text(&conn, "journal_entry", "e1").expect("gather ok");
        assert!(
            text.is_some(),
            "journal-level lock with opt-in must be gathered, same as entry-level"
        );
    }

    // ── gather_source_text: Bug 1 regression — daily_chat is user-only ──────

    /// Seed a chat session with exactly one user message and one assistant
    /// message, both with caller-supplied text.
    fn seed_chat_session_with_texts(
        conn: &Connection,
        session_id: &str,
        user_text: &str,
        assistant_text: &str,
    ) {
        conn.execute(
            "INSERT INTO chat_sessions
                (id, title, persona, persona_prompt_snapshot, language,
                 created_at, updated_at)
             VALUES (?1, NULL, 'empathetic', '', 'en', 0, 0)",
            params![session_id],
        )
        .expect("seed session");
        conn.execute(
            "INSERT INTO chat_messages
                (id, session_id, role, content, seq, created_at)
             VALUES ('m1', ?1, 'user', ?2, 0, 0)",
            params![session_id, user_text],
        )
        .expect("seed user msg");
        conn.execute(
            "INSERT INTO chat_messages
                (id, session_id, role, content, seq, created_at)
             VALUES ('m2', ?1, 'assistant', ?2, 1, 1)",
            params![session_id, assistant_text],
        )
        .expect("seed assistant msg");
    }

    #[test]
    fn gather_source_text_daily_chat_excludes_assistant_messages() {
        let conn = open_test_db();
        seed_chat_session_with_texts(
            &conn,
            "sess1",
            "I got promoted to senior engineer.", // fact A — the user's own words
            "You must be a time traveler from the future.", // fact B — assistant-invented
        );
        let text = gather_source_text(&conn, "daily_chat", "sess1")
            .expect("gather ok")
            .expect("text present");
        assert!(
            text.contains("promoted to senior engineer"),
            "the user's own fact (A) must be present: {text}"
        );
        assert!(
            !text.contains("time traveler"),
            "the assistant's invented fact (B) must be excluded: {text}"
        );
    }

    #[test]
    fn gather_source_text_daily_chat_all_assistant_messages_returns_none() {
        let conn = open_test_db();
        conn.execute(
            "INSERT INTO chat_sessions
                (id, title, persona, persona_prompt_snapshot, language,
                 created_at, updated_at)
             VALUES ('sess1', NULL, 'empathetic', '', 'en', 0, 0)",
            [],
        )
        .expect("seed session");
        conn.execute(
            "INSERT INTO chat_messages
                (id, session_id, role, content, seq, created_at)
             VALUES ('m1', 'sess1', 'assistant', 'Only an assistant reply.', 0, 0)",
            [],
        )
        .expect("seed assistant msg");
        let text = gather_source_text(&conn, "daily_chat", "sess1").expect("gather ok");
        assert!(
            text.is_none(),
            "a session with no user messages has nothing to extract"
        );
    }

    // ── Scan pass (T3.3) ───────────────────────────────────────────────────

    /// Seed an entry with explicit lock + invisible flags + body. The existing
    /// `seed_entry` covers only the unlocked-visible default; this variant
    /// covers the scan-pass privacy-gate cases.
    fn seed_entry_full(
        state: &AppState,
        journal_id: &str,
        entry_id: &str,
        is_locked: bool,
        is_invisible: bool,
        title: &str,
        body: &str,
    ) {
        state
            .with_conn(|conn| {
                conn.execute(
                    "INSERT OR IGNORE INTO journals (id, name, created_at, updated_at)
                     VALUES (?1, 'J', 0, 0)",
                    params![journal_id],
                )
                .map_err(|e| e.to_string())?;
                conn.execute(
                    "INSERT INTO entries
                        (id, journal_id, title, content_text, entry_date,
                         created_at, updated_at, is_locked, is_invisible)
                     VALUES (?1, ?2, ?3, ?4, 0, 0, 0, ?5, ?6)",
                    params![
                        entry_id,
                        journal_id,
                        title,
                        body,
                        is_locked as i64,
                        is_invisible as i64,
                    ],
                )
                .map_err(|e| e.to_string())?;
                Ok(())
            })
            .unwrap();
    }

    /// Update an entry's content_text (simulating an edit) and bump updated_at
    /// so the candidate-list query re-surfaces it.
    fn edit_entry_content(state: &AppState, entry_id: &str, new_body: &str) {
        state
            .with_conn(|conn| {
                conn.execute(
                    "UPDATE entries SET content_text = ?2, updated_at = updated_at + 1
                     WHERE id = ?1",
                    params![entry_id, new_body],
                )
                .map_err(|e| e.to_string())
            })
            .unwrap();
    }

    fn count_memory_jobs(state: &AppState) -> i64 {
        state
            .with_conn(|conn| {
                conn.query_row("SELECT COUNT(*) FROM memory_jobs", [], |row| row.get(0))
                    .map_err(|e| e.to_string())
            })
            .unwrap()
    }

    fn get_job_row(state: &AppState, source_type: &str, source_id: &str) -> memory::MemoryJobRow {
        state
            .with_conn(|conn| {
                memory::get_memory_job(conn, source_type, source_id).map_err(|e| e.to_string())
            })
            .unwrap()
            .expect("job row present")
    }

    // (a) unchanged source → no churn: hash matches → row untouched, not counted.
    #[test]
    fn scan_unchanged_source_is_noop_no_new_pending() {
        let state = make_state();
        seed_entry_full(&state, "j1", "e1", false, false, "Title", "Body");
        let registry = registry_with_memory(Arc::new(CallCounts::default()), r#"{"ops":[]}"#);

        // First scan: new source → claimed as pending.
        let n1 = run_memory_scan(&state, &registry).expect("scan 1");
        assert_eq!(n1, 1, "first scan claims the new source");
        let after_first = get_job_row(&state, "journal_entry", "e1");
        assert_eq!(after_first.status, "pending");
        assert_eq!(
            after_first.content_hash,
            chunking::content_hash("Title\n\nBody")
        );

        // Second scan with NO content change → zero newly claimed, row untouched.
        let n2 = run_memory_scan(&state, &registry).expect("scan 2");
        assert_eq!(n2, 0, "unchanged source must not be re-counted");
        let after_second = get_job_row(&state, "journal_entry", "e1");
        assert_eq!(after_second.status, after_first.status);
        assert_eq!(after_second.content_hash, after_first.content_hash);
        assert_eq!(
            after_second.updated_at, after_first.updated_at,
            "updated_at untouched on no-op scan"
        );
    }

    // (b) changed content → re-claimed via hash diff.
    #[test]
    fn scan_changed_source_flips_to_pending_and_is_counted() {
        let state = make_state();
        seed_entry_full(&state, "j1", "e1", false, false, "Title", "Body");
        let registry = registry_with_memory(Arc::new(CallCounts::default()), r#"{"ops":[]}"#);

        // First scan: claimed.
        let n1 = run_memory_scan(&state, &registry).expect("scan 1");
        assert_eq!(n1, 1);
        // Simulate the worker completing it so the next change is observable
        // (a pending→pending transition is NOT re-counted by design).
        state
            .with_conn(|conn| {
                memory::complete_memory_job(conn, "journal_entry", "e1", 1000)
                    .map_err(|e| e.to_string())
            })
            .unwrap();
        assert_eq!(get_job_status(&state, "journal_entry", "e1"), "indexed");

        // Edit the entry's content → hash changes → scan re-claims.
        edit_entry_content(&state, "e1", "Body with new details");
        let n2 = run_memory_scan(&state, &registry).expect("scan 2");
        assert_eq!(n2, 1, "changed source re-claimed");

        let after = get_job_row(&state, "journal_entry", "e1");
        assert_eq!(after.status, "pending", "flipped back to pending");
        assert_eq!(
            after.content_hash,
            chunking::content_hash("Title\n\nBody with new details")
        );
    }

    // (c) invisible source → skipped, not counted.
    #[test]
    fn scan_invisible_source_marked_skipped_not_pending() {
        let state = make_state();
        seed_entry_full(&state, "j1", "e1", false, true, "Title", "Body");
        let registry = registry_with_memory(Arc::new(CallCounts::default()), r#"{"ops":[]}"#);

        let n = run_memory_scan(&state, &registry).expect("scan");
        assert_eq!(n, 0, "invisible source not counted as claimed");
        let job = get_job_row(&state, "journal_entry", "e1");
        assert_eq!(job.status, "skipped");
        assert_eq!(job.content_hash, "", "hash cleared on skip");
    }

    // (d) locked source without opt-in → skipped, not counted.
    #[test]
    fn scan_locked_source_without_opt_in_marked_skipped() {
        let state = make_state();
        seed_entry_full(&state, "j1", "e1", true, false, "Title", "Body");
        // ai_memory_include_protected NOT set → gate excludes locked entries.
        let registry = registry_with_memory(Arc::new(CallCounts::default()), r#"{"ops":[]}"#);

        let n = run_memory_scan(&state, &registry).expect("scan");
        assert_eq!(n, 0);
        assert_eq!(get_job_status(&state, "journal_entry", "e1"), "skipped");
    }

    // (e) locked source WITH opt-in → processed normally (pending).
    #[test]
    fn scan_locked_source_with_opt_in_is_claimed_as_pending() {
        let state = make_state();
        seed_entry_full(&state, "j1", "e1", true, false, "Title", "Body");
        state
            .with_conn(|conn| {
                crate::db::set_setting(
                    conn,
                    crate::ai::provider::settings_keys::MEMORY_INCLUDE_PROTECTED,
                    "true",
                )
                .map_err(|e| e.to_string())
            })
            .unwrap();
        let registry = registry_with_memory(Arc::new(CallCounts::default()), r#"{"ops":[]}"#);

        let n = run_memory_scan(&state, &registry).expect("scan");
        assert_eq!(n, 1, "locked-with-opt-in source is claimed");
        assert_eq!(get_job_status(&state, "journal_entry", "e1"), "pending");
    }

    // (f) feature disabled → Ok(0), zero DB writes to memory_jobs.
    #[test]
    fn scan_with_feature_disabled_returns_zero_and_writes_nothing() {
        let state = make_state();
        seed_entry_full(&state, "j1", "e1", false, false, "Title", "Body");
        seed_chat_session(&state, "sess1");
        // Empty registry — neither memory slot configured.
        let registry = ProviderRegistry::default();

        let n = run_memory_scan(&state, &registry).expect("scan");
        assert_eq!(n, 0);
        assert_eq!(
            count_memory_jobs(&state),
            0,
            "feature disabled → zero memory_jobs writes"
        );
    }

    // (g) daily_chat source → claimed as pending (covers the second source
    // type's gather path — no lock gate applies).
    #[test]
    fn scan_claims_daily_chat_source_as_pending() {
        let state = make_state();
        seed_chat_session(&state, "sess1");
        let registry = registry_with_memory(Arc::new(CallCounts::default()), r#"{"ops":[]}"#);

        let n = run_memory_scan(&state, &registry).expect("scan");
        assert_eq!(n, 1, "daily_chat candidate claimed");
        assert_eq!(get_job_status(&state, "daily_chat", "sess1"), "pending");
    }

    // (h) gated source that later becomes ungated → a subsequent scan flips
    // it to pending (the load-bearing reason upsert_memory_job_skipped
    // clears the hash).
    #[test]
    fn scan_locked_then_unlocked_source_is_reclaimed() {
        let state = make_state();
        seed_entry_full(&state, "j1", "e1", true, false, "Title", "Body");
        let registry = registry_with_memory(Arc::new(CallCounts::default()), r#"{"ops":[]}"#);

        // Locked → skipped.
        let n1 = run_memory_scan(&state, &registry).expect("scan 1");
        assert_eq!(n1, 0);
        assert_eq!(get_job_status(&state, "journal_entry", "e1"), "skipped");

        // Unlock the entry.
        state
            .with_conn(|conn| {
                conn.execute("UPDATE entries SET is_locked = 0 WHERE id = 'e1'", [])
                    .map_err(|e| e.to_string())
            })
            .unwrap();

        // Scan again — now ungated, hash differs from "" → pending.
        let n2 = run_memory_scan(&state, &registry).expect("scan 2");
        assert_eq!(n2, 1, "unlocked source reclaimed on next scan");
        let job = get_job_row(&state, "journal_entry", "e1");
        assert_eq!(job.status, "pending");
        assert_eq!(
            job.content_hash,
            chunking::content_hash("Title\n\nBody"),
            "real hash stored after re-claim"
        );
    }

    // ── Background worker loop (T3.4) ──────────────────────────────────────

    /// A provider whose `chat` always errors but `embed`/`embed_query` succeed
    /// — drives the extraction down the query-embed path and fails at the chat
    /// step, producing a clean `fail_job` for the backoff/pause tests.
    struct FailingChatProvider {
        counts: Arc<CallCounts>,
    }

    #[async_trait]
    impl AIProvider for FailingChatProvider {
        fn id(&self) -> &str {
            "fake-memory-fail"
        }
        fn display_name(&self) -> &str {
            "Failing Chat Provider"
        }
        fn embedding_model_id(&self) -> &str {
            "fake-embed-model"
        }
        fn chat_model_id(&self) -> &str {
            "fake-chat-model"
        }
        fn endpoint_host(&self) -> String {
            "localhost".to_string()
        }
        fn endpoint_class(&self) -> EndpointClass {
            EndpointClass::OnDevice
        }
        async fn embed(&self, _texts: &[&str]) -> Result<Vec<Vec<f32>>, AiError> {
            self.counts.embed.fetch_add(1, Ordering::SeqCst);
            Ok(vec![vec![0.1, 0.2, 0.3, 0.4]])
        }
        async fn embed_query(&self, _texts: &[&str]) -> Result<Vec<Vec<f32>>, AiError> {
            self.counts.embed_query.fetch_add(1, Ordering::SeqCst);
            Ok(vec![vec![0.1, 0.2, 0.3, 0.4]])
        }
        async fn chat(&self, _messages: &[Message], _opts: ChatOpts) -> Result<String, AiError> {
            self.counts.chat.fetch_add(1, Ordering::SeqCst);
            Err(AiError::ProviderError("stub chat failure".into()))
        }
        #[allow(unused_variables)]
        async fn generate_image(&self, prompt: &str, opts: ImageOpts) -> Result<Vec<u8>, AiError> {
            Err(AiError::ProviderUnsupported("no image gen".into()))
        }
    }

    /// Build a registry whose memory generation slot always fails chat and
    /// whose memory embed slot succeeds on embed/embed_query. Shares `counts`
    /// across both slots so tests can assert call totals.
    fn registry_with_failing_chat(counts: Arc<CallCounts>) -> ProviderRegistry {
        let registry = ProviderRegistry::default();
        registry.swap_memory_generation(Arc::new(FailingChatProvider {
            counts: counts.clone(),
        }));
        registry.swap_memory_embedding(Arc::new(FailingChatProvider { counts }));
        registry
    }

    /// Count `memory_embeddings` rows for `(memory_id, model_id)`.
    fn count_embeddings_for_model(state: &AppState, memory_id: &str, model_id: &str) -> i64 {
        state
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM memory_embeddings
                     WHERE memory_id = ?1 AND model_id = ?2",
                    params![memory_id, model_id],
                    |row| row.get(0),
                )
                .map_err(|e| e.to_string())
            })
            .unwrap()
    }

    /// Count total `memory_items` rows (including tombstoned) — used by the C1
    /// regression to assert no duplicate ids across a failed-then-retried
    /// extraction (the live `list_memory_items` filters `is_deleted = 0`, so it
    /// would hide a tombstoned duplicate).
    fn count_memory_item_rows_total(state: &AppState) -> i64 {
        state
            .with_conn(|conn| {
                conn.query_row("SELECT COUNT(*) FROM memory_items", [], |row| row.get(0))
                    .map_err(|e| e.to_string())
            })
            .unwrap()
    }

    // ── FailOnNthEmbedProvider (C1 regression) ──────────────────────────────
    //
    // A provider whose `embed` fails on the Nth call (1-based) and succeeds
    // otherwise. Drives the C1 scenario: a mid-batch inline-embed failure must
    // not leave duplicable partial state. `embed_query` and `chat` behave like
    // CountingFakeProvider (the failure is isolated to the inline `embed` path).

    struct FailOnNthEmbedProvider {
        counts: Arc<CallCounts>,
        chat_response: String,
        fail_on_embed: usize,
    }

    #[async_trait]
    impl AIProvider for FailOnNthEmbedProvider {
        fn id(&self) -> &str {
            "fake-memory-fail-nth"
        }
        fn display_name(&self) -> &str {
            "Fail Nth Embed Provider"
        }
        fn embedding_model_id(&self) -> &str {
            "fake-embed-model"
        }
        fn chat_model_id(&self) -> &str {
            "fake-chat-model"
        }
        fn endpoint_host(&self) -> String {
            "localhost".to_string()
        }
        fn endpoint_class(&self) -> EndpointClass {
            EndpointClass::OnDevice
        }
        async fn embed(&self, _texts: &[&str]) -> Result<Vec<Vec<f32>>, AiError> {
            let n = self.counts.embed.fetch_add(1, Ordering::SeqCst) + 1;
            if n == self.fail_on_embed {
                Err(AiError::ProviderError(format!("embed #{n} stub failure")))
            } else {
                Ok(vec![vec![0.1, 0.2, 0.3, 0.4]])
            }
        }
        async fn embed_query(&self, _texts: &[&str]) -> Result<Vec<Vec<f32>>, AiError> {
            self.counts.embed_query.fetch_add(1, Ordering::SeqCst);
            Ok(vec![vec![0.1, 0.2, 0.3, 0.4]])
        }
        async fn chat(&self, _messages: &[Message], _opts: ChatOpts) -> Result<String, AiError> {
            self.counts.chat.fetch_add(1, Ordering::SeqCst);
            Ok(self.chat_response.clone())
        }
        #[allow(unused_variables)]
        async fn generate_image(&self, prompt: &str, opts: ImageOpts) -> Result<Vec<u8>, AiError> {
            Err(AiError::ProviderUnsupported("no image gen".into()))
        }
    }

    /// Build a registry with both memory slots wired to a FailOnNthEmbedProvider
    /// that fails the `fail_on_embed`-th `embed` call. `chat_response` is the
    /// canned extraction JSON the provider returns from `chat`.
    fn registry_with_embed_fail_on_nth(
        counts: Arc<CallCounts>,
        chat_response: &str,
        fail_on_embed: usize,
    ) -> ProviderRegistry {
        let registry = ProviderRegistry::default();
        let make = || {
            Arc::new(FailOnNthEmbedProvider {
                counts: Arc::clone(&counts),
                chat_response: chat_response.to_string(),
                fail_on_embed,
            }) as Arc<dyn AIProvider>
        };
        // Separate provider instances per slot but sharing the same `counts` —
        // embed_query rides the embed slot, chat rides the gen slot, and `embed`
        // (inline item embed) rides the embed slot. Only the embed slot's
        // `embed` call count matters for the fail-on-Nth trigger.
        registry.swap_memory_generation(make());
        registry.swap_memory_embedding(make());
        registry
    }

    // ── QueryEmbedFaultProvider (I4 + I6) ───────────────────────────────────
    //
    // A provider whose `embed_query` faults on demand (returns Err for I4's
    // query-error path, or an empty vec for I6's empty-vec path). `embed`
    // (inline item embed) stays functional so the fault is isolated to the
    // related-query embed step. Drives the two fail_job branches in the
    // related-query embed path that were previously untested / skipped fail_job.

    #[derive(Clone, Copy)]
    enum QueryEmbedFault {
        Error,
        EmptyVec,
    }

    struct QueryEmbedFaultProvider {
        counts: Arc<CallCounts>,
        fault: QueryEmbedFault,
    }

    #[async_trait]
    impl AIProvider for QueryEmbedFaultProvider {
        fn id(&self) -> &str {
            "fake-memory-query-fault"
        }
        fn display_name(&self) -> &str {
            "Query Embed Fault Provider"
        }
        fn embedding_model_id(&self) -> &str {
            "fake-embed-model"
        }
        fn chat_model_id(&self) -> &str {
            "fake-chat-model"
        }
        fn endpoint_host(&self) -> String {
            "localhost".to_string()
        }
        fn endpoint_class(&self) -> EndpointClass {
            EndpointClass::OnDevice
        }
        async fn embed(&self, _texts: &[&str]) -> Result<Vec<Vec<f32>>, AiError> {
            self.counts.embed.fetch_add(1, Ordering::SeqCst);
            Ok(vec![vec![0.1, 0.2, 0.3, 0.4]])
        }
        async fn embed_query(&self, _texts: &[&str]) -> Result<Vec<Vec<f32>>, AiError> {
            self.counts.embed_query.fetch_add(1, Ordering::SeqCst);
            match self.fault {
                QueryEmbedFault::Error => Err(AiError::ProviderError("query embed failure".into())),
                QueryEmbedFault::EmptyVec => Ok(Vec::new()),
            }
        }
        async fn chat(&self, _messages: &[Message], _opts: ChatOpts) -> Result<String, AiError> {
            self.counts.chat.fetch_add(1, Ordering::SeqCst);
            // Not reached when embed_query faults first, but keep a sane
            // default so a non-faulting path would still parse.
            Ok(r#"{"ops":[]}"#.to_string())
        }
        #[allow(unused_variables)]
        async fn generate_image(&self, prompt: &str, opts: ImageOpts) -> Result<Vec<u8>, AiError> {
            Err(AiError::ProviderUnsupported("no image gen".into()))
        }
    }

    /// Build a registry with both memory slots wired to a QueryEmbedFaultProvider
    /// configured with `fault`. The related-query embed step (step 3 of
    /// extract_memories_for_source) rides the embed slot, so the fault fires
    /// before the chat call.
    fn registry_with_query_embed_fault(
        counts: Arc<CallCounts>,
        fault: QueryEmbedFault,
    ) -> ProviderRegistry {
        let registry = ProviderRegistry::default();
        let make = || {
            Arc::new(QueryEmbedFaultProvider {
                counts: Arc::clone(&counts),
                fault,
            }) as Arc<dyn AIProvider>
        };
        registry.swap_memory_generation(make());
        registry.swap_memory_embedding(make());
        registry
    }

    // (a) scan → claim → complete: a changed source reaches indexed, with the
    // extracted memory item + its embedding materialized.
    #[tokio::test]
    async fn tick_scan_claim_complete_flow() {
        let state = make_state();
        seed_entry(&state, "j1", "e1", false); // unlocked entry
        let chat = r#"{"ops":[{"op":"add","text":"Likes jasmine tea"}]}"#;
        let counts = Arc::new(CallCounts::default());
        let registry = registry_with_memory(counts.clone(), chat);

        run_memory_tick(&state, &registry, 1000)
            .await
            .expect("tick completes");

        // Job reached indexed.
        assert_eq!(get_job_status(&state, "journal_entry", "e1"), "indexed");

        // Memory item exists with the extracted text.
        let items = state
            .with_conn(|conn| memory::list_memory_items(conn).map_err(|e| e.to_string()))
            .unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].text, "Likes jasmine tea");

        // Embedding for the active model exists (inline embed from apply_ops).
        assert_eq!(
            count_embeddings_for_model(&state, &items[0].id, "fake-memory:fake-embed-model"),
            1
        );
    }

    // (b) backoff on provider error: fail_job runs (status=error, attempt_count
    // bumped, next_attempt_at per the 60s schedule) and the job is NOT
    // re-claimed before next_attempt_at.
    #[tokio::test]
    async fn tick_backoff_on_provider_error() {
        let state = make_state();
        seed_entry(&state, "j1", "e1", false);
        let counts = Arc::new(CallCounts::default());
        let registry = registry_with_failing_chat(counts.clone());

        let base = chrono::Utc::now().timestamp();
        run_memory_tick(&state, &registry, base)
            .await
            .expect("tick does not propagate extraction err");

        let job = get_job_row(&state, "journal_entry", "e1");
        assert_eq!(job.status, "error");
        assert_eq!(job.attempt_count, 1);
        assert!(job.last_error.as_deref().unwrap_or("").contains("chat"));
        // `now` is threaded from the tick through fail_job, so last_attempt_at
        // and next_attempt_at are both anchored to the SAME `now` — the delta
        // is exactly BACKOFF_SECONDS[0] (no real-time slack).
        let scheduled = job.next_attempt_at.expect("next_attempt_at set");
        let last = job.last_attempt_at.expect("last_attempt_at set");
        assert_eq!(
            scheduled - last,
            BACKOFF_SECONDS[0],
            "first backoff delta is exactly BACKOFF_SECONDS[0]"
        );
        // Absolute values are pinned to the tick's `now` too.
        assert_eq!(last, base);
        assert_eq!(scheduled, base + BACKOFF_SECONDS[0]);

        // Before next_attempt_at → not re-claimed, attempt_count unchanged.
        run_memory_tick(&state, &registry, scheduled - 1)
            .await
            .expect("tick");
        assert_eq!(
            get_job_row(&state, "journal_entry", "e1").attempt_count,
            1,
            "not re-claimed before next_attempt_at"
        );

        // At next_attempt_at → re-claimed and fails again → attempt_count 2.
        run_memory_tick(&state, &registry, scheduled)
            .await
            .expect("tick");
        assert_eq!(
            get_job_row(&state, "journal_entry", "e1").attempt_count,
            2,
            "re-claimed after backoff elapsed"
        );
    }

    // (c) pause after repeated failures: driving the attempt_count past the
    // threshold pauses the job, and a paused job is not re-claimed on
    // subsequent ticks.
    #[tokio::test]
    async fn tick_pauses_after_repeated_failures() {
        let state = make_state();
        seed_entry(&state, "j1", "e1", false);
        let counts = Arc::new(CallCounts::default());
        let registry = registry_with_failing_chat(counts.clone());

        // Drive failures across the threshold (PAUSE_AT_ATTEMPT_COUNT = 4).
        // `now` is threaded through fail_job, so advance it to the scheduled
        // next_attempt_at between ticks to make each retry eligible.
        let mut now = chrono::Utc::now().timestamp();
        for attempt in 1..=PAUSE_AT_ATTEMPT_COUNT {
            run_memory_tick(&state, &registry, now).await.expect("tick");
            let job = get_job_row(&state, "journal_entry", "e1");
            if attempt < PAUSE_AT_ATTEMPT_COUNT {
                assert_eq!(
                    job.status, "error",
                    "attempt {attempt} should be error, not paused"
                );
                // Advance past the backoff so the next tick re-claims.
                now = job.next_attempt_at.expect("scheduled retry") + 1;
            } else {
                assert_eq!(
                    job.status, "paused",
                    "attempt {attempt} (at threshold) should pause"
                );
            }
        }

        // A paused job is excluded from claim_due_memory_jobs and stays paused
        // even far in the future.
        run_memory_tick(&state, &registry, now + 100_000)
            .await
            .expect("tick");
        assert_eq!(
            get_job_status(&state, "journal_entry", "e1"),
            "paused",
            "paused job stays paused across ticks"
        );
    }

    // (d) backfill embeds a missing-model item and skips an item that already
    // has the active-model embedding.
    #[tokio::test]
    async fn tick_backfill_embeds_missing_model_item() {
        let state = make_state();
        let counts = Arc::new(CallCounts::default());
        let registry = registry_with_memory(counts.clone(), r#"{"ops":[]}"#);

        // Seed an enabled item with NO embedding at all.
        state
            .with_conn(|conn| {
                memory::insert_memory_item(
                    conn,
                    "mem_missing",
                    "Loves hiking",
                    "journal_entry",
                    100,
                )
                .map_err(|e| e.to_string())
            })
            .unwrap();

        run_memory_tick(&state, &registry, 1000)
            .await
            .expect("tick");

        assert_eq!(
            count_embeddings_for_model(&state, "mem_missing", "fake-memory:fake-embed-model"),
            1,
            "backfill embedded the missing item"
        );
        assert_eq!(
            counts.embed.load(Ordering::SeqCst),
            1,
            "one backfill embed call"
        );
    }

    // F13: hosted memory embed class + no privacy receipt must not backfill
    // missing vectors — zero embed calls, item stays without a vector.
    #[tokio::test]
    async fn tick_backfill_hosted_without_privacy_receipt_makes_zero_embed_calls() {
        let state = make_state();
        let counts = Arc::new(CallCounts::default());
        let registry =
            registry_with_memory_class(counts.clone(), r#"{"ops":[]}"#, EndpointClass::Remote);
        // No `ai_privacy_accepted_at` receipt seeded.

        state
            .with_conn(|conn| {
                memory::insert_memory_item(
                    conn,
                    "mem_missing",
                    "Loves hiking",
                    "journal_entry",
                    100,
                )
                .map_err(|e| e.to_string())
            })
            .unwrap();

        run_memory_tick(&state, &registry, 1000)
            .await
            .expect("tick");

        assert_eq!(
            count_embeddings_for_model(&state, "mem_missing", "fake-memory:fake-embed-model"),
            0,
            "backfill must not embed without the privacy receipt"
        );
        assert_eq!(counts.embed.load(Ordering::SeqCst), 0, "zero embed calls");
    }

    #[tokio::test]
    async fn tick_backfill_re_embeds_item_with_foreign_model_vector() {
        let state = make_state();
        let counts = Arc::new(CallCounts::default());
        let registry = registry_with_memory(counts.clone(), r#"{"ops":[]}"#);

        let hash = chunking::content_hash("Loves hiking");
        state
            .with_conn(|conn| {
                memory::insert_memory_item(
                    conn,
                    "mem_foreign",
                    "Loves hiking",
                    "journal_entry",
                    100,
                )
                .map_err(|e| e.to_string())?;
                // Embedding exists but for a DIFFERENT model (peer-pull case).
                memory::upsert_memory_embedding(
                    conn,
                    "mem_foreign",
                    "other-model",
                    4,
                    &[0.5, 0.5, 0.5, 0.5],
                    &hash,
                    110,
                )
                .map_err(|e| e.to_string())?;
                Ok(())
            })
            .unwrap();

        run_memory_tick(&state, &registry, 1000)
            .await
            .expect("tick");

        assert_eq!(
            count_embeddings_for_model(&state, "mem_foreign", "fake-memory:fake-embed-model"),
            1,
            "backfill filled the active-model gap"
        );
        assert_eq!(counts.embed.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn tick_backfill_skips_item_already_embedded_for_active_model() {
        let state = make_state();
        let counts = Arc::new(CallCounts::default());
        let registry = registry_with_memory(counts.clone(), r#"{"ops":[]}"#);

        let hash = chunking::content_hash("Loves hiking");
        state
            .with_conn(|conn| {
                memory::insert_memory_item(conn, "mem_ok", "Loves hiking", "journal_entry", 100)
                    .map_err(|e| e.to_string())?;
                memory::upsert_memory_embedding(
                    conn,
                    "mem_ok",
                    "fake-memory:fake-embed-model",
                    4,
                    &[0.1, 0.2, 0.3, 0.4],
                    &hash,
                    110,
                )
                .map_err(|e| e.to_string())?;
                Ok(())
            })
            .unwrap();

        run_memory_tick(&state, &registry, 1000)
            .await
            .expect("tick");

        assert_eq!(
            counts.embed.load(Ordering::SeqCst),
            0,
            "no backfill embed for an already-embedded item"
        );
    }

    // (e) loop inert when either memory slot unconfigured: zero provider calls,
    // zero memory_jobs writes, zero backfill writes.
    #[tokio::test]
    async fn tick_inert_when_memory_disabled() {
        let state = make_state();
        seed_entry(&state, "j1", "e1", false);
        // Seed an item too, to confirm the backfill pass also stays inert.
        state
            .with_conn(|conn| {
                memory::insert_memory_item(conn, "mem1", "fact", "journal_entry", 100)
                    .map_err(|e| e.to_string())
            })
            .unwrap();

        let counts = Arc::new(CallCounts::default());
        let registry = ProviderRegistry::default(); // neither slot configured

        let jobs_before = count_memory_jobs(&state);
        run_memory_tick(&state, &registry, 1000)
            .await
            .expect("inert tick is Ok");

        assert_eq!(counts.chat.load(Ordering::SeqCst), 0, "no chat calls");
        assert_eq!(counts.embed.load(Ordering::SeqCst), 0, "no embed calls");
        assert_eq!(
            counts.embed_query.load(Ordering::SeqCst),
            0,
            "no embed_query calls"
        );
        assert_eq!(
            count_memory_jobs(&state),
            jobs_before,
            "zero memory_jobs writes"
        );
        assert_eq!(
            count_embeddings_for_model(&state, "mem1", "fake-memory:fake-embed-model"),
            0,
            "zero backfill writes"
        );
    }

    // Master-toggle round trip: a source that goes unprocessed while the
    // toggle is OFF must NOT be stranded — flipping it back ON re-processes
    // it on the next tick. This is the invariant the inactive gate's
    // leave-the-job-alone behaviour (vs the old mark-skipped semantics)
    // exists to protect.
    #[tokio::test]
    async fn tick_toggle_off_then_on_reprocesses_source_without_stranding() {
        let state = make_state();
        seed_entry(&state, "j1", "e1", false);
        seed_job(&state, "journal_entry", "e1");
        let chat = r#"{"ops":[{"op":"add","text":"Lives in Da Nang"}]}"#;
        let counts = Arc::new(CallCounts::default());
        let registry = registry_with_memory(counts.clone(), chat);

        // OFF — both slots configured, preference off: the tick is inert.
        set_user_memory_toggle(&state, false);
        let job_before = get_job_row(&state, "journal_entry", "e1");
        run_memory_tick(&state, &registry, 1000)
            .await
            .expect("inert tick is Ok");
        assert_eq!(
            get_job_row(&state, "journal_entry", "e1"),
            job_before,
            "toggle-off tick must not touch the job"
        );
        assert_eq!(counts.chat.load(Ordering::SeqCst), 0);

        // Direct extraction while OFF exits at the gate the same way — the
        // configured-slots variant of the unconfigured-slot tests above. The
        // job must NOT become `skipped`, or re-enabling would strand it.
        extract_memories_for_source(&state, &registry, "journal_entry", "e1", 1500)
            .await
            .expect("inactive gate is Ok");
        assert_eq!(
            get_job_row(&state, "journal_entry", "e1"),
            job_before,
            "toggle-off extraction must leave the job row untouched"
        );
        assert_eq!(counts.chat.load(Ordering::SeqCst), 0);

        // ON — the next tick claims and fully processes the source.
        set_user_memory_toggle(&state, true);
        run_memory_tick(&state, &registry, 2000)
            .await
            .expect("tick completes");
        assert_eq!(get_job_status(&state, "journal_entry", "e1"), "indexed");
        assert_eq!(counts.chat.load(Ordering::SeqCst), 1);
        let items = state
            .with_conn(|conn| memory::list_memory_items(conn).map_err(|e| e.to_string()))
            .unwrap();
        assert_eq!(items.len(), 1, "source re-processed after re-enable");
    }

    // ── Review-fix regression tests (Phase 3 /cf-review round 1) ───────────

    // C1 — a mid-batch inline-embed failure must not leave duplicable partial
    // state. apply_ops is best-effort on per-op embed failures (logged +
    // continued), so the job COMPLETES rather than failing; the item whose
    // embed failed is recovered by the same tick's backfill pass. A re-scan
    // with unchanged content does not re-claim an `indexed` job, so no
    // duplicate items appear on the next tick. (Previously: embed failure
    // failed the job → re-claim after backoff → second `Add` with a fresh
    // uuid → duplicate items.)
    #[tokio::test]
    async fn apply_ops_mid_batch_embed_failure_completes_without_duplicates() {
        let state = make_state();
        seed_entry(&state, "j1", "e1", false);
        // Two add ops; fail the FIRST inline item embed (call #2 — call #1 is
        // the related-query embed_query).
        let chat = r#"{"ops":[{"op":"add","text":"fact A"},{"op":"add","text":"fact B"}]}"#;
        let counts = Arc::new(CallCounts::default());
        let registry = registry_with_embed_fail_on_nth(counts.clone(), chat, 2);

        run_memory_tick(&state, &registry, 1000)
            .await
            .expect("tick completes (best-effort apply_ops)");

        // Job reached indexed despite the embed failure — NOT error.
        assert_eq!(
            get_job_status(&state, "journal_entry", "e1"),
            "indexed",
            "best-effort apply_ops completes the job even when an inline embed fails"
        );

        // Exactly one item per op (no duplicate from a re-claim), distinct ids.
        let items = state
            .with_conn(|conn| memory::list_memory_items(conn).map_err(|e| e.to_string()))
            .unwrap();
        assert_eq!(items.len(), 2, "one item per op, no duplicates");
        let mut ids: Vec<String> = items.iter().map(|i| i.id.clone()).collect();
        ids.sort();
        assert_ne!(ids[0], ids[1], "distinct item ids");
        // Both end up embedded — the failed one via the same tick's backfill.
        for it in &items {
            assert_eq!(
                count_embeddings_for_model(&state, &it.id, "fake-memory-fail-nth:fake-embed-model"),
                1,
                "item {} embedded (inline or backfill)",
                it.id
            );
        }

        // Second tick: content unchanged → indexed job is NOT re-claimed → no
        // duplicate items appear.
        run_memory_tick(&state, &registry, 2000)
            .await
            .expect("tick");
        assert_eq!(
            count_memory_item_rows_total(&state),
            2,
            "unchanged indexed source is not re-extracted"
        );
    }

    // C2 — the pause-guard's `status == "error"` condition. If
    // `extract_memories_for_source` returns Err WITHOUT transitioning the job
    // to `error` (e.g. a `complete_memory_job` DB-write failure, or — as here
    // — an `unknown source_type` that errors before any skip/complete/fail
    // path), the tick must NOT pause the job. Driven through the real claim
    // loop: claim_due_memory_jobs flips a due `pending` row to `in_progress`,
    // extraction errors, and should_pause evaluates false because the status is
    // still `in_progress`, not `error`. (A fault-injecting DB wrapper would be
    // the ideal driver for the complete-job-failure variant, but this exercises
    // the identical guard invariant without that scope.)
    #[tokio::test]
    async fn tick_does_not_pause_job_that_is_not_in_error_status() {
        let state = make_state();
        // A claimed-then-errored-without-fail_job job: seed pending with an
        // already-high attempt_count so the ONLY thing preventing a pause is
        // the status check.
        seed_job(&state, "bogus", "x");
        state
            .with_conn(|conn| {
                conn.execute(
                    "UPDATE memory_jobs SET status = 'pending', attempt_count = ?1",
                    params![PAUSE_AT_ATTEMPT_COUNT as i64],
                )
                .map_err(|e| e.to_string())
            })
            .unwrap();
        let counts = Arc::new(CallCounts::default());
        let registry = registry_with_memory(counts.clone(), r#"{"ops":[]}"#);

        run_memory_tick(&state, &registry, 1000)
            .await
            .expect("tick");

        // The bogus source was claimed (→ in_progress) and extraction errored
        // without fail_job; the guard must leave it in_progress, NOT paused.
        let job = get_job_row(&state, "bogus", "x");
        assert_eq!(
            job.status, "in_progress",
            "non-error job is never paused even at the pause threshold"
        );
        assert_ne!(job.status, "paused");
    }

    // I3 — the manual-extraction concurrency guard refuses a second trigger
    // while the worker is mid-extraction of the same source, and permits it
    // otherwise (no row yet, or status != in_progress).
    #[test]
    fn guard_manual_extraction_refuses_when_in_progress() {
        let state = make_state();

        // No row yet → permitted.
        assert!(
            guard_manual_extraction(&state, "journal_entry", "e1").is_ok(),
            "no job row → permitted"
        );

        // Pending → permitted.
        seed_job(&state, "journal_entry", "e1");
        assert!(
            guard_manual_extraction(&state, "journal_entry", "e1").is_ok(),
            "pending job → permitted"
        );

        // in_progress → refused.
        state
            .with_conn(|conn| {
                conn.execute(
                    "UPDATE memory_jobs SET status = 'in_progress' WHERE source_type = 'journal_entry' AND source_id = 'e1'",
                    [],
                )
                .map_err(|e| e.to_string())
            })
            .unwrap();
        let err = guard_manual_extraction(&state, "journal_entry", "e1")
            .expect_err("in_progress job must be refused");
        assert!(
            err.contains("already in progress"),
            "refusal message explains the conflict: {err}"
        );
    }

    // I4 — a related-query embed provider error fails the job (status=error,
    // attempt_count bumped) and never reaches the chat call. Before the fix
    // this branch propagated Err without fail_job, leaving the job perpetually
    // in_progress and never reaching the pause threshold.
    #[tokio::test]
    async fn embed_query_error_fails_job_without_reaching_chat() {
        let state = make_state();
        seed_entry(&state, "j1", "e1", false);
        seed_job(&state, "journal_entry", "e1");
        let counts = Arc::new(CallCounts::default());
        let registry = registry_with_query_embed_fault(counts.clone(), QueryEmbedFault::Error);

        let err = extract_memories_for_source(&state, &registry, "journal_entry", "e1", 1000)
            .await
            .expect_err("query-embed error must surface");
        assert!(err.contains("embed"), "{err}");

        let job = get_job_row(&state, "journal_entry", "e1");
        assert_eq!(job.status, "error", "fail_job ran");
        assert_eq!(job.attempt_count, 1, "attempt counter advanced");
        assert_eq!(
            counts.chat.load(Ordering::SeqCst),
            0,
            "chat never reached when embed_query fails first"
        );
    }

    // I6 — the empty-vec branch of the related-query embed path also fails the
    // job (previously an untested fail_job transition).
    #[tokio::test]
    async fn embed_query_empty_vec_fails_job() {
        let state = make_state();
        seed_entry(&state, "j1", "e1", false);
        seed_job(&state, "journal_entry", "e1");
        let counts = Arc::new(CallCounts::default());
        let registry = registry_with_query_embed_fault(counts.clone(), QueryEmbedFault::EmptyVec);

        let err = extract_memories_for_source(&state, &registry, "journal_entry", "e1", 1000)
            .await
            .expect_err("empty query vec must surface");
        assert!(err.contains("no vector"), "{err}");

        let job = get_job_row(&state, "journal_entry", "e1");
        assert_eq!(job.status, "error", "empty-vec branch calls fail_job");
        assert_eq!(job.attempt_count, 1);
        assert_eq!(counts.chat.load(Ordering::SeqCst), 0);
    }

    // I7 — strand-recovery integration in the tick: a job left `in_progress`
    // by a mid-extraction crash is flipped back to `pending`, then re-claimed
    // and processed by the SAME tick. (The underlying DB fn is tested in
    // db/memory.rs; this proves the tick wires it into the claim→extract flow.)
    #[tokio::test]
    async fn tick_recovers_stranded_in_progress_job_and_re_claims_it() {
        let state = make_state();
        seed_entry(&state, "j1", "e1", false);
        // Run one tick to create + complete the job, then simulate a crash by
        // forcing the completed job back into in_progress with a real pending
        // extraction to perform.
        let chat = r#"{"ops":[{"op":"add","text":"Likes jasmine tea"}]}"#;
        let counts = Arc::new(CallCounts::default());
        let registry = registry_with_memory(counts.clone(), chat);

        run_memory_tick(&state, &registry, 1000)
            .await
            .expect("first tick");
        assert_eq!(get_job_status(&state, "journal_entry", "e1"), "indexed");

        // Simulate a crash mid-extraction: flip the job to in_progress and wipe
        // any extracted item so the re-claim has real work to do.
        state
            .with_conn(|conn| {
                conn.execute(
                    "UPDATE memory_jobs SET status = 'in_progress' WHERE source_type = 'journal_entry' AND source_id = 'e1'",
                    [],
                )
                .map_err(|e| e.to_string())?;
                conn.execute("DELETE FROM memory_items", [])
                    .map_err(|e| e.to_string())
            })
            .unwrap();
        assert_eq!(
            get_job_status(&state, "journal_entry", "e1"),
            "in_progress",
            "precondition: job stranded mid-extraction"
        );

        // Next tick: strand recovery flips in_progress → pending, the claim
        // step re-claims it, extraction runs, and the memory item appears.
        run_memory_tick(&state, &registry, 2000)
            .await
            .expect("recovery tick");

        assert_eq!(
            get_job_status(&state, "journal_entry", "e1"),
            "indexed",
            "stranded job recovered + re-extracted in one tick"
        );
        let items = state
            .with_conn(|conn| memory::list_memory_items(conn).map_err(|e| e.to_string()))
            .unwrap();
        assert_eq!(items.len(), 1, "re-claim re-ran extraction");
        assert_eq!(items[0].text, "Likes jasmine tea");
    }

    #[tokio::test]
    async fn persona_build_gate_off_makes_zero_provider_calls() {
        let state = make_state();
        let counts = Arc::new(CallCounts::default());
        let registry = ProviderRegistry::default();

        let result = build_persona_inner(&state, &registry, false, 100_000)
            .await
            .expect("disabled memory pair is an inert no-op");

        assert!(!result.style_ready);
        assert_eq!(counts.chat.load(Ordering::SeqCst), 0);
    }

    /// Persona is its own feature, not a sub-feature of User Memory: turning
    /// the master memory preference OFF must NOT stop an explicit persona
    /// rebuild. Only the two memory model slots are still required, since the
    /// build runs on the memory generation provider.
    #[tokio::test]
    async fn persona_build_runs_with_user_memory_master_toggle_off() {
        let state = make_state();
        set_user_memory_toggle(&state, false);
        let counts = Arc::new(CallCounts::default());
        // Local class — privacy is auto-exempt, so this isolates the toggle.
        let registry = registry_with_memory(
            counts.clone(),
            "TRAITS:\nCalm and direct.\nSTYLE:\nShort lines.",
        );
        // Authoritative material so the build has something to work from.
        state
            .with_conn(|conn| {
                persona::write_persona_answers(conn, r#"{"three_words":"calm, direct, warm"}"#)
                    .map_err(|e| e.to_string())
            })
            .unwrap();

        build_persona_inner(&state, &registry, false, 100_000)
            .await
            .expect("persona build must not depend on the memory master toggle");

        assert!(
            counts.chat.load(Ordering::SeqCst) > 0,
            "the memory generation provider should have been called",
        );
        let persona = state
            .with_conn(|conn| persona::read_persona(conn).map_err(|e| e.to_string()))
            .unwrap();
        assert!(
            !persona.traits_text.trim().is_empty(),
            "traits should have been generated with the master toggle off",
        );
    }

    /// The "include locked entries" opt-in is presented in Settings as a
    /// sub-setting of the User Memory group, and nothing resets it when that
    /// master toggle goes off. Now that a persona rebuild no longer requires
    /// the master toggle, the stale opt-in must NOT keep pulling locked-entry
    /// text into persona style samples — that text is synthesized into style
    /// prose which then rides the general (possibly hosted) generation prompt.
    #[test]
    fn locked_entries_are_excluded_from_persona_samples_when_user_memory_is_off() {
        let state = make_state();
        seed_entry(&state, "j1", "locked", true);
        state
            .with_conn(|conn| {
                db::set_setting(
                    conn,
                    crate::ai::provider::settings_keys::MEMORY_INCLUDE_PROTECTED,
                    "true",
                )
                .map_err(|e| e.to_string())
            })
            .unwrap();

        set_user_memory_toggle(&state, true);
        let with_memory_on = state
            .with_conn(|conn| collect_persona_entry_samples(conn))
            .unwrap();
        assert!(
            !with_memory_on.is_empty(),
            "opt-in should apply while User Memory is on",
        );

        set_user_memory_toggle(&state, false);
        let with_memory_off = state
            .with_conn(|conn| collect_persona_entry_samples(conn))
            .unwrap();
        assert!(
            with_memory_off.is_empty(),
            "a locked-entry opt-in scoped under User Memory must not outlive it",
        );
    }

    /// Defence in depth for the loosened `build_persona_inner` gate: the
    /// AUTOMATIC refresh path must stay blocked while User Memory is off. It
    /// has no gate of its own — it relies on `run_memory_tick` returning early
    /// — so a reorder or a second call site would silently reopen unattended
    /// entry/memory exfiltration. This test fails if that happens.
    #[tokio::test]
    async fn auto_persona_refresh_stays_blocked_while_user_memory_is_off() {
        let state = make_state();
        set_user_memory_toggle(&state, false);
        seed_entry(&state, "j1", "e1", false);
        let counts = Arc::new(CallCounts::default());
        let registry = registry_with_memory(counts.clone(), "TRAITS:\nX.\nSTYLE:\nY.");

        run_memory_tick(&state, &registry, 100_000)
            .await
            .expect("inert tick is Ok");

        assert_eq!(
            counts.chat.load(Ordering::SeqCst),
            0,
            "no automatic persona/extraction provider call while memory is off",
        );
    }

    // F13: hosted memory generation class + no privacy receipt must not
    // build a persona from raw journal/chat material — zero provider calls.
    #[tokio::test]
    async fn persona_build_hosted_without_privacy_receipt_makes_zero_provider_calls() {
        let state = make_state();
        let counts = Arc::new(CallCounts::default());
        let registry = registry_with_memory_class(
            counts.clone(),
            "TRAITS:\nInvented.\nSTYLE:\nInvented.",
            EndpointClass::Remote,
        );
        // No `ai_privacy_accepted_at` receipt seeded.

        let result = build_persona_inner(&state, &registry, false, 100_000)
            .await
            .expect("consent gap is a quiet no-op, not an error");

        assert!(!result.style_ready);
        assert_eq!(counts.chat.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn persona_build_with_no_authoritative_material_makes_zero_provider_calls() {
        let state = make_state();
        let counts = Arc::new(CallCounts::default());
        let registry =
            registry_with_memory(counts.clone(), "TRAITS:\nInvented.\nSTYLE:\nInvented.");

        let result = build_persona_inner(&state, &registry, false, 100_000)
            .await
            .expect("empty persona material is a quiet no-op");

        assert!(!result.style_ready);
        assert_eq!(counts.chat.load(Ordering::SeqCst), 0);
        let persona = state
            .with_conn(|conn| persona::read_persona(conn).map_err(|e| e.to_string()))
            .expect("read persona");
        assert!(persona.traits_text.is_empty());
        assert!(persona.style_text.is_empty());
    }

    #[test]
    fn persona_sampling_excludes_invisible_and_locked_without_opt_in() {
        let state = make_state();
        seed_entry_full(
            &state,
            "j1",
            "visible",
            false,
            false,
            "Visible",
            "safe sample",
        );
        seed_entry_full(
            &state,
            "j1",
            "locked",
            true,
            false,
            "Locked",
            "secret sample",
        );
        seed_entry_full(
            &state,
            "j1",
            "hidden",
            false,
            true,
            "Hidden",
            "hidden sample",
        );

        let samples = state
            .with_conn(collect_persona_entry_samples)
            .expect("sample collection");

        assert_eq!(samples.len(), 1);
        assert!(samples[0].contains("Visible"));
        assert!(samples[0].contains("safe sample"));
    }

    // I1 fix: persona sampling must gate on `ai_memory_include_protected`,
    // NOT `ai_embed_include_protected` — flipping the unrelated
    // entry-embedding backfill toggle must not start feeding locked-journal
    // text into the (possibly-hosted) persona-build prompt.
    #[test]
    fn persona_sampling_embed_include_protected_alone_does_not_unlock_locked_entries() {
        let state = make_state();
        seed_entry_full(
            &state,
            "j1",
            "locked",
            true,
            false,
            "Locked",
            "secret sample",
        );
        state
            .with_conn(|conn| {
                db::set_setting(
                    conn,
                    crate::ai::provider::settings_keys::EMBED_INCLUDE_PROTECTED,
                    "true",
                )
                .map_err(|e| e.to_string())
            })
            .unwrap();

        let samples = state
            .with_conn(collect_persona_entry_samples)
            .expect("sample collection");
        assert!(
            samples.is_empty(),
            "ai_embed_include_protected alone must not unlock the locked entry for persona sampling"
        );
    }

    #[test]
    fn persona_sampling_memory_include_protected_unlocks_locked_entries() {
        let state = make_state();
        seed_entry_full(
            &state,
            "j1",
            "locked",
            true,
            false,
            "Locked",
            "secret sample",
        );
        state
            .with_conn(|conn| {
                db::set_setting(
                    conn,
                    crate::ai::provider::settings_keys::MEMORY_INCLUDE_PROTECTED,
                    "true",
                )
                .map_err(|e| e.to_string())
            })
            .unwrap();

        let samples = state
            .with_conn(collect_persona_entry_samples)
            .expect("sample collection");
        assert_eq!(samples.len(), 1);
        assert!(samples[0].contains("secret sample"));
    }

    #[tokio::test]
    async fn persona_build_verbatim_style_aborts_without_database_write() {
        let state = make_state();
        let copied = "one two three four five six seven eight nine ten";
        for id in ["one", "two", "three"] {
            seed_entry_full(&state, "j1", id, false, false, "Title", copied);
        }
        let response = format!("TRAITS:\nPractical and reflective.\nSTYLE:\n{copied}");
        let counts = Arc::new(CallCounts::default());
        let registry = registry_with_memory(counts, &response);

        let error = build_persona_inner(&state, &registry, false, 100_000)
            .await
            .expect_err("copied style must abort");

        assert!(error.contains("copied too much"));
        let persona = state
            .with_conn(|conn| persona::read_persona(conn).map_err(|e| e.to_string()))
            .expect("read persona");
        assert!(persona.traits_text.is_empty());
    }

    #[tokio::test]
    async fn persona_user_edit_requires_force_for_manual_and_auto_builds() {
        let state = make_state();
        state
            .with_conn(|conn| {
                persona::write_persona_user_edit(conn, "custom", "voice")
                    .map_err(|e| e.to_string())?;
                memory::insert_memory_item(conn, "m1", "Likes tea", "journal_entry", 10)
                    .map_err(|e| e.to_string())
            })
            .expect("seed edited persona");
        let counts = Arc::new(CallCounts::default());
        let registry = registry_with_memory(
            counts.clone(),
            "TRAITS:\nThoughtful.\nSTYLE:\nConcise prose.",
        );

        let error = build_persona_inner(&state, &registry, false, 100_000)
            .await
            .expect_err("manual rebuild requires explicit force");
        assert!(error.contains("explicit force"));
        maybe_auto_refresh_persona(&state, &registry, 100_000)
            .await
            .expect("auto path skips user edit");
        assert_eq!(counts.chat.load(Ordering::SeqCst), 0);

        build_persona_inner(&state, &registry, true, 100_000)
            .await
            .expect("explicit force may replace user edits");
        let persona = state
            .with_conn(|conn| persona::read_persona(conn).map_err(|e| e.to_string()))
            .expect("read forced build");
        assert!(!persona.user_edited);
    }

    #[tokio::test]
    async fn persona_build_discards_provider_output_when_user_edits_while_it_waits() {
        let state = make_state();
        state
            .with_conn(|conn| {
                memory::insert_memory_item(conn, "m1", "Likes tea", "journal_entry", 10)
                    .map_err(|e| e.to_string())
            })
            .expect("seed traits material so synthesis actually starts");
        let started = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let registry = registry_with_blocking_persona(Arc::clone(&started), Arc::clone(&release));
        let build = build_persona_inner(&state, &registry, false, 100_000);
        tokio::pin!(build);

        tokio::select! {
            _ = started.notified() => {}
            result = &mut build => panic!("build completed before the provider was released: {result:?}"),
        }
        state
            .with_conn(|conn| {
                persona::write_persona_user_edit(conn, "user traits", "user style")
                    .map_err(|e| e.to_string())
            })
            .expect("concurrent user edit");
        release.notify_one();

        let error = (&mut build)
            .await
            .expect_err("stale generation must not overwrite the edit");
        assert!(error.contains("changed while rebuilding"));
        let row = state
            .with_conn(|conn| persona::read_persona(conn).map_err(|e| e.to_string()))
            .expect("read preserved persona");
        assert_eq!(row.traits_text, "user traits");
        assert_eq!(row.style_text, "user style");
        assert!(row.user_edited);
    }

    #[tokio::test]
    async fn persona_auto_refresh_observes_the_24_hour_cooldown() {
        let state = make_state();
        state
            .with_conn(|conn| {
                memory::insert_memory_item(conn, "m1", "Likes tea", "journal_entry", 101)
                    .map_err(|e| e.to_string())?;
                persona::write_persona_generated(conn, "old", "old", 100).map_err(|e| e.to_string())
            })
            .expect("seed stale persona");
        let counts = Arc::new(CallCounts::default());
        let registry = registry_with_memory(
            counts.clone(),
            "TRAITS:\nThoughtful.\nSTYLE:\nConcise prose.",
        );

        maybe_auto_refresh_persona(&state, &registry, 100 + PERSONA_REFRESH_COOLDOWN_SECS - 1)
            .await
            .expect("cooldown check");

        assert_eq!(counts.chat.load(Ordering::SeqCst), 0);
        let due_now = 100 + PERSONA_REFRESH_COOLDOWN_SECS;
        maybe_auto_refresh_persona(&state, &registry, due_now)
            .await
            .expect("refresh after cooldown");
        maybe_auto_refresh_persona(&state, &registry, due_now + 1)
            .await
            .expect("second tick stays in cooldown");
        assert_eq!(counts.chat.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn persona_answers_are_ungated_and_preserve_generated_sections() {
        let state = make_state();
        state
            .with_conn(|conn| {
                persona::write_persona_generated(conn, "steady", "warm", 100)
                    .map_err(|e| e.to_string())
            })
            .expect("seed generated persona");

        save_persona_answers(&state, r#"{"preferred_name":"Minh","voice_preference":""}"#)
            .expect("answers save without a provider registry");

        let row = state
            .with_conn(|conn| persona::read_persona(conn).map_err(|e| e.to_string()))
            .expect("read persona");
        assert_eq!(
            row.answers_json,
            r#"{"preferred_name":"Minh","voice_preference":""}"#
        );
        assert_eq!(row.traits_text, "steady");
        assert_eq!(row.style_text, "warm");
    }

    #[test]
    fn persona_answers_reject_an_over_cap_value_without_writing() {
        let state = make_state();
        let over_cap = format!(r#"{{"preferred_name":"{}"}}"#, "x".repeat(301));

        let error = save_persona_answers(&state, &over_cap).expect_err("over-cap answer rejected");

        assert!(error.contains("300"));
        let row = state
            .with_conn(|conn| persona::read_persona(conn).map_err(|e| e.to_string()))
            .expect("read untouched persona");
        assert!(row.answers_json.is_empty());
    }

    #[test]
    fn persona_answers_reject_unknown_or_overall_unbounded_payloads_without_writing() {
        let state = make_state();
        let unknown = r#"{"preferred_name":"Minh","ipc_extra":"not a questionnaire answer"}"#;

        let unknown_error =
            save_persona_answers(&state, unknown).expect_err("unknown key rejected");
        assert!(unknown_error.contains("not a valid interview question"));

        let full_answers = serde_json::json!({
            "preferred_name": "x".repeat(300),
            "journal_goal": "x".repeat(300),
            "voice_preference": "x".repeat(300),
            "languages": "x".repeat(300),
            "three_words": "x".repeat(300),
            "life_priorities": "x".repeat(300),
            "avoid_topics": "x".repeat(300),
            "length_preference": "x".repeat(300),
        });
        let too_large = format!(r#"{{"preferred_name":"{}"}}"#, "é".repeat(5_000));
        let payload_error =
            save_persona_answers(&state, &too_large).expect_err("oversized JSON rejected");
        assert!(payload_error.contains("payload"));
        assert!(full_answers.to_string().len() < PERSONA_ANSWERS_JSON_MAX_BYTES);
        assert_eq!(
            full_answers
                .as_object()
                .expect("object")
                .values()
                .map(|value| value.as_str().expect("string").chars().count())
                .sum::<usize>(),
            PERSONA_ANSWERS_MAX_CHARS
        );
        let row = state
            .with_conn(|conn| persona::read_persona(conn).map_err(|e| e.to_string()))
            .expect("read untouched persona");
        assert!(row.answers_json.is_empty());
    }
}
